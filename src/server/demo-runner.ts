import type { CheckResult, Finding, Run, RunEvent, RunState } from "../shared/types.js";
import type { RunStore } from "./store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const demoDiff = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 342bc9a..3d193e1 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -41,7 +41,13 @@ export async function refreshSession(token: string) {
-  return client.refresh(token);
+  const existing = refreshLocks.get(token);
+  if (existing) return existing;
+
+  const request = client.refresh(token).finally(() => refreshLocks.delete(token));
+  refreshLocks.set(token, request);
+  return request;
 }
diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/session.test.ts
@@ -0,0 +1,8 @@
+it("deduplicates concurrent refresh requests", async () => {
+  await Promise.all([refreshSession("token"), refreshSession("token")]);
+  expect(client.refresh).toHaveBeenCalledTimes(1);
+});`;

const initialChecks: CheckResult[] = [
  { id: "lint", name: "Lint", command: "npm run lint", status: "pending" },
  { id: "types", name: "TypeScript", command: "npm run typecheck", status: "pending" },
  { id: "tests", name: "Unit tests", command: "npm test", status: "pending" },
];

const finding: Finding = {
  id: "review-1-race-cleanup",
  severity: "high",
  file: "src/auth/session.ts",
  line: 46,
  title: "失败请求可能污染并发锁",
  evidence: "refresh promise 被缓存，但第一版实现没有在 rejected path 中清理锁。",
  requiredChange: "使用 finally 清理 refreshLocks，并增加失败后可重试的测试。",
  resolved: false,
};

export function baseDemoRun(input: { title: string; task: string; repository: string }): Run {
  const now = new Date().toISOString();
  return {
    id: `run_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    title: input.title,
    task: input.task,
    repository: input.repository || "demo/auth-service",
    branch: `ai-run/${Date.now().toString(36)}`,
    mode: "demo",
    state: "queued",
    round: 1,
    maxRounds: 3,
    createdAt: now,
    updatedAt: now,
    developer: { provider: "deepseek", model: process.env.PI_DEVELOPER_MODEL || "deepseek-flash" },
    reviewer: { provider: "openai-proxy", model: process.env.PI_REVIEWER_MODEL || "gpt-5.6-sol" },
    checks: structuredClone(initialChecks),
    findings: [],
    diff: "",
    summary: "等待执行",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
  };
}

export async function runDemo(store: RunStore, runId: string) {
  const startedAt = Date.now();
  const emit = async (
    state: RunState,
    source: RunEvent["source"],
    type: string,
    message: string,
    patch: Partial<Run> = {},
  ) => {
    const current = store.getRun(runId);
    if (!current || current.state === "cancelled") throw new Error("cancelled");
    await store.updateRun(runId, { state, durationMs: Date.now() - startedAt, ...patch });
    await store.appendEvent({
      runId,
      round: patch.round ?? current.round,
      source,
      type,
      message,
      at: new Date().toISOString(),
    });
    await sleep(850);
  };

  try {
    await emit("preparing", "system", "workspace.created", "已创建隔离 Git worktree，锁定基线提交 8fd2a91");
    await emit("developing", "developer", "agent.started", "DeepSeek 正在分析认证模块与并发刷新路径");
    await emit("developing", "developer", "tool.read", "读取 src/auth/session.ts、调用方与现有测试");
    await emit("developing", "developer", "tool.edit", "加入 refresh request 去重，并补充并发测试", {
      diff: demoDiff,
      summary: "实现 token 刷新去重，新增并发回归测试",
      usage: { inputTokens: 18_420, outputTokens: 3_180, estimatedCost: 0.036 },
    });

    const runningChecks = initialChecks.map((check) => ({ ...check, status: "running" as const }));
    await emit("checking", "checks", "checks.started", "开始执行 lint、类型检查和单元测试", {
      checks: runningChecks,
    });
    const passedChecks = initialChecks.map((check, index) => ({
      ...check,
      status: "passed" as const,
      durationMs: [1280, 2140, 3820][index],
      output: index === 2 ? "42 tests passed" : "0 errors",
    }));
    await emit("reviewing", "checks", "checks.passed", "3 项确定性检查全部通过", { checks: passedChecks });
    await emit("reviewing", "reviewer", "review.started", "OpenAI 审核 Agent 正在检查需求覆盖、边界条件和测试质量");
    await emit("developing", "reviewer", "review.changes_requested", "审核发现 1 个高优先级问题，已退回 DeepSeek", {
      findings: [finding],
      summary: "第一轮审核：需要修复 rejected promise 的锁清理路径",
    });

    await emit("developing", "developer", "agent.repair_started", "DeepSeek 收到结构化审核意见，开始第二轮修复", { round: 2 });
    await emit("developing", "developer", "tool.edit", "使用 finally 清理锁，并新增失败后重试测试", {
      round: 2,
      findings: [{ ...finding, resolved: true }],
      usage: { inputTokens: 27_860, outputTokens: 4_910, estimatedCost: 0.058 },
    });
    await emit("checking", "checks", "checks.started", "第二轮检查运行中", {
      round: 2,
      checks: runningChecks,
    });
    await emit("reviewing", "checks", "checks.passed", "第二轮检查全部通过：44 tests passed", {
      round: 2,
      checks: passedChecks.map((check) =>
        check.id === "tests" ? { ...check, output: "44 tests passed" } : check,
      ),
    });
    await emit("reviewing", "reviewer", "review.started", "OpenAI 正在执行独立复审", { round: 2 });
    await emit("completed", "reviewer", "review.approved", "复审通过，等待人工合并", {
      round: 2,
      summary: "并发刷新竞态已修复；检查与独立复审均通过",
      usage: { inputTokens: 38_920, outputTokens: 6_240, estimatedCost: 0.091 },
    });
  } catch (error) {
    if ((error as Error).message !== "cancelled") {
      await store.updateRun(runId, { state: "failed", summary: "演示流程异常终止" });
    }
  }
}
