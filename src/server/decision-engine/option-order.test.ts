import { describe, expect, it } from "vitest";
import { DEFAULT_DECISION_POLICY, effectiveMode, isUncertain, resolveAppliedOutcome } from "./policy.js";
import { questionSchemaHash } from "./redaction.js";
import { buildReviewTriageQuestions, RETRY_VALUE_LEVELS } from "./review-triage.js";
import { mapProviderResponse } from "./response-schema.js";
import type { DecisionQuestion, DecisionRequest } from "./types.js";

/**
 * AT-JEV-082 · 选项顺序敏感性（docs/27 §7.7）。
 *
 * 这里只覆盖**我方半边**：评估报告里可能出现的“顺序敏感性”不能由我们的映射或政策引入。
 *  1. 名称键的回答（`choice` + 按选项名给出的分布）与呈现顺序无关——同一语义分布在任意
 *     选项顺序下映射出同一个 value，政策结果也相同；
 *  2. 位置键的回答（线上 score 的 `"0","1",…` + `legend` 形式）必须按**请求里的等级顺序**
 *     翻译，顺序换了语义就换——这正是唯一一个顺序真正有语义的地方，必须被显式处理；
 *  3. 不确定性/分布展开的判定只看取值，不看位置；
 *  4. 预期的第二条“若变化超过约定阈值，不得将该 policy 用于 enforce”在本地是可强制的：
 *     阈值尚未约定、顺序敏感性也尚未测量，因此 enforce 必须保持关闭（默认既不 allowlist
 *     任何 kind，也会把 enforce 降级为 assist）。
 *
 * 诚实边界：供应商侧“同一问题换顺序后分布变化多少”只能在真 key 评估里测（AT-JEV-071 类），
 * 本文件不声称该测量与阈值口径已定。
 */

function request(questions: Record<string, DecisionQuestion>): DecisionRequest {
  return {
    evaluationId: "de_order_082",
    runId: "run_order_082",
    kind: "review_triage",
    mode: "shadow",
    policyVersion: "review-triage-v1",
    stateHash: "0".repeat(64),
    state: { findings: [] },
    questions,
    timeoutMs: 3000,
  };
}

const OPTIONS = ["none", "possible", "material"] as const;
const LEVELS = ["none", "low", "medium", "high"] as const;

describe("AT-JEV-082 · 选项顺序敏感性（我方半边）", () => {
  it("名称键的回答与选项顺序无关：同一语义分布 → 同一 value、同一政策结果", () => {
    const questionFor = (order: readonly string[]): DecisionQuestion => ({
      type: "choice",
      prompt: "What is the potential security impact of this finding?",
      options: [...order],
    });
    const distribution = { none: 0.02, possible: 0.18, material: 0.8 };
    const answer = { type: "choice", choice: "material", probabilities: distribution, confidence: 0.88 };

    const forward = request({ q: questionFor(OPTIONS) });
    const reversed = request({ q: questionFor([...OPTIONS].reverse()) });
    const shuffled = request({ q: questionFor(["material", "none", "possible"]) });

    const mapped = [forward, reversed, shuffled].map((req) => mapProviderResponse({ model: "m", answers: { q: answer } }, req));
    expect(mapped.every((result) => result.ok)).toBe(true);
    for (const result of mapped) {
      if (!result.ok) return;
      const [mapped_answer] = result.answers;
      expect(mapped_answer.value).toBe("material");
      expect(mapped_answer.probabilities).toEqual(distribution);
      // 政策只看取值：同一答案在三种顺序下的结论完全一致。
      const outcome = resolveAppliedOutcome({
        mode: "assist",
        kind: "review_triage",
        status: "completed",
        answers: result.answers,
      });
      expect(outcome).toEqual({ appliedOutcome: "assist_suggestion", uncertain: [], violations: [] });
      expect(isUncertain(mapped_answer)).toBe(false);
    }
    // 顺序确实改变了问题 schema（options 参与 hash）：所以“同 policy 不同顺序”在报告里
    // 必须作为不同的呈现对待，而不是被悄悄归一化。
    expect(questionSchemaHash(forward.questions)).not.toBe(questionSchemaHash(reversed.questions));
  });

  it("位置键的回答按请求的等级顺序翻译（换了顺序语义就换）", () => {
    const positional = {
      type: "score",
      weighted_score: 3,
      probabilities: { "0": 0.02, "1": 0.08, "2": 0.15, "3": 0.75 },
      legend: { "0": "none", "1": "low", "2": "medium", "3": "high" },
      confidence: 0.84,
    };
    const levelsFor = (order: readonly string[]): DecisionQuestion => ({
      type: "score",
      prompt: "What is the expected value of continuing automated repair for this finding?",
      levels: order.map((value) => ({ value, description: value })),
    });

    const ascending = mapProviderResponse(
      { model: "m", answers: { q: positional } },
      request({ q: levelsFor(LEVELS) }),
    );
    expect(ascending.ok).toBe(true);
    if (ascending.ok) {
      expect(ascending.answers[0].value).toBe("high");
      expect(ascending.answers[0].weightedScore).toBe(3);
    }

    // Same positional payload, reversed level order: position 3 is now "none".
    const descending = mapProviderResponse(
      { model: "m", answers: { q: positional } },
      request({ q: levelsFor([...LEVELS].reverse()) }),
    );
    expect(descending.ok).toBe(true);
    if (descending.ok) {
      expect(descending.answers[0].value).toBe("none");
      expect(descending.answers[0].weightedScore).toBe(3);
    }

    // `weighted_score` is positional by definition (`levels[clamp(weighted_score)]`), so a
    // literal-name distribution does NOT change the chosen value: with our ascending
    // order position 3 is "high", and a hypothetical descending order would invert it.
    // The invariant that protects us is that the production template is low→high ordered.
    const literal = { ...positional, probabilities: { none: 0.02, low: 0.08, medium: 0.15, high: 0.75 } };
    const ascendingLiteral = mapProviderResponse({ model: "m", answers: { q: literal } }, request({ q: levelsFor(LEVELS) }));
    expect(ascendingLiteral.ok).toBe(true);
    if (ascendingLiteral.ok) {
      expect(ascendingLiteral.answers[0].value).toBe("high");
      expect(ascendingLiteral.answers[0].probabilities).toEqual({ none: 0.02, low: 0.08, medium: 0.15, high: 0.75 });
    }
    const reversedLiteral = mapProviderResponse(
      { model: "m", answers: { q: literal } },
      request({ q: levelsFor([...LEVELS].reverse()) }),
    );
    expect(reversedLiteral.ok).toBe(true);
    if (reversedLiteral.ok) expect(reversedLiteral.answers[0].value).toBe("none");

    // Production guard for the coupling above: the shipped template is ordered low→high,
    // and every generated score question preserves that order.
    const levels = RETRY_VALUE_LEVELS.map((level) => level.value);
    expect(levels).toEqual(["none", "low", "medium", "high"]);
    const built = buildReviewTriageQuestions([{ id: "F1", fingerprint: "fp-order-1", severity: "high", file: null, line: null, title: "t", evidence: "e", requiredChange: "r", resolved: false, consecutiveRounds: 1 } as never]);
    const scoreQuestion = Object.values(built).find((question) => question.type === "score");
    expect(scoreQuestion && scoreQuestion.type === "score" ? scoreQuestion.levels.map((level) => level.value) : []).toEqual(levels);
  });

  it("不确定性判定只看取值分布，不看选项位置", () => {
    const flat = { none: 0.34, possible: 0.33, material: 0.33 };
    const peaked = { none: 0.02, possible: 0.18, material: 0.8 };
    const answerOf = (probabilities: Record<string, number>) =>
      ({ questionId: "q", type: "choice" as const, value: "material", probabilities, confidence: 0.9 });

    expect(isUncertain(answerOf(flat))).toBe(true);
    expect(isUncertain(answerOf(peaked))).toBe(false);
    // 同一分布、键序不同的对象：判定结果不变。
    expect(isUncertain({ ...answerOf(peaked), probabilities: { material: 0.8, none: 0.02, possible: 0.18 } })).toBe(false);
  });

  it("阈值未约定前 enforce 保持关闭：默认不 allowlist 任何 kind，且 enforce 被降级为 assist", () => {
    expect(DEFAULT_DECISION_POLICY.enforceKinds).toEqual([]);
    expect(effectiveMode({ requestedMode: "enforce", kind: "review_triage" })).toBe("assist");
    const outcome = resolveAppliedOutcome({
      mode: "enforce",
      kind: "review_triage",
      status: "completed",
      answers: [{ questionId: "q", type: "choice", value: "material", probabilities: { none: 0.02, possible: 0.18, material: 0.8 }, confidence: 0.9 }],
      enforceOutcome: "route_human",
    });
    // 未 allowlist → 只能给建议，不能施加；报告里必须记录为 assist 语义。
    expect(outcome.appliedOutcome).toBe("assist_suggestion");
    expect(outcome.violations).toEqual([]);
  });
});
