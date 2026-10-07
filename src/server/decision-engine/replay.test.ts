import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Finding, Run } from "../../shared/types.js";
import { baseRealRun } from "../real-run.js";
import { APPLIED_ASSIST, APPLIED_NONE, resolveAppliedOutcome, shouldSampleShadow, type TriageSubject } from "./policy.js";
import { questionSchemaHash } from "./redaction.js";
import { buildReviewTriageBatches, findingQuestionId, findingStableKey, QUESTION_SUFFIXES, selectReviewFindings, type ReviewTriageBatch } from "./review-triage.js";
import { mapProviderResponse } from "./response-schema.js";
import type { DecisionAnswer } from "./types.js";

/**
 * AT-JEV-065 · 决策回放（docs/27 §7.7）。
 *
 * 用保存的脱敏 fixture + 相同 policy + 固定 mock 响应重放：本地 policy 必须对同一
 * 输入产生同一 outcome；`stateHash`/`questionSchemaHash` 把出站载荷钉住，投影或问题
 * 模板一旦漂移就失败。第二个反向断言同样重要：**供应商概率本身不要求跨模型版本复现**
 * ——同一“桶”内的概率抖动（含模型版本变化）不得改变 outcome，只有越过政策阈值
 * （certainty 归零 / 分布变平）才允许把答案记为 uncertain。
 *
 * The fixture is synthetic and redacted by construction (no repository, diff content,
 * customer data or key material); the guard at the end of this file keeps it that way.
 */

interface ReplayFixture {
  policyVersion: string;
  provider: { name: string; requestedModel: string };
  run: {
    title: string;
    task: string;
    acceptanceCriteria: string;
    checks: Array<{ name: string; status: "passed" | "failed"; command: string; exitCode: number }>;
    findings: Array<Partial<Finding> & { severity: Finding["severity"] }>;
  };
  expected: {
    questionIds: string[];
    questionSchemaHash: string;
    stateHash: string;
    selectedValues: Record<string, string | boolean>;
    appliedOutcome: string;
    assistAppliedOutcome: string;
    uncertain: string[];
  };
  providerResponse: { model: string; answers: Record<string, unknown>; usage?: Record<string, number> };
  jitter: Array<{
    label: string;
    model?: string;
    answers: Record<string, unknown>;
    expected: { appliedOutcome: string; assistAppliedOutcome: string; uncertain: string[] };
  }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/replay-review-triage.json", import.meta.url), "utf8"),
) as ReplayFixture;

const EVALUATION_ID = "de_replay_065";

function replayRun(): Run {
  const base = baseRealRun(
    {
      title: fixture.run.title,
      task: fixture.run.task,
      acceptanceCriteria: fixture.run.acceptanceCriteria,
      repository: "/home/operator/private/proj",
      workspaceId: "ws_replay",
      mode: "real",
      checks: ["npm test"],
    },
    "owner_replay",
  );
  return {
    ...base,
    state: "needs_human",
    round: 2,
    checks: fixture.run.checks.map((check, index) => ({ id: `check-${index + 1}`, ...check })),
    findings: fixture.run.findings.map((finding, index) => ({
      id: finding.id ?? `F${index + 1}`,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      title: finding.title ?? "",
      evidence: finding.evidence ?? "",
      requiredChange: finding.requiredChange ?? "",
      resolved: finding.resolved ?? false,
      consecutiveRounds: finding.consecutiveRounds ?? 0,
      ...(finding.fingerprint ? { fingerprint: finding.fingerprint } : {}),
    })) as Finding[],
  };
}

function batches(run: Run): ReviewTriageBatch[] {
  return buildReviewTriageBatches({
    run,
    mode: "shadow",
    policyVersion: fixture.policyVersion,
    maxFindings: 50,
    evaluationId: EVALUATION_ID,
    timeoutMs: 3000,
  });
}

/** Maps a (possibly jittered) provider response the way the engine does. */
function replayAnswers(batch: ReviewTriageBatch, override?: { model?: string; answers?: Record<string, unknown> }) {
  const raw = {
    ...fixture.providerResponse,
    ...(override?.model ? { model: override.model } : {}),
    answers: { ...fixture.providerResponse.answers, ...(override?.answers ?? {}) },
  };
  const mapped = mapProviderResponse(raw, batch.request);
  expect(mapped.ok, `fixture response must map: ${mapped.ok ? "" : mapped.detail}`).toBe(true);
  return (mapped as { ok: true; answers: DecisionAnswer[]; model: string }).answers;
}

/** The provider-judged subjects, derived exactly like the builder derives them. */
function subjectsOf(answers: DecisionAnswer[]): TriageSubject[] {
  const answered = new Set(answers.map((answer) => answer.questionId));
  return selectReviewFindings(replayRun()).map((finding) => {
    const key = findingStableKey(finding);
    return {
      key,
      severity: finding.severity,
      answerIds: QUESTION_SUFFIXES.map((suffix) => findingQuestionId(key, suffix)).filter((id) => answered.has(id)),
    };
  });
}

function selectedValuesOf(answers: DecisionAnswer[]): Record<string, string | boolean> {
  return Object.fromEntries(answers.map((answer) => [answer.questionId, answer.value as string | boolean]));
}

describe("AT-JEV-065 · 决策回放", () => {
  it("同一 fixture + 同一 policy 重放出同一出站载荷与同一 outcome", () => {
    const run = replayRun();
    const built = batches(run);
    expect(built).toHaveLength(1);
    expect(built[0].withinLimits).toBe(true);

    const request = built[0].request;
    expect(Object.keys(request.questions).sort()).toEqual([...fixture.expected.questionIds].sort());
    // Pinned payload: the projection and the question templates are the replay target.
    expect(questionSchemaHash(request.questions)).toBe(fixture.expected.questionSchemaHash);
    expect(request.stateHash).toBe(fixture.expected.stateHash);

    const answers = replayAnswers(built[0]);
    expect(selectedValuesOf(answers)).toEqual(fixture.expected.selectedValues);

    const shadow = resolveAppliedOutcome({
      mode: "shadow",
      kind: "review_triage",
      status: "completed",
      answers,
      subjects: subjectsOf(answers),
    });
    expect(shadow.appliedOutcome).toBe(fixture.expected.appliedOutcome);
    expect(shadow.violations).toEqual([]);
    expect(shadow.uncertain.sort()).toEqual([...fixture.expected.uncertain].sort());

    // The same answers under assist are the only difference the mode may make.
    const assist = resolveAppliedOutcome({
      mode: "assist",
      kind: "review_triage",
      status: "completed",
      answers,
      subjects: subjectsOf(answers),
    });
    expect(assist.appliedOutcome).toBe(fixture.expected.assistAppliedOutcome);
    expect(assist.appliedOutcome).toBe(APPLIED_ASSIST);
  });

  it("回放是确定性的：重复执行得到逐字段相同的结果，影子采样也不漂移", () => {
    const first = replayAnswers(batches(replayRun())[0]);
    const second = replayAnswers(batches(replayRun())[0]);
    expect(second).toEqual(first);
    expect(batches(replayRun())[0].request.stateHash).toBe(batches(replayRun())[0].request.stateHash);

    const sample = (rate: number) => Array.from({ length: 5 }, () => shouldSampleShadow(EVALUATION_ID, rate));
    expect(sample(0.5)).toEqual(sample(0.5));
    expect(sample(0.3)).toEqual(sample(0.3));
    // Bounds stay absolute: full/zero rates never sample differently.
    expect(sample(1).every(Boolean)).toBe(true);
    expect(sample(0).some(Boolean)).toBe(false);
  });

  it("供应商概率抖动与模型版本漂移不改变 outcome（桶内不变，越阈值才 uncertain）", () => {
    for (const variant of fixture.jitter) {
      const run = replayRun();
      const batch = batches(run)[0];
      const answers = replayAnswers(batch, { model: variant.model, answers: variant.answers });
      const shadow = resolveAppliedOutcome({
        mode: "shadow",
        kind: "review_triage",
        status: "completed",
        answers,
        subjects: subjectsOf(answers),
      });
      expect(shadow.appliedOutcome, variant.label).toBe(variant.expected.appliedOutcome);
      expect(shadow.uncertain.sort(), variant.label).toEqual([...variant.expected.uncertain].sort());

      const assist = resolveAppliedOutcome({
        mode: "assist",
        kind: "review_triage",
        status: "completed",
        answers,
        subjects: subjectsOf(answers),
      });
      expect(assist.appliedOutcome, variant.label).toBe(variant.expected.assistAppliedOutcome);

      // Ambiguity is never resolved by guessing: no outcome is applied without a
      // deterministic gate failure, and protected severities are untouched.
      if (variant.expected.uncertain.length > 0) {
        expect(assist.appliedOutcome, variant.label).toBe(APPLIED_NONE);
      }
    }
  });

  it("模型版本只被记录，不参与 outcome", () => {
    const batch = batches(replayRun())[0];
    const recorded = mapProviderResponse(fixture.providerResponse, batch.request);
    const drifted = mapProviderResponse({ ...fixture.providerResponse, model: "jev-1.14.0" }, batch.request);
    expect(recorded.ok && drifted.ok).toBe(true);
    expect((recorded as { model: string }).model).toBe(fixture.providerResponse.model);
    expect((drifted as { model: string }).model).toBe("jev-1.14.0");
    expect(selectedValuesOf(replayAnswers(batch))).toEqual(selectedValuesOf(replayAnswers(batch, { model: "jev-1.14.0" })));
  });

  it("fixture 保持脱敏：绝对主机路径与密钥形状不进入载荷", () => {
    const request = batches(replayRun())[0].request;
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("/home/operator");
    expect(serialized).not.toContain("private/proj");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/bearer\s/i);
    // Guard the recording itself, so a future fixture cannot leak a credential.
    const raw = readFileSync(new URL("./fixtures/replay-review-triage.json", import.meta.url), "utf8");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(raw).not.toMatch(/api[_-]?key/i);
  });
});
