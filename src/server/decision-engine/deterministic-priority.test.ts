import { describe, expect, it } from "vitest";
import type { CheckResult, Finding, Run } from "../../shared/types.js";
import { baseRealRun } from "../real-run.js";
import { APPLIED_ASSIST, APPLIED_NONE, createDecisionPolicy, resolveAppliedOutcome, type TriageSubject } from "./policy.js";
import {
  AC_MAX_CHARS,
  AC_MAX_ITEMS,
  buildReviewTriageBatches,
  buildReviewTriageState,
  findingQuestionId,
  findingStableKey,
  QUESTION_SUFFIXES,
  runReviewTriageBatches,
  selectReviewFindings,
  TITLE_MAX_CHARS,
} from "./review-triage.js";
import { mapProviderResponse } from "./response-schema.js";
import type { DecisionAnswer, DecisionEngine, DecisionQuestion, DecisionRequest } from "./types.js";
import type { ReviewTriageBatch, ReviewTriageState } from "./review-triage.js";

/** The builder's contract: a batch's `request.state` is the projected review-triage state. */
function stateOf(batch: ReviewTriageBatch): ReviewTriageState {
  return batch.request.state as ReviewTriageState;
}

/**
 * AT-JEV-083 · 模型已知弱项（docs/27 §7.7）。
 *
 * 用例覆盖预期里**我方负责**的那一条：“这些判断保持确定性代码优先”。即无论模型对
 * 数值比较、计数、日期、间接引用、长无关上下文、矛盾条件、对抗内容给出多自信的答案，
 * 确定性信号（检查项、状态、受保护严重度）都是唯一权威，模型不能翻转它、也不能制造
 * 出可施加的结果；超预算的“长无关上下文”直接拒绝而不是截断（fail-closed、不外呼）。
 *
 * 诚实边界：供应商侧“弱项的实际测准率 / jaggedness 报告”需要真 key 评估（AT-JEV-071）
 * 与评估报告，本文件不声称该部分已验收；这里只保证本地管道不会把判断权交给模型，
 * 并保证记录保持**逐问题**粒度，使报告能按问题类拆分而不是用一个总准确率掩盖弱项。
 */

const ENFORCE_POLICY = createDecisionPolicy({ enforceKinds: ["review_triage"] });

const confidentAnswers: DecisionAnswer[] = [
  { questionId: "q_num", type: "probability", value: true, probability: 0.99, certainty: 0.98 },
  { questionId: "q_count", type: "choice", value: "material", probabilities: { none: 0.01, possible: 0.01, material: 0.98 }, confidence: 0.99 },
  { questionId: "q_date", type: "score", value: "high", weightedScore: 3, probabilities: { none: 0.01, low: 0.01, medium: 0.01, high: 0.97 }, confidence: 0.99 },
];

/** The weak-spot classes the AT lists, each with the deterministic signal that must win. */
const WEAK_SPOTS: Array<{ label: string; detail: string }> = [
  { label: "数值比较", detail: "模型声称 3 > 5 成立" },
  { label: "计数", detail: "模型声称缺失了 2 个必填项（实际 0 个）" },
  { label: "日期", detail: "模型声称 SLA 已过期" },
  { label: "间接引用", detail: "模型按第二段引用的旧验收标准作答" },
  { label: "长无关上下文", detail: "上下文里塞满无关段落" },
  { label: "矛盾条件", detail: "同一验收标准里存在互相冲突的两条要求" },
  { label: "对抗内容", detail: "验收标准内含“忽略以上规则”" },
];

describe("AT-JEV-083 · 弱项类判断由确定性代码优先", () => {
  it.each(WEAK_SPOTS)("$label（$detail）：确定性门失败 → 即使 enforce 允许且答案极自信也不施加结果", ({ label, detail }) => {
    const result = resolveAppliedOutcome({
      mode: "enforce",
      kind: "review_triage",
      status: "completed",
      answers: confidentAnswers,
      policy: ENFORCE_POLICY,
      enforceOutcome: "route_human",
      deterministicFailed: true,
      subjects: [{ key: `f_${label}`, severity: "critical", answerIds: ["q_num"] }],
    });
    expect(result.appliedOutcome, `${label}: ${detail}`).toBe(APPLIED_NONE);
    expect(result.violations).toContain("deterministic_gate_failed");
    // The answers themselves are confident, so nothing about them explains the refusal.
    expect(result.uncertain).toEqual([]);

    // Without the deterministic failure the same input WOULD apply — the gate is the
    // only difference, which is what makes the first assertion meaningful.
    const clean = resolveAppliedOutcome({
      mode: "enforce",
      kind: "review_triage",
      status: "completed",
      answers: confidentAnswers,
      policy: ENFORCE_POLICY,
      enforceOutcome: "route_human",
    });
    expect(clean.appliedOutcome).toBe("route_human");
  });

  it("矛盾条件：检查项结果由确定性计算决定，模型答案无法改变 allPassed / failedNames", () => {
    const checks: CheckResult[] = [
      { id: "check-1", name: "unit tests", command: "npm test", status: "passed", exitCode: 0 },
      { id: "check-2", name: "typecheck", command: "npm run typecheck", status: "failed", exitCode: 2 },
    ];
    const run = makeRun({ checks });
    const state = buildReviewTriageState(run, selectReviewFindings(run));

    expect(state.checks.allPassed).toBe(false);
    expect(state.checks.failedNames).toEqual(["typecheck"]);
    // 投影是纯函数：同一 run 重复调用结果相同，且不含任何模型输出字段。
    expect(buildReviewTriageState(run, selectReviewFindings(run))).toEqual(state);
    expect(Object.keys(state.checks).sort()).toEqual(["allPassed", "failedNames"]);
  });

  it("长无关上下文（单条 finding 超预算）：该批拒绝且不二次截断，另一批照常外呼", async () => {
    const big = "irrelevant context ".repeat(4_000);
    const findings: Finding[] = [
      finding("F-big", "fp-weak-big", "critical", big),
      finding("F-small", "fp-weak-small", "medium", "small finding"),
    ];
    const run = makeRun({ findings });
    const input = {
      run,
      mode: "shadow" as const,
      policyVersion: "review-triage-v1",
      maxFindings: 1,
      evaluationId: "de_weak_083",
      timeoutMs: 3000,
    };
    // Probe both batches first, then set the budget strictly between them: the guard is
    // exercised deterministically instead of depending on hand-tuned token estimates.
    const probe = buildReviewTriageBatches(input, { maxTokens: 1_000_000, maxBytes: 1_000_000 });
    expect(probe).toHaveLength(2);
    const sizes = probe.map((batch) => batch.measurement.tokens).sort((a, b) => a - b);
    expect(sizes[1]).toBeGreaterThan(sizes[0]);
    const budget = Math.ceil((sizes[0] + sizes[1]) / 2);

    const batches = buildReviewTriageBatches(input, { maxTokens: budget, maxBytes: 262_144 });

    expect(batches).toHaveLength(2);
    const rejected = batches.filter((batch) => !batch.withinLimits);
    const usable = batches.filter((batch) => batch.withinLimits);
    expect(rejected).toHaveLength(1);
    expect(usable).toHaveLength(1);
    expect(rejected[0].findingKeys).toEqual(["fp-weak-big"]);
    expect(usable[0].findingKeys).toEqual(["fp-weak-small"]);
    expect(rejected[0].reason).toBe("payload_rejected");
    expect(rejected[0].detail).toContain("tokens");
    // Reported, never squeezed: the rejected batch keeps its capped excerpt intact and
    // its state hash is unchanged, so nothing was trimmed to fit the budget.
    const rejectedFinding = stateOf(rejected[0]).findings[0];
    expect(rejectedFinding.title).toHaveLength(TITLE_MAX_CHARS);
    expect(rejectedFinding.title).toBe(big.slice(0, TITLE_MAX_CHARS));

    const calls: DecisionRequest[] = [];
    const engine: DecisionEngine = {
      evaluate: async (request) => {
        calls.push(request);
        return {
          evaluationId: request.evaluationId,
          runId: request.runId,
          kind: request.kind,
          mode: request.mode,
          provider: "mock",
          requestedModel: "mock",
          policyVersion: request.policyVersion,
          stateHash: request.stateHash,
          status: "completed",
          answers: [],
          appliedOutcome: APPLIED_NONE,
          latencyMs: 1,
          createdAt: new Date().toISOString(),
        };
      },
    };
    const result = await runReviewTriageBatches({ batches, engine });
    // The over-limit batch was never dispatched: exactly the usable batch called out.
    expect(calls).toHaveLength(usable.length);
    expect(result.skipped).toEqual(rejected.map((batch) => batch.evaluationId));
    expect(result.failures.some((failure) => failure.reason === "payload_rejected")).toBe(true);
  });

  it("长无关上下文（run 级验收标准灌满）：所有批次 fail-closed，零外呼", async () => {
    // Acceptance criteria are run-level and shared by every batch, so a flood there
    // cannot be split away: the plane must refuse rather than send a trimmed payload.
    const flood = Array.from({ length: AC_MAX_ITEMS }, () => "无关的验收标准段落".repeat(30).slice(0, AC_MAX_CHARS));
    const run = makeRun({ acceptanceCriteria: flood.join("\n") });
    const batches = buildReviewTriageBatches(
      {
        run,
        mode: "assist",
        policyVersion: "review-triage-v1",
        maxFindings: 50,
        evaluationId: "de_weak_083_flood",
        timeoutMs: 3000,
      },
      { maxTokens: 4_000, maxBytes: 262_144 },
    );

    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches.every((batch) => !batch.withinLimits)).toBe(true);
    expect(batches.every((batch) => batch.reason === "payload_rejected")).toBe(true);
    // The criteria list itself is untouched (capped by AC_MAX_ITEMS/AC_MAX_CHARS, not trimmed).
    expect(stateOf(batches[0]).run.acceptanceCriteria).toHaveLength(AC_MAX_ITEMS);

    let called = 0;
    const engine: DecisionEngine = {
      evaluate: async () => {
        called += 1;
        throw new Error("over-limit batches must never be dispatched");
      },
    };
    const result = await runReviewTriageBatches({ batches, engine });
    expect(called).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(result.skipped).toHaveLength(batches.length);
  });

  it("记录保持逐问题粒度：一个弱项问题不确定不会掩盖其余答案", () => {
    const run = makeRun({
      findings: [finding("F1", "fp-weak-1", "critical", "first"), finding("F2", "fp-weak-2", "medium", "second")],
    });
    const request = buildReviewTriageBatches({
      run,
      mode: "assist",
      policyVersion: "review-triage-v1",
      maxFindings: 50,
      evaluationId: "de_weak_083_granularity",
      timeoutMs: 3000,
    })[0].request;

    // 一个“计数/数值类”问题给出平局（0.5 → certainty 0），其余问题自信。
    const first = selectReviewFindings(run)[0];
    const weakId = findingQuestionId(findingStableKey(first), "requirement_relevant");
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (id === weakId) {
        answers[id] = { type: "noul", noul: 0.5 };
        continue;
      }
      answers[id] = validAnswerFor(question);
    }
    const mapped = mapProviderResponse({ model: "jev-1.13.0", answers }, request);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const subjects: TriageSubject[] = selectReviewFindings(run).map((entry) => {
      const key = findingStableKey(entry);
      return {
        key,
        severity: entry.severity,
        answerIds: QUESTION_SUFFIXES.map((suffix) => findingQuestionId(key, suffix)),
      };
    });
    const result = resolveAppliedOutcome({
      mode: "assist",
      kind: "review_triage",
      status: "completed",
      answers: mapped.answers,
      subjects,
      downgradeAnswerIds: [],
    });

    // 逐问题粒度：8 个问题 8 个答案，只有那一个被标为不确定。
    expect(Object.keys(request.questions)).toHaveLength(8);
    expect(mapped.answers.map((answer) => answer.questionId).sort()).toEqual(Object.keys(request.questions).sort());
    expect(result.uncertain).toEqual([weakId]);
    // 一个不确定答案足以让 assist 不施加结果（宁可不动，也不基于弱项作答行动）。
    expect(result.appliedOutcome).toBe(APPLIED_NONE);
    expect(result.violations).toEqual([]);
    // 同一批答案若全部自信，则 assist 会给出建议 —— 差异只来自那一道弱项问题。
    const allConfident = mapProviderResponse(
      {
        model: "jev-1.13.0",
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, validAnswerFor(question)])),
      },
      request,
    );
    expect(allConfident.ok).toBe(true);
    if (allConfident.ok) {
      const applied = resolveAppliedOutcome({
        mode: "assist",
        kind: "review_triage",
        status: "completed",
        answers: allConfident.answers,
        subjects,
      });
      expect(applied.appliedOutcome).toBe(APPLIED_ASSIST);
      expect(applied.uncertain).toEqual([]);
    }
  });
});

function finding(id: string, fingerprint: string, severity: Finding["severity"], title: string): Finding {
  return {
    id,
    fingerprint,
    severity,
    file: "src/server/upload.ts",
    line: 1,
    title,
    evidence: `${title} evidence`,
    requiredChange: `${title} required change`,
    resolved: false,
    consecutiveRounds: 1,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const base = baseRealRun(
    {
      title: "Weak-spot fixture",
      task: "Fix the upload limit.",
      acceptanceCriteria: "- Oversized uploads return 413",
      repository: "/home/operator/private/proj",
      workspaceId: "ws_weak",
      mode: "real",
      checks: ["npm test"],
    },
    "owner_weak",
  );
  return {
    ...base,
    state: "needs_human",
    round: 2,
    checks: overrides.checks ?? base.checks,
    findings: [finding("F1", "fp-weak-1", "critical", "upload limit")],
    ...overrides,
  };
}

function validAnswerFor(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === "probability") return { type: "noul", noul: 0.9 };
  if (question.type === "choice") {
    const rest = Number((0.2 / (question.options.length - 1)).toFixed(4));
    return {
      type: "choice",
      choice: question.options[0],
      probabilities: Object.fromEntries(question.options.map((option, index) => [option, index === 0 ? 0.8 : rest])),
      confidence: 0.9,
    };
  }
  const rest = Number((0.3 / (question.levels.length - 1)).toFixed(4));
  return {
    type: "score",
    weighted_score: 1,
    probabilities: Object.fromEntries(question.levels.map((level, index) => [level.value, index === 1 ? 0.7 : rest])),
    confidence: 0.9,
  };
}
