import { createHash } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { E2E_WORKSPACE_PATH, expect, test } from "./fixtures";

/**
 * Story 全链路（opt-in，手动执行）：从创建任务到部署交付。
 *
 * 这是一个**叙事化、端到端、可手动执行**的用例，供运维/开发在自己的部署上运行，
 * 用来找问题。它把一条完整的产品闭环按 story 的步骤编号推进，每一步都严格断言，
 * 失败时打印足够诊断信息：
 *
 *   Step 0  前置体检（健康 / 身份 / realRunsAvailable / 决策平面 / 受控工作区 / 双角色模型）
 *   Step 1  story 场景：在受控工作区创建极小且确定性的真实任务（交付物 + 一条 grep 检查）
 *   Step 2  开发与检查：轮询到终态；review.started、/rounds verdict、checks 与状态一致
 *   Step 3  交付物证据：run.diff 非空且与本轮意图一致；diff 制品存在、下载 body 与
 *           run.diff 逐字节一致、sha256/bytes 与制品记录一致
 *   Step 4  人工闸门（关键，必须在合并前断言）：**没有自动合并**——run.merge 缺失、
 *           无 run.merged 事件、默认分支 HEAD 未变且工作区不 dirty
 *   Step 5  管理员合并：POST /merge → 200 + 合并记录 + run.merged 事件 +
 *           默认分支 HEAD **前移且等于 merge.commit**（守住 E2E-01b 记录的「无声 no-op」坑）
 *   Step 6  决策平面见证：有 review_triage 决策行 → 断言脱敏投影完整 + 事件成对 + 无密钥/
 *           外发 payload + 成本缺失为未知而非 0；无决策证据 → 如实标注，并与引擎状态自洽
 *           （引擎为 shadow/assist/enforce 且本轮确实有 finding 时，缺证据即 FAIL）
 *   Step 7  显式发布（部署交付）：POST /publish；钩子未配置 → 409 + 明确 code + 不写
 *           release 记录；已配置 → run.release.status ∈ succeeded|triggered|failed、
 *           commit === merge.commit、run.release_started + 匹配终态事件
 *   Step 8  交付结果核验：GET /api/deployments 可达（有本次 release 记录则断言可查到）；
 *           工作区默认分支 HEAD 仍等于 merge.commit 且不 dirty
 *   Step 9  总结报告：打印一张表并输出 STORY_DELIVERY_OK
 *
 * ---------------------------------------------------------------------------
 * 为什么不参与验收门禁（npm run gate:acceptance）
 * ---------------------------------------------------------------------------
 * 它是一个**真实闭环**，会真的花 provider token 与时间（一次完整开发 + 独立审核 +
 * 人工合并 + 显式发布）。验收门会收集 tests/e2e/*.spec.ts 下的全部 spec，因此本用例
 * 设了**双开关**：只有 PI_E2E_LIVE=1 **且** PI_E2E_STORY=1 时才真正执行，否则
 * test.skip(true, …) 并以可操作的原因说明如何开启。它在
 * scripts/e2e-suite-result.mjs 的 REQUIRED_E2E_SCENARIOS 里**没有**条目，所以被跳过
 * 不会让门禁把它判成「必需场景被跳过」；门禁对「必需场景」的门控行为完全不变。
 *
 * ---------------------------------------------------------------------------
 * 它照抄了既有实现（不改动任何既有 spec）
 * ---------------------------------------------------------------------------
 * - 闭环与人工闸门机制照抄 tests/e2e/acceptance.spec.ts 的 E2E-01b。
 * - 决策证据的投影/事件断言照抄 tests/e2e/decision-engine.spec.ts（同一仓库的既有
 *   端到端决策平面契约），保证「脱敏投影 + 事件成对」的判定与既有用例一字不差。
 * - 「任务禁止 agent 自行 commit/push、由产品提交本轮工作树改动」的原因与后果见 E2E-01b
 *   头注释（未提交改动会让 POST /merge 退化成 fast-forward 到基线的静默 no-op）。
 * - OTP 登录是生产专属：demo 部署用 development 身份头 x-pigo-dev-email；本用例不伪造
 *   OTP，只断言它实际拿到的身份（/api/me.isAdmin，人工合并/发布都是管理员专属）。
 *
 * 环境契约（完整说明见 tests/e2e/README.md）：
 *   PI_E2E_LIVE=1                 （必填）解锁 §13 真实场景的共享开关。
 *   PI_E2E_STORY=1                （必填）解锁本用例。
 *   PI_E2E_BASE_URL               （可选）目标服务，默认 http://127.0.0.1:3100。
 *   PI_E2E_DEV_EMAIL              （可选）dev 身份头，默认 developer@localhost。必须是管理员。
 *   PI_E2E_WORKSPACE_ID           （可选）指定已注册工作区；否则按下面的相对路径注册。
 *   PI_E2E_WORKSPACE_PATH         （可选）受控夹具在部署 projects 根目录下的相对路径；
 *                                 默认 fixture-small-auth。测试自行注册、结束时注销。
 *   PI_E2E_STORY_TIMEOUT_MS       （可选）等待运行到达终态的时长，默认 900000（15 分钟）。
 *   PI_E2E_STORY_SETTLE_MS        （可选）终态后等待决策证据落盘的时长，默认 60000。
 *   PI_E2E_STORY_ENVIRONMENT       （可选）发布环境名，默认 demo。
 *   PI_E2E_STORY_REVIEWER_PROVIDER（可选）优先为 reviewer 钉住的 provider。
 */

// ---------------------------------------------------------------------------
// 门控
// ---------------------------------------------------------------------------

const STORY_LIVE = process.env.PI_E2E_LIVE === "1";
const STORY_OPT_IN = process.env.PI_E2E_STORY === "1";

const STORY_SKIP_REASON = [
  "本用例是「Story 全链路：从创建任务到部署交付」的 opt-in 手动执行用例（真实闭环，会消耗 provider token 与时间），因此不参与验收门禁 npm run gate:acceptance。",
  "开启方式：必须同时设置 PI_E2E_LIVE=1 与 PI_E2E_STORY=1（两者缺一即跳过）。",
  `当前 PI_E2E_LIVE=${process.env.PI_E2E_LIVE ?? "(未设置)"}、PI_E2E_STORY=${process.env.PI_E2E_STORY ?? "(未设置)"}。`,
  "可直接复制的命令与前置条件见 tests/e2e/README.md「Story：从创建任务到部署交付（手动执行）」小节。",
].join(" ");

// ---------------------------------------------------------------------------
// 常量与类型（镜像既有 API 的最小形状，不新增产品字段）
// ---------------------------------------------------------------------------

/** 活跃态：worker 仍可能开始新的模型调用。 */
const ACTIVE_RUN_STATES = ["queued", "preparing", "developing", "checking", "reviewing"];

const DEFAULT_STORY_FIXTURE = "fixture-small-auth";
/** 本轮 story 的确定性交付物（仓库根目录下的一行文件）。 */
const STORY_DELIVERABLE = "pigo-story-e2e.txt";

/** docs/26 §15.3 的标准 fallbackReason（照抄 decision-engine.spec.ts）。 */
const FALLBACK_REASONS = [
  "disabled",
  "missing_credentials",
  "invalid_configuration",
  "payload_rejected",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "authentication_failed",
  "contract_invalid",
  "circuit_open",
  "aborted",
  "unknown",
] as const;

/** docs/26 §9.3 的四个固定问题后缀（版本化 policy；按契约字面量重复）。 */
const QUESTION_SUFFIXES = ["requirement_relevant", "security_impact", "human_urgency", "retry_value"] as const;

/** decision.* 事件 meta 的允许集合（照抄 decision-engine.spec.ts）。 */
const DECISION_EVENT_META_KEYS = new Set([
  "evaluationId",
  "kind",
  "mode",
  "requestedModel",
  "status",
  "fallbackReason",
  "resolvedModel",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "batchIndex",
  "batchCount",
]);

/** decision.requested 的 meta 只允许 id/kind/mode/model（+ 批次扇出字段）。 */
const DECISION_REQUESTED_KEYS = ["evaluationId", "kind", "mode", "requestedModel", "batchIndex", "batchCount"];

/** projectDecision（src/server/decision-routes.ts）投影允许出现的全部键。 */
const DECISION_PROJECTION_KEYS = new Set([
  "evaluationId",
  "runId",
  "kind",
  "mode",
  "provider",
  "requestedModel",
  "resolvedModel",
  "policyVersion",
  "stateHash",
  "questionSchemaHash",
  "status",
  "answers",
  "appliedOutcome",
  "fallbackReason",
  "detail",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "createdAt",
  "stateManifest",
]);

/** 投影里绝不允许出现的键（外发 payload / 凭据 / 原始状态）。 */
const FORBIDDEN_PROJECTION_KEYS = [
  "apiKey",
  "api_key",
  "authorization",
  "bearer",
  "password",
  "secret",
  "token",
  "credentials",
  "payload",
  "payloads",
  "request",
  "raw",
  "source",
  "state",
  "questions",
  "answer",
];

/** stateManifest 只允许的脱敏摘要键（照抄 decision-engine.spec.ts）。 */
const DECISION_MANIFEST_KEYS = [
  "fields",
  "counts",
  "fieldsTruncated",
  "stateBytes",
  "stateChars",
  "stateTokens",
  "questionCount",
  "questionIds",
  "questions",
];

/** 看着像凭据 / 外发 payload 的键或值（任何命中即 FAIL）。 */
const FORBIDDEN_TOKEN = /(api[_-]?key|authorization|bearer\s|sk-[a-z0-9]|password|secret|typesafe_api_key)/i;

type DecisionEngineStatus = {
  engine?: "disabled" | "mock" | "jev";
  mode?: "off" | "shadow" | "assist" | "enforce";
  configured?: boolean;
  policyVersion?: string | null;
  reason?: string;
};

type ConfigStatusBody = {
  demoMode?: boolean;
  realRunsAvailable?: boolean;
  releaseConfigured?: boolean;
  mergeRequestConfigured?: boolean;
  decisionEngine?: DecisionEngineStatus;
};

type AcceptanceRun = {
  id: string;
  title: string;
  state: string;
  workspaceId?: string;
  baseSha?: string;
  round?: number;
  maxRounds?: number;
  summary?: string;
  diff?: string;
  modelCalls?: number;
  lastSeq?: number;
  checks?: Array<{ id?: string; command: string; status: string; exitCode?: number; output?: string }>;
  developer?: { provider: string; model: string };
  reviewer?: { provider: string; model: string };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; estimatedCost?: number };
  usageRoles?: Array<{ role: string; provider: string; model: string; calls?: number }>;
  findings?: Array<{ id: string; severity: string; title?: string; resolved?: boolean }>;
  merge?: AcceptanceMergeRecord | null;
  release?: AcceptanceReleaseRecord | null;
};

type AcceptanceMergeRecord = {
  commit: string;
  strategy: "fast-forward" | "merge-commit";
  targetBranch: string;
  mergedAt: string;
  mergedBy: string;
};

type AcceptanceReleaseRecord = {
  deliveryId: string;
  status: "publishing" | "triggered" | "succeeded" | "failed";
  environment: string;
  commit: string;
  targetBranch: string;
  requestedBy: string;
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  kind: "webhook" | "command";
  detail?: string;
};

type AcceptanceWorkspace = {
  id: string;
  name: string;
  rootPath: string;
  status: string;
  defaultBranch: string | null;
  git: { branch: string | null; head: string | null; dirty: boolean } | null;
};

type AcceptanceEvent = {
  seq: number;
  runId?: string;
  round: number;
  source: string;
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
};

type AcceptanceArtifact = { runId?: string; artifactId: string; kind: string; bytes: number; sha256: string | null };

type DecisionAnswer = {
  questionId: string;
  type: "probability" | "choice" | "score";
  value: boolean | string;
  probability?: number;
  probabilities?: Record<string, number>;
  weightedScore?: number;
  confidence?: number;
  certainty?: number;
};

type DecisionProjection = {
  evaluationId: string;
  runId: string;
  kind: string;
  mode: string;
  provider: string;
  requestedModel: string;
  resolvedModel?: string;
  policyVersion: string;
  stateHash: string;
  questionSchemaHash: string;
  status: "completed" | "fallback" | "rejected" | "disabled";
  answers: DecisionAnswer[];
  appliedOutcome?: string;
  fallbackReason?: string;
  detail?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  createdAt: string;
  stateManifest: Record<string, unknown>;
};

type RoundSummaryBody = {
  rounds: Array<{
    round: number;
    verdict: "approved" | "changes_requested" | "none";
    checks: { passed: number; failed: number };
    findings: { total: number; resolved: number };
  }>;
};

type DeploymentStatus = {
  web?: { version: string | null };
  worker?: { version: string | null };
  rollbackTags?: string[];
  records?: Array<{ at: string | null; version: string | null; role: string | null; commit: string | null; status: string | null; note: string | null; raw: string }>;
  log?: { available: boolean; path: string; error?: string };
  at?: string;
};

// ---------------------------------------------------------------------------
// 共享 helper（按需从 acceptance.spec.ts / decision-engine.spec.ts 拷贝，未改原文件）
// ---------------------------------------------------------------------------

/** Trims and treats an empty value as unset, so `VAR=` cannot look configured. */
function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Formats an event log for failure diagnostics. */
function formatEvents(events: AcceptanceEvent[]): string {
  return events.map((event) => `#${event.seq} r${event.round} [${event.source}] ${event.type}: ${event.message}`).join("\n");
}

async function getRun(request: APIRequestContext, runId: string): Promise<AcceptanceRun> {
  const response = await request.get(`/api/runs/${runId}`);
  expect(response.ok(), `GET /api/runs/${runId} failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as AcceptanceRun;
}

/** 不分页读取整条事件流（limit 上限 1000，用 after 续读）。 */
async function getRunEvents(request: APIRequestContext, runId: string): Promise<AcceptanceEvent[]> {
  const all: AcceptanceEvent[] = [];
  let after = 0;
  for (let page = 0; page < 10; page += 1) {
    const response = await request.get(`/api/runs/${runId}/events?after=${after}&limit=1000`);
    expect(response.ok(), `GET /api/runs/${runId}/events failed with HTTP ${response.status()}`).toBeTruthy();
    const pageEvents = (await response.json()) as AcceptanceEvent[];
    all.push(...pageEvents);
    if (pageEvents.length < 1000) return all;
    after = pageEvents[pageEvents.length - 1].seq;
  }
  return all;
}

async function getRunRounds(request: APIRequestContext, runId: string): Promise<RoundSummaryBody> {
  const response = await request.get(`/api/runs/${runId}/rounds`);
  expect(response.ok(), `GET /api/runs/${runId}/rounds failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as RoundSummaryBody;
}

/** GET /api/runs/:id/artifacts（owner 作用域）。 */
async function getRunArtifacts(request: APIRequestContext, runId: string): Promise<AcceptanceArtifact[]> {
  const response = await request.get(`/api/runs/${runId}/artifacts`);
  expect(response.ok(), `GET /api/runs/${runId}/artifacts failed with HTTP ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { artifacts: AcceptanceArtifact[] }).artifacts ?? [];
}

/** GET /api/runs/:id/decisions（owner 作用域）。返回状态码与解析后的行。 */
async function getDecisions(
  request: APIRequestContext,
  runId: string,
): Promise<{ status: number; decisions: DecisionProjection[] }> {
  const response = await request.get(`/api/runs/${runId}/decisions`);
  if (!response.ok()) return { status: response.status(), decisions: [] };
  const body = (await response.json()) as { decisions?: DecisionProjection[] };
  return { status: response.status(), decisions: body.decisions ?? [] };
}

/**
 * POST /api/workspaces/:id/refresh 重新核验仓库并持久化 branch/head/dirty。
 * list/get 只回存储行，所以跨「合并边界」比较 HEAD 前必须先 refresh，否则断言会变得空洞。
 */
async function refreshWorkspace(request: APIRequestContext, workspaceId: string): Promise<AcceptanceWorkspace> {
  const response = await request.post(`/api/workspaces/${workspaceId}/refresh`);
  expect(
    response.ok(),
    `POST /api/workspaces/${workspaceId}/refresh 失败（HTTP ${response.status()}）：${(await response.text()).slice(0, 300)}`,
  ).toBeTruthy();
  return (await response.json()) as AcceptanceWorkspace;
}

/**
 * 取 /api/models 中 preflight 会接受的第一个可选模型（additive selectableRoles，
 * 否则 roles + available），从而不继承部署默认模型。与 acceptance.spec.ts 同契约。
 */
async function resolveRoleSelection(
  request: APIRequestContext,
  role: "developer" | "reviewer",
  preferredProvider?: string,
): Promise<{ provider: string; model: string } | undefined> {
  const response = await request.get("/api/models");
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    models?: Array<{ provider: string; model: string; roles?: string[]; available?: boolean; selectableRoles?: string[] }>;
  };
  const selectable = (body.models ?? []).filter((item) =>
    Array.isArray(item.selectableRoles)
      ? item.selectableRoles.includes(role)
      : Boolean(item.roles?.includes(role)) && item.available === true,
  );
  const entry =
    (preferredProvider ? selectable.find((item) => item.provider === preferredProvider) : undefined) ?? selectable[0];
  return entry ? { provider: entry.provider, model: entry.model } : undefined;
}

/** 仅取消仍在飞行的运行（best-effort，绝不覆盖已有终态）。 */
async function cancelIfActive(request: APIRequestContext, runId: string): Promise<void> {
  try {
    const run = await getRun(request, runId);
    if (ACTIVE_RUN_STATES.includes(run.state)) await request.post(`/api/runs/${runId}/cancel`);
  } catch {
    // 服务不可达或运行已终态；没有需要清理的东西。
  }
}

/**
 * Story 的受控任务：一个极小、确定性、可 grep 的交付物。
 *
 * 与 E2E-01b 同因：worker 会把本轮工作树改动**自己**提交到任务分支
 * （src/worker/round-commit.ts），而 POST /runs/:id/merge 只是把该分支
 * fast-forward 到默认分支。因此任务必须显式禁止 agent 自行 commit/push——否则若
 * agent 自己提交、或根本没提交，合并会退化为静默 no-op（merge.commit === baseSha，
 * HEAD 不变），Step 5 的「HEAD 前移」断言就是守住这条路径的护栏。
 */
function storyTask(marker: string): string {
  return [
    `这是端到端交付演练（story）。请在仓库根目录创建或覆盖文件 ${STORY_DELIVERABLE}，其内容必须恰好是一行：${marker}`,
    "除上述文件外，不得修改、新增或删除任何其它文件，不得新增依赖。",
    "不要自行提交或推送：不要执行 git commit / git push，也不要在任何分支上提交。产品会在本轮检查与审核之前把工作树改动提交到任务分支，人工合并交付的正是那个提交。",
  ].join("\n");
}

/**
 * 本轮唯一的验收条件：交付物存在且内容含本次运行的唯一标记，并且任务分支 HEAD
 * 已经离开基线（证明「产品提交了本轮工作树改动」，这是人工合并能真正前移 HEAD 的前提）。
 */
function storyChecks(baseCommit: string, marker: string): string[] {
  return [`grep -q '${marker}' ${STORY_DELIVERABLE} && [ "$(git rev-parse HEAD)" != "${baseCommit}" ]`];
}

/** diff 中每个改动段的文件路径。 */
function touchedPaths(diff: string): string[] {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => {
      const header = section.split("\n", 1)[0];
      const match = /\sb\/(.+)$/.exec(header);
      return match ? match[1] : header;
    });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("Story 全链路：从创建任务到部署交付（opt-in 手动执行，不参与验收门禁）", () => {
  test("STORY-01 story 全链路、opt-in：创建任务 → 开发/检查 → 独立审核 → 人工闸门 → 管理员合并 → 显式发布 → 交付核验（需 PI_E2E_LIVE=1 且 PI_E2E_STORY=1）", async ({ request }) => {
    test.skip(!(STORY_LIVE && STORY_OPT_IN), STORY_SKIP_REASON);

    const waitMs = (() => {
      const configured = Number(envValue("PI_E2E_STORY_TIMEOUT_MS") ?? 900_000);
      return Number.isFinite(configured) && configured > 0 ? configured : 900_000;
    })();
    const settleMs = (() => {
      const configured = Number(envValue("PI_E2E_STORY_SETTLE_MS") ?? 60_000);
      return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
    })();
    const environment = envValue("PI_E2E_STORY_ENVIRONMENT") ?? "demo";
    const preferredReviewerProvider = envValue("PI_E2E_STORY_REVIEWER_PROVIDER");
    const explicitWorkspaceId = envValue("PI_E2E_WORKSPACE_ID");
    const fixtureRelative = envValue("PI_E2E_STORY_WORKSPACE") ?? E2E_WORKSPACE_PATH ?? DEFAULT_STORY_FIXTURE;

    test.setTimeout(waitMs + 300_000);

    // 失败诊断：任何一步失败都要尽量把已收集的证据打印出来，绝不吞掉失败信息。
    const evidence: {
      step: string;
      runId?: string;
      workspaceId?: string;
      baselineHead?: string;
      run?: AcceptanceRun;
      events: AcceptanceEvent[];
      rounds?: RoundSummaryBody;
      artifacts: AcceptanceArtifact[];
      decisions: DecisionProjection[];
      notes: string[];
    } = { step: "Step 0 前置体检", events: [], artifacts: [], decisions: [], notes: [] };

    const step = (description: string) => {
      evidence.step = description;
      test.info().annotations.push({ type: "step", description });
      console.log(`\n=== ${description} ===`);
    };
    const note = (description: string) => {
      evidence.notes.push(description);
      test.info().annotations.push({ type: "note", description });
    };
    const dumpEvidence = () => {
      console.log(
        [
          "",
          "################ STORY 失败现场证据 ################",
          `失败步骤: ${evidence.step}`,
          `PI_E2E_BASE_URL: ${process.env.PI_E2E_BASE_URL ?? "(默认 http://127.0.0.1:3100)"}`,
          `管理员身份: ${process.env.PI_E2E_DEV_EMAIL ?? "(默认 developer@localhost)"}`,
          `runId: ${evidence.runId ?? "(未创建)"}`,
          `workspaceId: ${evidence.workspaceId ?? "(未解析)"}`,
          `baselineHead: ${evidence.baselineHead ?? "(未知)"}`,
          `run.state: ${evidence.run?.state ?? "(未读取)"} round=${String(evidence.run?.round)} summary=${evidence.run?.summary ?? ""}`,
          `run.merge: ${JSON.stringify(evidence.run?.merge ?? null)}`,
          `run.release: ${JSON.stringify(evidence.run?.release ?? null)}`,
          `事件类型: ${[...new Set(evidence.events.map((event) => event.type))].join(", ") || "(无)"}`,
          `rounds: ${JSON.stringify(evidence.rounds?.rounds ?? [])}`,
          `制品: ${evidence.artifacts.map((artifact) => `${artifact.artifactId}(${artifact.bytes}B sha256=${String(artifact.sha256).slice(0, 12)})`).join(", ") || "(无)"}`,
          `决策行: ${evidence.decisions.map((row) => `${row.kind}/${row.status}`).join(", ") || "(无)"}`,
          `备注: ${evidence.notes.join(" | ") || "(无)"}`,
          "事件日志:",
          formatEvents(evidence.events) || "(无事件)",
          "###################################################",
          "",
        ].join("\n"),
      );
    };

    let runId: string | undefined;
    let fixtureId: string | undefined;
    let registeredHere = false;

    try {
      // =====================================================================
      // Step 0 — 前置体检
      // =====================================================================
      step("Step 0 前置体检：健康 / 身份(含 isAdmin) / realRunsAvailable / 决策平面 / 受控工作区 / 双角色模型");

      const health = await request.get("/api/health");
      expect(
        health.ok(),
        `Step 0: GET /api/health 返回 HTTP ${health.status()}——目标服务不可用，请确认 PI_E2E_BASE_URL 指向一个在运行的 PiGO 部署（本机有代理时设 NO_PROXY）。`,
      ).toBeTruthy();

      const meResponse = await request.get("/api/me");
      expect(meResponse.ok(), `Step 0: GET /api/me 返回 HTTP ${meResponse.status()}`).toBeTruthy();
      const me = (await meResponse.json()) as { id: string; email: string; isAdmin?: boolean };
      test.skip(
        !me.isAdmin,
        `Step 0: 本用例需要**管理员**身份执行人工合并与显式发布：当前身份 ${me.email} 不是管理员（POST /api/runs/:id/merge 与 /publish 会返回 403 ADMIN_REQUIRED）。请通过 PI_E2E_DEV_EMAIL 指定部署中已授权的管理员身份。`,
      );

      const configResponse = await request.get("/api/config/status");
      expect(configResponse.ok(), `Step 0: GET /api/config/status 返回 HTTP ${configResponse.status()}`).toBeTruthy();
      const config = (await configResponse.json()) as ConfigStatusBody;
      test.skip(
        !config.realRunsAvailable,
        "Step 0: 需要真实运行环境：/api/config/status 报告 realRunsAvailable=false（需 PI_REAL_RUNS_ENABLED=true、PI_INTERNAL_TOKEN 以及至少一个已配置的 provider 凭据）。",
      );
      const engine = config.decisionEngine;
      note(
        `Step 0: decisionEngine=${JSON.stringify(engine ?? null)}，releaseConfigured=${String(config.releaseConfigured ?? "(未报告)")}，demoMode=${String(config.demoMode)}`,
      );

      // 受控工作区：显式 id 优先；否则按相对路径注册一个夹具（E2E-01b/E2E-08 的既有注册流程）。
      if (explicitWorkspaceId) {
        fixtureId = explicitWorkspaceId;
      } else {
        const listResponse = await request.get("/api/workspaces");
        expect(listResponse.ok(), `Step 0: GET /api/workspaces 返回 HTTP ${listResponse.status()}`).toBeTruthy();
        const registered =
          ((await listResponse.json()) as { workspaces?: Array<{ id: string; name: string; rootPath: string; status: string }> })
            .workspaces ?? [];
        const preexisting = registered.find(
          (workspace) => workspace.status === "active" && (workspace.rootPath === fixtureRelative || workspace.name === fixtureRelative),
        );
        if (preexisting) {
          fixtureId = preexisting.id;
        } else {
          const registration = await request.post("/api/workspaces/register", { data: { relativePath: fixtureRelative } });
          if (!registration.ok()) {
            test.skip(
              true,
              `Step 0: 受控夹具工作区未注册：POST /api/workspaces/register {relativePath:"${fixtureRelative}"} 返回 HTTP ${registration.status()}：${(await registration.text()).slice(0, 400)}。该夹具位于部署 projects 根目录之下（demo 宿主 /app/pi-agent/demo-workspace/projects/${fixtureRelative}、容器 /workspace/projects/${fixtureRelative}），重建步骤见 tests/e2e/README.md「E2E-01b 夹具与人工闸门（部署侧）」小节；也可用 PI_E2E_WORKSPACE_ID 指向一个已注册的受控工作区，或用 PI_E2E_WORKSPACE_PATH 指定别的相对路径。`,
            );
          }
          fixtureId = ((await registration.json()) as { id: string }).id;
          registeredHere = true;
        }
      }
      evidence.workspaceId = fixtureId;

      const baseline = await refreshWorkspace(request, fixtureId!);
      expect(
        baseline.git?.dirty,
        `Step 0: 工作区 ${fixtureId} 必须是干净仓库（否则 run preflight 直接 409 WORKSPACE_DIRTY）。当前 git=${JSON.stringify(baseline.git)}`,
      ).toBe(false);
      expect(
        baseline.git?.head,
        `Step 0: 工作区 ${fixtureId} 必须报告 git.head（人工合并前后的基准提交）：${JSON.stringify(baseline.git)}`,
      ).toBeTruthy();
      expect(
        baseline.defaultBranch,
        `Step 0: 工作区 ${fixtureId} 必须报告 defaultBranch（人工合并的目标分支）：${JSON.stringify(baseline)}`,
      ).toBeTruthy();
      const baselineHead = baseline.git!.head as string;
      evidence.baselineHead = baselineHead;

      const developer = await resolveRoleSelection(request, "developer");
      test.skip(
        !developer,
        "Step 0: 需要 /api/models 中至少一个可选用于 developer 的模型（selectableRoles）：没有它就无法显式钉住开发角色。",
      );
      const reviewer = await resolveRoleSelection(request, "reviewer", preferredReviewerProvider);
      test.skip(
        !reviewer,
        `Step 0: 需要 /api/models 中至少一个可选用于 reviewer 的模型（selectableRoles${preferredReviewerProvider ? `，已优先尝试 ${preferredReviewerProvider}` : ""}）：没有它就无法显式钉住审核角色。`,
      );
      note(
        `Step 0 通过：workspace=${fixtureId}（defaultBranch=${baseline.defaultBranch}，baselineHead=${baselineHead.slice(0, 12)}）；developer=${developer!.provider}/${developer!.model}，reviewer=${reviewer!.provider}/${reviewer!.model}；waitMs=${waitMs}，settleMs=${settleMs}，environment=${environment}`,
      );

      const stamp = Date.now();
      const marker = `PIGO-STORY-${stamp}`;
      const checks = storyChecks(baselineHead, marker);
      const title = `Story 交付演练 ${stamp}`;

      // =====================================================================
      // Step 1 — story 场景
      // =====================================================================
      step(`Step 1 story 场景：在受控工作区 ${fixtureId} 创建极小确定性真实任务（交付物 ${STORY_DELIVERABLE} + 1 条 grep 检查）`);

      const created = await request.post("/api/runs", {
        data: {
          title,
          task: storyTask(marker),
          mode: "real",
          workspaceId: fixtureId,
          checks,
          developerModel: developer,
          reviewerModel: reviewer,
        },
      });
      expect(created.status(), `Step 1: POST /api/runs 失败（期望 201，实际 ${created.status()}）：${await created.text()}`).toBe(201);
      const createdRun = (await created.json()) as AcceptanceRun;
      runId = createdRun.id;
      evidence.runId = runId;
      evidence.run = createdRun;
      test.info().annotations.push({
        type: "run",
        description: `${runId}（developer=${developer!.provider}/${developer!.model}，reviewer=${reviewer!.provider}/${reviewer!.model}，marker=${marker}）`,
      });
      expect(
        ACTIVE_RUN_STATES.includes(createdRun.state),
        `Step 1: 新建运行的初始状态必须处于活跃态（${ACTIVE_RUN_STATES.join("/")}），实际 ${createdRun.state}`,
      ).toBe(true);
      expect(createdRun.workspaceId, `Step 1: 运行必须跑在受控工作区上（期望 ${fixtureId}）`).toBe(fixtureId);
      expect(
        createdRun.baseSha,
        "Step 1: 运行的基线提交必须等于创建前刷新得到的 HEAD（检查命令以它为基准）",
      ).toBe(baselineHead);
      expect(createdRun.developer, "Step 1: 运行记录的 developer 必须等于钉住的选择").toEqual(developer);
      expect(createdRun.reviewer, "Step 1: 运行的 reviewer 必须等于钉住的选择").toEqual(reviewer);

      // =====================================================================
      // Step 2 — 开发与检查
      // =====================================================================
      step(`Step 2 开发与检查：轮询 ${waitMs}ms 到终态，断言 review.started / rounds verdict / checks 与状态一致`);

      await expect
        .poll(
          async () => {
            const current = await getRun(request, runId!);
            evidence.run = current;
            if (current.state === "completed") return true;
            return !ACTIVE_RUN_STATES.includes(current.state);
          },
          {
            message: `Step 2: Run ${runId} 未在 ${waitMs}ms 内到达终态（completed 或 needs_human/failed）。`,
            timeout: waitMs,
            intervals: [2_000, 5_000],
          },
        )
        .toBe(true);

      const run = await getRun(request, runId);
      evidence.run = run;
      const events = await getRunEvents(request, runId);
      evidence.events = events;
      const roundSummary = await getRunRounds(request, runId);
      evidence.rounds = roundSummary;
      const dump = () => formatEvents(events);

      expect(
        run.state,
        `Step 2: 终态必须是 completed（独立审核通过）。实际 state=${run.state}，summary=${run.summary ?? ""}。事件日志：\n${dump()}`,
      ).toBe("completed");
      expect(
        events.some((event) => event.type === "review.started"),
        `Step 2: 必须出现 review.started（独立审核真的发生过）。事件类型：${[...new Set(events.map((e) => e.type))].join(", ")}`,
      ).toBe(true);
      expect(
        run.round ?? 1,
        `Step 2: 若发生返修轮次，round 必须 ≥ 1（实际 ${String(run.round)}）`,
      ).toBeGreaterThanOrEqual(1);
      const verdicts = roundSummary.rounds.filter((item) => item.verdict !== "none");
      expect(
        verdicts.length,
        `Step 2: GET /api/runs/:id/rounds 必须记录审核 verdict（实际 ${JSON.stringify(roundSummary.rounds)}）`,
      ).toBeGreaterThan(0);
      expect(
        verdicts[verdicts.length - 1].verdict,
        `Step 2: 最后一个审核 verdict 必须是 approved（completed 的充要证据）。rounds=${JSON.stringify(roundSummary.rounds)}`,
      ).toBe("approved");
      const failedChecks = (run.checks ?? []).filter((check) => check.status !== "passed");
      expect(
        failedChecks.map((check) => `${check.command} → ${check.status}(exit=${String(check.exitCode)})`),
        `Step 2: 终态 completed 时不得有任何失败的 check。checks=${JSON.stringify(run.checks ?? [])}`,
      ).toEqual([]);
      expect(run.checks?.map((check) => check.command), "Step 2: Run 记录的检查命令必须与本用例提交的验收条件一致").toEqual([...checks]);
      for (const check of run.checks ?? []) {
        expect(check.exitCode, `Step 2: 检查 ${check.command} 的 exitCode 必须为 0（实际 ${String(check.exitCode)}）`).toBe(0);
      }
      expect(
        events.filter((event) => event.type === "check.failed").map((event) => event.message),
        "Step 2: 闭环运行不得出现任何 check.failed",
      ).toEqual([]);
      note(
        `Step 2: round=${String(run.round)}，verdicts=${JSON.stringify(roundSummary.rounds.map((item) => `${item.round}:${item.verdict}`))}，checks=${(run.checks ?? []).length} 全通过，modelCalls=${String(run.modelCalls)}`,
      );

      // =====================================================================
      // Step 3 — 交付物证据
      // =====================================================================
      step("Step 3 交付物证据：run.diff 非空且与本轮意图一致；diff 制品下载 body 与 run.diff 逐字节一致、sha256/bytes 与制品记录一致");

      const diff = run.diff ?? "";
      expect(diff, `Step 3: Run 必须产出非空 diff（本轮的确定性交付物是 ${STORY_DELIVERABLE}）。事件日志：\n${dump()}`).not.toBe("");
      const deliverableSection = diff
        .split(/^diff --git /m)
        .find((section) => section.startsWith(`a/${STORY_DELIVERABLE} b/${STORY_DELIVERABLE}`));
      expect(
        deliverableSection,
        `Step 3: run.diff 必须包含 ${STORY_DELIVERABLE} 的改动段（本轮意图）。touched=${JSON.stringify(touchedPaths(diff))}。run.diff：\n${diff}`,
      ).toBeTruthy();
      expect(
        deliverableSection!.split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++")),
        `Step 3: ${STORY_DELIVERABLE} 的 diff 必须包含至少一行新增内容。实际：\n${deliverableSection}`,
      ).toBe(true);
      expect(
        deliverableSection,
        `Step 3: 新增行必须包含本次运行唯一的标记 ${marker}（否则交付的就不是本轮要求的产物）。实际：\n${deliverableSection}`,
      ).toContain(marker);
      const touched = touchedPaths(diff);
      expect(
        touched.filter((path) => path !== STORY_DELIVERABLE),
        `Step 3: 任务要求改动最小：run.diff 只应触碰 ${STORY_DELIVERABLE}，实际触碰 ${JSON.stringify(touched)}。run.diff：\n${diff}`,
      ).toEqual([]);

      const artifacts = await getRunArtifacts(request, runId);
      evidence.artifacts = artifacts;
      const diffArtifact = artifacts.find((artifact) => artifact.artifactId === "diff");
      expect(
        diffArtifact,
        `Step 3: Run 有 diff 却未保留 diff 制品（现有制品：${artifacts.map((a) => a.artifactId).join(", ") || "无"}）`,
      ).toBeTruthy();
      expect(diffArtifact!.bytes, `Step 3: diff 制品字节数必须非零，实际 ${diffArtifact!.bytes}`).toBeGreaterThan(0);
      const download = await request.get(`/api/runs/${runId}/artifacts/diff/download`);
      expect(download.ok(), `Step 3: diff 制品必须可下载（HTTP ${download.status()}）`).toBeTruthy();
      const downloaded = await download.text();
      expect(downloaded, "Step 3: 下载的 diff 制品必须与 run.diff 逐字节一致").toBe(diff);
      expect(
        diffArtifact!.sha256,
        `Step 3: diff 制品记录必须带 sha256（实际 ${JSON.stringify(diffArtifact!.sha256)}）——没有它就无从核验下载内容`,
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(
        diffArtifact!.sha256,
        `Step 3: 制品记录的 sha256 必须等于下载 body 的 sha256（制品记录=${String(diffArtifact!.sha256)}，实测=${sha256Hex(downloaded)}）`,
      ).toBe(sha256Hex(downloaded));
      expect(
        diffArtifact!.bytes,
        `Step 3: 制品记录的字节数必须等于下载 body 的字节数（记录=${diffArtifact!.bytes}，实测=${Buffer.byteLength(downloaded, "utf8")}）`,
      ).toBe(Buffer.byteLength(downloaded, "utf8"));
      note(
        `Step 3: diff ${Buffer.byteLength(diff, "utf8")} 字节 / ${diff.split("\n").length} 行；artifact sha256=${diffArtifact!.sha256!.slice(0, 12)}…（与下载 body 一致）`,
      );

      // =====================================================================
      // Step 4 — 人工闸门（关键：必须在合并之前断言「没有自动合并」）
      // =====================================================================
      step("Step 4 人工闸门：断言没有自动合并/发布（run.merge 缺失、无 run.merged 事件、默认分支 HEAD 未变且工作区不 dirty）");

      expect(run.merge ?? null, "Step 4: 终态 completed 不得自动合并到工作区默认分支").toBeNull();
      expect(
        events.filter((event) => /^run\.(merged|merge_failed)$/.test(event.type)).map((event) => event.message),
        "Step 4: 不得出现自动合并事件（run.merged/run.merge_failed）",
      ).toEqual([]);
      expect(run.release ?? null, "Step 4: 合并/完成本身不得隐式发布（发布是独立的显式管理员动作）").toBeNull();
      expect(
        events.filter((event) => /^run\.release_/.test(event.type)).map((event) => event.message),
        "Step 4: 不得出现隐式发布事件（run.release_*）",
      ).toEqual([]);
      const beforeMerge = await refreshWorkspace(request, fixtureId!);
      expect(
        beforeMerge.git?.dirty,
        `Step 4: Run 不得改动工作区工作树（运行在独立克隆中进行）。git=${JSON.stringify(beforeMerge.git)}`,
      ).toBe(false);
      expect(
        beforeMerge.git?.head,
        `Step 4: 人工合并前默认分支 HEAD 不得移动（期望 ${baselineHead}，实际 ${String(beforeMerge.git?.head)}）`,
      ).toBe(baselineHead);
      note(`Step 4: 无自动合并/发布；合并前 HEAD 仍为 ${baselineHead.slice(0, 12)}，工作区干净`);

      // =====================================================================
      // Step 5 — 管理员合并
      // =====================================================================
      step("Step 5 管理员合并：POST /merge（期望 200）→ 合并记录 + run.merged 事件 + 默认分支 HEAD 前移到 merge.commit");

      const mergeResponse = await request.post(`/api/runs/${runId}/merge`, {
        data: { confirm: true, note: "Story 交付演练：人工 Approve 并合并独立审核通过的交付" },
      });
      expect(
        mergeResponse.status(),
        `Step 5: POST /api/runs/${runId}/merge 失败（期望 200，实际 HTTP ${mergeResponse.status()}）：${(await mergeResponse.text()).slice(0, 500)}`,
      ).toBe(200);
      const merged = (await mergeResponse.json()) as AcceptanceRun;
      expect(merged.merge, `Step 5: 合并响应必须携带 run.merge 记录：${JSON.stringify(merged)}`).toBeTruthy();
      const merge = merged.merge!;
      expect(merge.commit, `Step 5: 合并必须记录 40 位提交哈希（实际 ${JSON.stringify(merge)}）`).toMatch(/^[0-9a-f]{40}$/);
      expect(["fast-forward", "merge-commit"], `Step 5: 未知的合并策略 ${merge.strategy}`).toContain(merge.strategy);
      expect(merge.targetBranch, `Step 5: 合并目标必须是工作区默认分支（${String(baseline.defaultBranch)}）`).toBe(baseline.defaultBranch);
      expect(merge.mergedBy, `Step 5: 合并必须记录操作者（可审计），期望管理员 ${me.id}`).toBe(me.id);
      expect(Number.isFinite(Date.parse(merge.mergedAt)), `Step 5: 合并时间戳必须是可解析的 ISO 时间（实际 ${merge.mergedAt}）`).toBe(true);
      test.info().annotations.push({ type: "merge", description: JSON.stringify(merge) });

      const mergedEvents = (await getRunEvents(request, runId)).filter((event) => event.type === "run.merged");
      expect(mergedEvents, "Step 5: 人工合并必须恰好记录一条 run.merged 事件").toHaveLength(1);
      expect(
        String(mergedEvents[0].meta?.commit ?? ""),
        `Step 5: run.merged 必须携带同一个 commit：${JSON.stringify(mergedEvents[0].meta ?? {})}`,
      ).toBe(merge.commit);
      expect(String(mergedEvents[0].meta?.mergedBy ?? ""), "Step 5: run.merged 必须携带操作者").toBe(merge.mergedBy);
      const reviewApprovedSeq = events.find((event) => event.type === "review.approved")?.seq ?? 0;
      expect(mergedEvents[0].seq, "Step 5: run.merged 必须晚于 review.approved").toBeGreaterThan(reviewApprovedSeq);

      const afterMerge = await refreshWorkspace(request, fixtureId!);
      expect(
        afterMerge.git?.head,
        `Step 5: 人工合并后默认分支 HEAD 必须推进到合并 commit（期望 ${merge.commit}，实际 ${String(afterMerge.git?.head)}）`,
      ).toBe(merge.commit);
      expect(
        merge.commit,
        `Step 5: 人工合并必须把默认分支推进到新提交（基线 ${baselineHead}）：HEAD 未移动意味着合并是 fast-forward 到基线的静默 no-op（即 worker 没有把本轮工作树改动提交到任务分支），审核通过的成果并未交付到工作区。`,
      ).not.toBe(baselineHead);
      expect(afterMerge.git?.dirty, "Step 5: 人工合并后工作区必须是干净的").toBe(false);
      note(`Step 5: merge.commit=${merge.commit.slice(0, 12)}… strategy=${merge.strategy} branch=${merge.targetBranch}；HEAD ${baselineHead.slice(0, 12)}… → ${merge.commit.slice(0, 12)}…`);

      // =====================================================================
      // Step 6 — 决策平面见证
      // =====================================================================
      step("Step 6 决策平面见证：/decisions 脱敏投影 + decision.requested/completed|fallback 成对；无证据则如实标注并与引擎状态自洽");

      const findings = run.findings ?? [];
      const unresolved = findings.filter((finding) => !finding.resolved).length;
      test.info().annotations.push({ type: "findings", description: `run=${runId} findings=${findings.length} unresolved=${unresolved}` });

      const decisionEnabled = Boolean(engine) && engine!.engine !== "disabled" && engine!.mode !== "off";
      /** decision.* 事件 meta 白名单 + 批次自洽（照抄 decision-engine.spec.ts）。 */
      const decisionMetaWhitelistError = (meta: Record<string, unknown>): string | undefined => {
        for (const [key, value] of Object.entries(meta)) {
          if (!DECISION_EVENT_META_KEYS.has(key)) return `meta 出现未允许的键 ${key}`;
          const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
          if (FORBIDDEN_TOKEN.test(text)) return `meta.${key} 的值看起来像凭据：${text.slice(0, 120)}`;
        }
        const index = meta.batchIndex;
        const count = meta.batchCount;
        if (index !== undefined || count !== undefined) {
          const i = Number(index);
          const n = Number(count);
          if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 1 || i > n) {
            return `meta 批次字段不自洽（batchIndex=${String(index)} batchCount=${String(count)}）`;
          }
        }
        return undefined;
      };

      if (!decisionEnabled) {
        // 引擎未启用：本轮**不应**有任何决策证据，这是自洽的（如实标注，不静默通过）。
        await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, 20_000)));
        const decisionEvents = (await getRunEvents(request, runId)).filter((event) => event.type.startsWith("decision."));
        const decisionRead = await getDecisions(request, runId);
        evidence.decisions = decisionRead.decisions;
        expect(
          decisionEvents.map((event) => event.type),
          `Step 6: 决策平面未启用（decisionEngine=${JSON.stringify(engine ?? null)}），本轮不应产生任何 decision.* 事件，实际 ${decisionEvents.map((event) => event.type).join(", ")}`,
        ).toEqual([]);
        expect(
          decisionRead.decisions.filter((row) => row.kind === "review_triage"),
          `Step 6: 决策平面未启用（decisionEngine=${JSON.stringify(engine ?? null)}），不应写入 review_triage 审计行（decisions HTTP ${decisionRead.status}）`,
        ).toEqual([]);
        note(
          `Step 6: 本轮无决策证据 —— 部署未启用决策平面（decisionEngine=${JSON.stringify(engine ?? null)}，engine=${String(engine?.engine ?? "未报告")}/mode=${String(engine?.mode ?? "未报告")}），与「零决策证据」自洽。若要在本用例里见证决策平面：PI_DECISION_ENGINE=mock + PI_JEV_MODE=shadow（web 与 worker 两个进程都要设）。`,
        );
      } else if (findings.length === 0) {
        // 引擎启用，但本轮审核从未产生 finding ⇒ provider 侧无可问内容，网关不会产出批次、
        // 不落审计行、不写事件（docs/26 §6.3.1）。零证据在这里是正确的，但要显式断言。
        await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, 20_000)));
        const decisionEvents = (await getRunEvents(request, runId)).filter((event) => event.type.startsWith("decision."));
        const decisionRead = await getDecisions(request, runId);
        evidence.decisions = decisionRead.decisions;
        expect(
          decisionEvents.map((event) => event.type),
          `Step 6: 该运行从未有过 finding，因此无任何可问内容，不应产生决策事件（实际 ${decisionEvents.map((event) => event.type).join(", ")}；事件流：\n${formatEvents(evidence.events)}）`,
        ).toEqual([]);
        expect(
          decisionRead.decisions.filter((row) => row.kind === "review_triage"),
          "Step 6: 无 findings 时不应写入 review_triage 审计行（空 questions 会被 provider 拒绝为 422）",
        ).toEqual([]);
        note(
          `Step 6: 本轮无决策证据 —— 引擎已启用（${String(engine!.engine)}/${String(engine!.mode)}）但本轮审核 0 finding（findings=0/unresolved=0），无可问内容（provider 侧 questions 的 minProperties:1 会拒绝空 questions），故网关不落审计行、不写事件；与「引擎启用但无证据」自洽。`,
        );
      } else {
        // 引擎启用且本轮确有 finding：必须产生成对的决策证据——否则这就是要抓的 bug
        // （worker 未设置 PI_JEV_MODE，或构建缺少 docs/26 §9.1 的调用点）。
        let allEvents: AcceptanceEvent[] = [];
        let rows: DecisionProjection[] = [];
        await expect
          .poll(
            async () => {
              allEvents = await getRunEvents(request, runId!);
              const requestedCount = allEvents.filter((event) => event.type === "decision.requested").length;
              const outcomeCount = allEvents.filter(
                (event) => event.type === "decision.completed" || event.type === "decision.fallback",
              ).length;
              rows = (await getDecisions(request, runId!)).decisions;
              return requestedCount > 0 && requestedCount === outcomeCount && rows.some((row) => row.kind === "review_triage");
            },
            {
              message: `Step 6: Run ${runId} 到达终态后 ${settleMs}ms 内仍未出现完整的决策证据（至少一行 review_triage 审计 + 成对的 decision.requested/completed|fallback）。部署报告 decisionEngine=${JSON.stringify(engine)} 且本轮有 findings=${findings.length}（未解决 ${unresolved}），按选取策略必须产生决策证据 ⇒ 这是真实缺陷：构建里 worker 的审核调用点（docs/26 §9.1）没有调用 POST /api/internal/decisions/evaluate，或 worker 自身未设置 PI_JEV_MODE（src/worker/decision-triage.ts 在 worker 进程读 PI_JEV_MODE；web 与 worker 两个进程都要设）。已见事件类型：${[...new Set(allEvents.map((event) => event.type))].join(", ")}`,
              timeout: settleMs,
              intervals: [1_000, 2_000, 5_000],
            },
          )
          .toBe(true);

        evidence.events = allEvents;
        evidence.decisions = rows;
        const triage = rows.filter((row) => row.kind === "review_triage");
        expect(triage.length, `Step 6: 决策审计必须包含 kind=review_triage（实际 ${rows.map((row) => row.kind).join(", ")}）`).toBeGreaterThan(0);

        for (const decision of triage) {
          const where = `Step 6 evaluation ${decision.evaluationId}`;
          // 投影字段完整性。
          for (const field of ["status", "mode", "provider", "requestedModel", "policyVersion", "stateHash", "latencyMs", "answers"]) {
            expect(
              Object.prototype.hasOwnProperty.call(decision, field),
              `${where}: 脱敏投影必须带字段 ${field}（实际键 ${Object.keys(decision).join(", ")}）`,
            ).toBe(true);
          }
          expect(typeof decision.provider === "string" && decision.provider.trim().length > 0, `${where}: provider 必须是非空字符串`).toBe(true);
          expect(
            typeof decision.requestedModel === "string" && decision.requestedModel.trim().length > 0,
            `${where}: requestedModel 必须是非空字符串`,
          ).toBe(true);
          expect(
            typeof decision.policyVersion === "string" && decision.policyVersion.trim().length > 0,
            `${where}: policyVersion 必须是非空字符串`,
          ).toBe(true);
          expect(decision.stateHash, `${where}: stateHash 必须是 64 位十六进制（实际 ${decision.stateHash}）`).toMatch(/^[0-9a-f]{64}$/);
          expect(
            Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0,
            `${where}: latencyMs 必须是有限的非负数（实际 ${decision.latencyMs}）`,
          ).toBe(true);
          expect(Array.isArray(decision.answers), `${where}: answers 必须是数组`).toBe(true);
          // 记录的 mode 是**有效模式**：policy 会把 `enforce` 降级为 `assist`
          // （src/server/decision-engine/policy.ts 的 enforceKinds 默认空），所以不能直接与配置比较。
          const expectedEffectiveMode = engine!.mode === "enforce" ? "assist" : engine!.mode;
          expect(
            decision.mode,
            `${where}: 记录的 mode 必须是配置 ${String(engine!.mode)} 的有效模式（policy 会把 enforce 降级为 assist，实际 ${decision.mode}）`,
          ).toBe(expectedEffectiveMode);
          if (decision.mode === "shadow") {
            expect(decision.appliedOutcome, `${where}: shadow 模式不得应用任何结果（appliedOutcome 必须是 none）`).toBe("none");
          }
          if (decision.status === "completed") {
            expect(typeof decision.fallbackReason, `${where}: completed 不得带 fallbackReason`).toBe("undefined");
          } else {
            expect(
              FALLBACK_REASONS as readonly string[],
              `${where}: status=${decision.status} 只能是带标准 fallbackReason 的 fallback（实际 ${String(decision.fallbackReason)}）`,
            ).toContain(decision.fallbackReason);
          }

          // 脱敏投影：key 集合白名单 + 敏感键缺失 + stateManifest 是脱敏摘要。
          const projectionKeys = Object.keys(decision);
          const unexpected = projectionKeys.filter((key) => !DECISION_PROJECTION_KEYS.has(key));
          expect(unexpected, `${where}: 投影出现未允许的键 ${JSON.stringify(unexpected)}。实际键 ${projectionKeys.join(", ")}`).toEqual([]);
          const forbidden = projectionKeys.filter((key) => FORBIDDEN_PROJECTION_KEYS.includes(key));
          expect(forbidden, `${where}: 投影不得包含敏感/外发 payload 键 ${JSON.stringify(forbidden)}`).toEqual([]);
          const manifest = decision.stateManifest ?? {};
          const manifestKeys = Object.keys(manifest);
          expect(
            manifestKeys.filter((key) => !DECISION_MANIFEST_KEYS.includes(key)),
            `${where}: stateManifest 只允许字段名/计数/尺寸（实际键 ${manifestKeys.join(", ")}）`,
          ).toEqual([]);
          const manifestText = JSON.stringify(manifest);
          expect(FORBIDDEN_TOKEN.test(manifestText), `${where}: stateManifest 不得包含密钥形状字符串：${manifestText.slice(0, 200)}`).toBe(false);

          // 成本语义（AT-JEV-062）：缺失即「未知」，绝不能伪造成 0；出现时必须是有限非负数。
          const cost = decision.estimatedCostUsd;
          expect(cost === null, `${where}: estimatedCostUsd 未知时必须缺省（字段不存在），而不是 null`).toBe(false);
          if (cost !== undefined) {
            expect(Number.isFinite(cost) && cost >= 0, `${where}: estimatedCostUsd 出现时必须是有限的非负数（实际 ${String(cost)}）`).toBe(true);
          }
          const outputTokens = decision.outputTokens;
          if (decision.status === "completed" && typeof outputTokens === "number" && outputTokens > 0) {
            expect(
              cost === undefined || cost > 0,
              `${where}: 成本不可计算时必须是「未知」（字段缺省），绝不能写成 0；实测 estimatedCostUsd=${String(cost)}（outputTokens=${outputTokens}）。`,
            ).toBe(true);
          }
          note(
            `Step 6: ${where}: status=${decision.status} mode=${decision.mode} provider=${decision.provider} requested=${decision.requestedModel} resolved=${String(decision.resolvedModel)} policy=${decision.policyVersion} stateHash=${decision.stateHash.slice(0, 12)}… latency=${decision.latencyMs}ms answers=${decision.answers.length} cost=${cost === undefined ? "未知（字段缺省，非 0）" : String(cost)}`,
          );

          // 答案数量必须与「本轮未解决 finding 数」一致（4 个固定问题后缀/finding）。
          const answers = decision.answers ?? [];
          expect(answers.length % QUESTION_SUFFIXES.length, `${where}: 答案数量必须是每个 finding 四个固定问题的整数倍（实际 ${answers.length}）`).toBe(0);
          const manifestQuestionCount = manifest.questionCount;
          if (typeof manifestQuestionCount === "number") {
            expect(manifestQuestionCount, `${where}: stateManifest.questionCount 必须等于答案数量`).toBe(answers.length);
          }
          const counts = manifest.counts as Record<string, number> | undefined;
          if (typeof counts?.findings === "number") {
            expect(
              answers.length,
              `${where}: 答案数量必须等于 4 × 本轮未解决 finding 数（stateManifest.counts.findings=${counts.findings}）`,
            ).toBe(counts.findings * QUESTION_SUFFIXES.length);
          }
          if (answers.length === 0) {
            expect(counts?.findings ?? 0, `${where}: 空答案集合只能对应 0 个未解决 finding`).toBe(0);
          }
        }

        // 事件成对：每个 decision.requested 恰好一个 completed|fallback，同 evaluationId、requested 在前。
        const decisionEvents = allEvents.filter((event) => event.type.startsWith("decision."));
        const requested = decisionEvents.filter((event) => event.type === "decision.requested");
        const outcomes = decisionEvents.filter((event) => event.type === "decision.completed" || event.type === "decision.fallback");
        expect(
          requested.length,
          `Step 6: 事件流必须带 decision.requested。事件类型：${[...new Set(allEvents.map((event) => event.type))].join(", ")}`,
        ).toBeGreaterThan(0);
        expect(
          outcomes.length,
          `Step 6: 每个 decision.requested 必须恰好对应一个 decision.completed|decision.fallback（实际 ${requested.length} requested / ${outcomes.length} outcome）`,
        ).toBe(requested.length);
        const requestedIds = requested.map((event) => String(event.meta?.evaluationId ?? ""));
        const outcomeIds = outcomes.map((event) => String(event.meta?.evaluationId ?? ""));
        expect(requestedIds.filter(Boolean).length, "Step 6: decision.requested 必须带 evaluationId").toBe(requested.length);
        expect(outcomeIds.filter(Boolean).length, "Step 6: decision 结果事件必须带 evaluationId").toBe(outcomes.length);
        expect([...outcomeIds].sort(), "Step 6: 每个 requested 只能有一个 outcome，且 evaluationId 必须完全对应").toEqual([...requestedIds].sort());
        expect(new Set(requestedIds).size, "Step 6: 同一 evaluationId 不得出现两条 decision.requested").toBe(requestedIds.length);
        const requestSeqById = new Map<string, number>();
        for (const event of requested) requestSeqById.set(String(event.meta?.evaluationId), event.seq);
        for (const event of outcomes) {
          const id = String(event.meta?.evaluationId);
          expect(
            event.seq,
            `Step 6: ${id} 的结果事件必须晚于对应的 decision.requested（requested seq=${String(requestSeqById.get(id))}，outcome seq=${event.seq}）`,
          ).toBeGreaterThan(requestSeqById.get(id)!);
        }
        const reviewStartedSeq = allEvents.find((event) => event.type === "review.started")?.seq;
        expect(
          typeof reviewStartedSeq === "number",
          "Step 6: 决策评估必须发生在审核开始之后（docs/26 §9.1）：事件流里缺少 review.started",
        ).toBe(true);
        for (const event of decisionEvents) {
          expect(
            event.seq,
            `Step 6: 决策评估必须发生在 reviewer 解析成功之后（docs/26 §9.1）：#${event.seq} ${event.type} 出现在 review.started(#${String(reviewStartedSeq)}) 之前`,
          ).toBeGreaterThan(reviewStartedSeq!);
        }
        for (const event of decisionEvents) {
          const meta = event.meta ?? {};
          const error = decisionMetaWhitelistError(meta);
          expect(error, `Step 6: decision 事件 meta 越界：#${event.seq} ${event.type} → ${error}`).toBeUndefined();
          for (const key of Object.keys(meta)) {
            expect(
              /^(state|questions|answers|payload|payloads|request|raw|source)$/i.test(key),
              `Step 6: decision 事件 meta 不得包含外发 payload 字段 ${key}：#${event.seq} ${event.type}`,
            ).toBe(false);
          }
          expect(FORBIDDEN_TOKEN.test(event.message), `Step 6: decision 事件文案不得包含凭据：${event.message}`).toBe(false);
        }
        for (const event of requested) {
          expect(
            Object.keys(event.meta ?? {}).sort(),
            `Step 6: decision.requested 的 meta 只允许 ${DECISION_REQUESTED_KEYS.join("/")}：#${event.seq} ${JSON.stringify(event.meta ?? {})}`,
          ).toEqual([...DECISION_EVENT_META_KEYS].filter((key) => DECISION_REQUESTED_KEYS.includes(key)).sort());
        }
        for (const event of outcomes) {
          if (event.type === "decision.fallback") {
            expect(
              FALLBACK_REASONS as readonly string[],
              `Step 6: decision.fallback 必须带标准 fallbackReason（实际 ${String(event.meta?.fallbackReason)}）`,
            ).toContain(event.meta?.fallbackReason);
          } else {
            expect(event.meta?.status, "Step 6: decision.completed 的 meta.status 必须是 completed").toBe("completed");
          }
        }
        const answeredRows = triage.filter((row) => (row.answers ?? []).length > 0);
        note(
          `Step 6: 本轮有决策证据 —— review_triage 审计 ${triage.length} 条（带答案 ${answeredRows.length} 条），decision.requested/outcome 各 ${requested.length}，事件成对且均在 review.started 之后；投影/事件均通过脱敏与白名单扫描。`,
        );
      }

      // =====================================================================
      // Step 7 — 显式发布（部署交付）
      // =====================================================================
      step(`Step 7 显式发布：POST /publish environment=${environment}（钩子未配置→409+明确 code 且不写 release；已配置→记录 release + started/终态事件）`);

      const publishResponse = await request.post(`/api/runs/${runId}/publish`, {
        data: { environment, confirm: true },
      });
      let releaseOutcome: string;
      if (publishResponse.status() === 200) {
        const published = (await publishResponse.json()) as AcceptanceRun;
        expect(published.release, `Step 7: 发布成功必须携带 run.release 记录：${JSON.stringify(published)}`).toBeTruthy();
        expect(
          ["succeeded", "triggered", "failed"],
          `Step 7: 已配置发布钩子时 run.release.status 必须是 succeeded/triggered/failed，实际 ${String(published.release?.status)}`,
        ).toContain(published.release!.status);
        expect(published.release!.commit, "Step 7: 发布记录必须指向被合并的 commit").toBe(merge.commit);
        expect(published.release!.environment, "Step 7: 发布记录必须指向请求的环境").toBe(environment);
        expect(published.release!.requestedBy, `Step 7: 发布记录必须记录操作者（期望管理员 ${me.id}）`).toBe(me.id);
        expect(
          Number.isFinite(Date.parse(published.release!.startedAt)),
          `Step 7: 发布 startedAt 必须是可解析的 ISO 时间（实际 ${published.release!.startedAt}）`,
        ).toBe(true);
        expect(published.release!.targetBranch, `Step 7: 发布记录必须指向合并的目标分支（${String(baseline.defaultBranch)}）`).toBe(baseline.defaultBranch);
        const releaseEvents = await getRunEvents(request, runId);
        expect(
          releaseEvents.filter((event) => event.type === "run.release_started"),
          "Step 7: 发布必须记录 run.release_started（发布尝试可审计，不是静默跳过）",
        ).toHaveLength(1);
        const terminalType =
          published.release!.status === "triggered"
            ? "run.release_triggered"
            : published.release!.status === "succeeded"
              ? "run.release_succeeded"
              : "run.release_failed";
        expect(
          releaseEvents.filter((event) => event.type === terminalType).map((event) => event.message),
          `Step 7: 发布必须记录终态事件 ${terminalType}（status=${published.release!.status}）`,
        ).toHaveLength(1);
        test.info().annotations.push({ type: "release", description: JSON.stringify(published.release) });
        releaseOutcome = JSON.stringify(published.release);
      } else {
        // 钩子未配置（demo）或配置不完整：服务端必须显式拒绝，绝不静默。
        const body = await publishResponse.text();
        expect(
          publishResponse.status(),
          `Step 7: 未配置发布钩子时显式拒绝的 HTTP 状态应为 409（实际 ${publishResponse.status()}）：${body.slice(0, 400)}`,
        ).toBe(409);
        const parsed = JSON.parse(body) as { code?: string; error?: string };
        expect(
          ["RELEASE_NOT_CONFIGURED", "RELEASE_CONFIG_INVALID", "RELEASE_AUTH_NOT_CONFIGURED", "RELEASE_CALLBACK_NOT_CONFIGURED"],
          `Step 7: 未配置/配置不完整的发布必须以明确的 code 拒绝（实际 code=${String(parsed.code)}，error=${String(parsed.error)}）`,
        ).toContain(parsed.code);
        expect(String(parsed.error ?? ""), "Step 7: 显式拒绝必须携带可读原因（绝不静默）").not.toBe("");
        const afterPublish = await getRun(request, runId);
        expect(afterPublish.release ?? null, "Step 7: 被显式拒绝的发布不得写入 run.release").toBeNull();
        expect(
          (await getRunEvents(request, runId)).filter((event) => /^run\.release_/.test(event.type)),
          "Step 7: 被显式拒绝的发布不得产生 run.release_* 事件",
        ).toEqual([]);
        test.info().annotations.push({ type: "release", description: `explicitly not configured: ${body.slice(0, 300)}` });
        releaseOutcome = `未配置（HTTP 409 code=${String(parsed.code)}，未写 release 记录）`;
      }
      note(`Step 7: 发布结果 = ${releaseOutcome}`);

      // =====================================================================
      // Step 8 — 交付结果核验
      // =====================================================================
      step("Step 8 交付结果核验：GET /api/deployments 可达（本次 release 有部署日志记录则断言可查到）；工作区默认分支 HEAD 仍等于 merge.commit 且不 dirty");

      const deploymentsResponse = await request.get("/api/deployments");
      expect(
        deploymentsResponse.ok(),
        `Step 8: GET /api/deployments 必须可达（HTTP ${deploymentsResponse.status()}）：${(await deploymentsResponse.text()).slice(0, 300)}`,
      ).toBeTruthy();
      const deployments = (await deploymentsResponse.json()) as DeploymentStatus;
      expect(Array.isArray(deployments.records), `Step 8: /api/deployments 必须返回 records 数组：${JSON.stringify(deployments).slice(0, 300)}`).toBe(true);
      const releaseRecord = await getRun(request, runId);
      const deployRecords = deployments.records ?? [];
      const matches = deployRecords.filter(
        (record) => record.commit === merge.commit || record.raw.includes(merge.commit),
      );
      if (matches.length > 0) {
        expect(
          matches.map((record) => record.status ?? "(未知)"),
          `Step 8: 部署日志里本次 release 的记录不得为失败状态：${JSON.stringify(matches)}`,
        ).not.toContain("failed");
        note(`Step 8: /api/deployments 查到本次交付的部署记录 ${matches.length} 条（commit=${merge.commit.slice(0, 12)}…）：${JSON.stringify(matches.map((record) => ({ at: record.at, status: record.status, version: record.version })))}`);
      } else {
        note(
          `Step 8: /api/deployments 可达（log.available=${String(deployments.log?.available)}，共 ${deployRecords.length} 条部署记录），但没有 commit=${merge.commit.slice(0, 12)}… 的记录 —— 如实记录：发布钩子未配置（${releaseOutcome.slice(0, 80)}）或部署日志未回写本次 commit。`,
        );
      }
      const finalWorkspace = await refreshWorkspace(request, fixtureId!);
      expect(
        finalWorkspace.git?.head,
        `Step 8: 交付后工作区默认分支 HEAD 仍必须等于 merge.commit（期望 ${merge.commit}，实际 ${String(finalWorkspace.git?.head)}）`,
      ).toBe(merge.commit);
      expect(finalWorkspace.git?.dirty, "Step 8: 交付后工作区必须仍然干净").toBe(false);
      note(
        `Step 8: 交付后 HEAD=${String(finalWorkspace.git?.head).slice(0, 12)}…（= merge.commit，工作区干净）；run.release 记录=${releaseRecord.release ? JSON.stringify(releaseRecord.release.status) : "无"}`,
      );

      // =====================================================================
      // Step 9 — 总结报告
      // =====================================================================
      step("Step 9 总结报告：打印一张表并输出 STORY_DELIVERY_OK");

      const finalRun = await getRun(request, runId);
      evidence.run = finalRun;
      const finalDecisions = (await getDecisions(request, runId)).decisions;
      const elapsedMs = Date.now() - stamp;
      const costSemantics =
        finalDecisions.length === 0
          ? "无决策行（本轮无决策证据）"
          : finalDecisions
              .map((row) => (row.estimatedCostUsd === undefined ? `cost=未知(缺省,非0)` : `cost=${row.estimatedCostUsd}`))
              .join("; ");
      const rowsOut: Array<[string, string]> = [
        ["run id", String(runId)],
        ["终态 / 轮次", `${finalRun.state} / round=${String(finalRun.round)}`],
        ["审核 verdict", JSON.stringify(roundSummary.rounds.map((item) => `${item.round}:${item.verdict}`))],
        ["diff 行数 / 字节", `${diff.split("\n").length} 行 / ${Buffer.byteLength(diff, "utf8")} 字节（文件：${touched.join(", ") || "无"}）`],
        ["artifact sha256", `${String(diffArtifact?.sha256 ?? "").slice(0, 12)}…（bytes=${String(diffArtifact?.bytes)}）`],
        ["merge commit / strategy", `${merge.commit.slice(0, 12)}… / ${merge.strategy} → ${merge.targetBranch}`],
        ["release status", releaseOutcome],
        ["决策条数 / 成本语义", `${finalDecisions.length} 条 / ${costSemantics}`],
        ["总耗时", `${Math.round(elapsedMs / 1000)}s`],
      ];
      const width = Math.max(...rowsOut.map(([label]) => label.length));
      console.log(
        [
          "",
          "################ STORY DELIVERY REPORT ################",
          ...rowsOut.map(([label, value]) => `${label.padEnd(width)} | ${value}`),
          "######################################################",
        ].join("\n"),
      );
      test.info().annotations.push({
        type: "summary",
        description: rowsOut.map(([label, value]) => `${label}=${value}`).join(" | "),
      });
      console.log("STORY_DELIVERY_OK");
    } catch (error) {
      dumpEvidence();
      throw error;
    } finally {
      if (runId) await cancelIfActive(request, runId);
      if (registeredHere && fixtureId) {
        const removal = await request.delete(`/api/workspaces/${fixtureId}`).catch(() => undefined);
        if (removal && !removal.ok() && removal.status() !== 404) {
          test.info().annotations.push({
            type: "cleanup_failed",
            description: `DELETE /api/workspaces/${fixtureId} 返回 HTTP ${removal.status()}：夹具工作区可能仍处于 active 状态，并影响其它场景的默认工作区解析。`,
          });
        }
      }
    }
  });
});
