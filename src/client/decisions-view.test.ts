import { describe, expect, it } from "vitest";
import { t } from "../shared/i18n";
import type { DecisionAuditProjection } from "../shared/decision-audit";
import {
  decisionAnswerView,
  decisionCardView,
  decisionCostDisplay,
  decisionCostLabel,
  decisionEngineNotice,
  decisionKindLabel,
  decisionLatencyLabel,
  decisionManifestLabel,
  decisionManifestSummary,
  decisionModeLabel,
  decisionModelLine,
  decisionStatusMeta,
  decisionTokensLabel,
  formatRatio,
  hashShort,
  truncateId,
} from "./decisions-view";
import { decisionPlaneNotice } from "./ModelsPage";
import type { DecisionEngineStatus } from "./api";

function projection(overrides: Partial<DecisionAuditProjection> = {}): DecisionAuditProjection {
  return {
    evaluationId: "de_1",
    runId: "run_1",
    kind: "review_triage",
    mode: "shadow",
    provider: "typesafe",
    requestedModel: "jev-latest",
    policyVersion: "policy-v1",
    stateHash: "0123456789abcdef0123456789abcdef",
    questionSchemaHash: "fedcba9876543210fedcba9876543210",
    status: "completed",
    answers: [],
    latencyMs: 420,
    createdAt: "2026-01-01T00:00:00.000Z",
    stateManifest: {},
    ...overrides,
  };
}

describe("decisionStatusMeta", () => {
  it("maps every status to a distinct label and a semantic tone", () => {
    const cases = [
      ["completed", "ok"],
      ["fallback", "warn"],
      ["rejected", "error"],
      ["disabled", "muted"],
    ] as const;
    for (const [status, tone] of cases) {
      expect(decisionStatusMeta(status).tone).toBe(tone);
      expect(decisionStatusMeta(status).label).not.toBe("");
    }
    expect(decisionStatusMeta("completed").label).toBe("已完成");
    expect(decisionStatusMeta("fallback", "en").label).toBe("Fallback");
  });
});

describe("decisionModeLabel / decisionKindLabel", () => {
  it("localizes every mode and kind", () => {
    expect(decisionModeLabel("shadow")).toBe("影子（仅记录）");
    expect(decisionModeLabel("enforce", "en")).toBe("Enforce");
    expect(decisionKindLabel("review_triage")).toBe("审核分流");
    expect(decisionKindLabel("review_triage", "en")).toBe("Review triage");
  });
});

describe("decisionModelLine", () => {
  it("omits the arrow when no resolved model was reported", () => {
    const line = decisionModelLine({ requestedModel: "jev-latest" });
    expect(line.text).toBe("jev-latest");
    expect(line.text).not.toContain("→");
    expect(line.resolved).toBeUndefined();
    expect(line.drifted).toBe(false);
  });

  it("shows requested → resolved when the provider reported a version", () => {
    const line = decisionModelLine({ requestedModel: "jev-latest", resolvedModel: "jev-1.13.0" });
    expect(line.text).toBe("jev-latest → jev-1.13.0");
    expect(line.drifted).toBe(true);
  });

  it("does not flag drift when the resolved id equals the requested one", () => {
    const line = decisionModelLine({ requestedModel: "jev-1.13.0", resolvedModel: "jev-1.13.0" });
    expect(line.text).toBe("jev-1.13.0 → jev-1.13.0");
    expect(line.drifted).toBe(false);
  });
});

describe("decisionCostLabel (AT-JEV-062)", () => {
  it("renders the shared unknown wording and never $0 for a missing cost", () => {
    const label = decisionCostLabel({});
    expect(label).toBe("未知");
    expect(label).not.toContain("$");
    expect(decisionCostDisplay({})).toEqual({ kind: "unknown" });
  });

  it("treats a non-finite cost as unknown", () => {
    expect(decisionCostDisplay({ estimatedCostUsd: Number.NaN }).kind).toBe("unknown");
    expect(decisionCostDisplay({ estimatedCostUsd: Number.POSITIVE_INFINITY }).kind).toBe("unknown");
    expect(decisionCostLabel({ estimatedCostUsd: Number.NaN }, "en")).toBe("unknown");
  });

  it("renders an explicit zero as a real price, not as unknown", () => {
    expect(decisionCostDisplay({ estimatedCostUsd: 0 })).toEqual({ kind: "priced", amount: 0 });
    expect(decisionCostLabel({ estimatedCostUsd: 0 })).toBe("$0.0000");
  });

  it("renders a priced cost at 4 decimals", () => {
    expect(decisionCostLabel({ estimatedCostUsd: 0.0042 })).toBe("$0.0042");
  });
});

describe("decisionLatencyLabel / decisionTokensLabel", () => {
  it("renders sub-second latency in ms and longer latency in seconds", () => {
    expect(decisionLatencyLabel(420)).toBe("420 ms");
    expect(decisionLatencyLabel(1234)).toBe("1.2 s");
    expect(decisionLatencyLabel(Number.NaN)).toBe("—");
  });

  it("renders the token line only when a token count is present", () => {
    expect(decisionTokensLabel({})).toBeUndefined();
    expect(decisionTokensLabel({ inputTokens: 900, outputTokens: 120 })).toBe("输入 900 · 输出 120");
    expect(decisionTokensLabel({ inputTokens: 900 })).toBe("输入 900 · 输出 —");
  });
});

describe("decisionAnswerView", () => {
  it("summarizes a probability answer with probability and certainty", () => {
    const view = decisionAnswerView({ questionId: "q1", type: "probability", value: true, probability: 0.87, certainty: 0.74 });
    expect(view.typeLabel).toBe("概率");
    expect(view.value).toBe("true");
    expect(view.metrics).toEqual([
      { label: "P(是)", value: "0.870" },
      { label: "确信度", value: "0.740" },
    ]);
  });

  it("summarizes a choice answer with provider confidence only", () => {
    const view = decisionAnswerView({ questionId: "q2", type: "choice", value: "continue", probabilities: { continue: 0.8 }, confidence: 0.8 });
    expect(view.typeLabel).toBe("单选");
    expect(view.value).toBe("continue");
    expect(view.metrics).toEqual([{ label: "置信度", value: "0.800" }]);
  });

  it("summarizes a score answer with the weighted score and confidence", () => {
    const view = decisionAnswerView({ questionId: "q3", type: "score", value: "medium", weightedScore: 0.6, confidence: 0.7 });
    expect(view.typeLabel).toBe("评分");
    expect(view.metrics).toEqual([
      { label: "加权分", value: "0.600" },
      { label: "置信度", value: "0.700" },
    ]);
  });

  it("renders a missing metric as — rather than a fabricated number", () => {
    const view = decisionAnswerView({ questionId: "q1", type: "probability", value: false });
    expect(view.metrics).toEqual([
      { label: "P(是)", value: "—" },
      { label: "确信度", value: "—" },
    ]);
  });

  it("truncates a long question id but keeps the full value for a tooltip", () => {
    const long = "review.findings.blocking.details.question-01";
    const view = decisionAnswerView({ questionId: long, type: "choice", value: "a" });
    expect(view.fullQuestionId).toBe(long);
    expect(view.questionId).toBe(`${long.slice(0, 24)}…`);
    expect(view.questionId).not.toBe(long);
  });
});

describe("truncateId / hashShort / formatRatio", () => {
  it("keeps short ids verbatim and truncates long ones", () => {
    expect(truncateId("short")).toBe("short");
    expect(truncateId("0123456789", 4)).toBe("0123…");
  });

  it("shortens hashes to the requested prefix", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(hashShort(hash)).toBe("0123456789ab…");
    expect(hashShort(hash, 8)).toBe("01234567…");
    expect(hashShort("abc")).toBe("abc");
  });

  it("formats ratios at 3 decimals and falls back to —", () => {
    expect(formatRatio(0.87)).toBe("0.870");
    expect(formatRatio(undefined)).toBe("—");
    expect(formatRatio(Number.NaN)).toBe("—");
  });
});

describe("decisionManifestSummary / decisionManifestLabel", () => {
  it("surfaces only stable numeric counts, never the manifest body", () => {
    const summary = decisionManifestSummary({
      stateManifest: { questionCount: 3, stateTokens: 128, fields: ["findings", "findings[0].title"], raw: "SECRET_CODE_SNIPPET" },
    });
    expect(summary).toEqual({ questionCount: 3, stateTokens: 128, fieldCount: 2 });
    expect(decisionManifestLabel(summary)).toBe("问题 3 个 · state 估算 128 tokens");
  });

  it("degrades to nothing for an empty or legacy manifest", () => {
    expect(decisionManifestSummary({ stateManifest: {} })).toEqual({});
    expect(decisionManifestLabel({})).toBeUndefined();
  });

  it("ignores a non-numeric manifest value instead of coercing it", () => {
    expect(decisionManifestSummary({ stateManifest: { questionCount: "3" } })).toEqual({});
  });
});

describe("decisionCardView", () => {
  it("composes the full card without ever exposing stateManifest content", () => {
    const card = decisionCardView(
      projection({
        resolvedModel: "jev-1.13.0",
        status: "fallback",
        fallbackReason: "timeout",
        detail: "provider timed out",
        appliedOutcome: "none",
        inputTokens: 900,
        outputTokens: 120,
        answers: [{ questionId: "q1", type: "probability", value: true, probability: 0.9, certainty: 0.8 }],
        stateManifest: { questionCount: 1, stateTokens: 64, raw: "SECRET_CODE_SNIPPET" },
      }),
    );
    expect(card.status).toEqual({ label: "回退", tone: "warn" });
    expect(card.kindLabel).toBe("审核分流");
    expect(card.modeLabel).toBe("影子（仅记录）");
    expect(card.model.text).toBe("jev-latest → jev-1.13.0");
    expect(card.stateHashShort).toBe("0123456789ab…");
    expect(card.questionSchemaHashShort).toBe("fedcba987654…");
    expect(card.latencyLabel).toBe("420 ms");
    expect(card.tokensLabel).toBe("输入 900 · 输出 120");
    expect(card.costLabel).toBe("未知");
    expect(card.costKind).toBe("unknown");
    expect(card.fallbackReason).toBe("timeout");
    expect(card.detail).toBe("provider timed out");
    expect(card.appliedOutcome).toBe("none");
    expect(card.answers).toHaveLength(1);
    expect(card.manifestLabel).toBe("问题 1 个 · state 估算 64 tokens");
    // The raw manifest body must never leak into any rendered field.
    expect(JSON.stringify(card)).not.toContain("SECRET_CODE_SNIPPET");
    expect(JSON.stringify(card)).not.toContain("stateManifest");
  });

  it("omits optional blocks instead of rendering empty placeholders", () => {
    const card = decisionCardView(projection());
    expect(card.model.resolved).toBeUndefined();
    expect(card.fallbackReason).toBeUndefined();
    expect(card.detail).toBeUndefined();
    expect(card.appliedOutcome).toBeUndefined();
    expect(card.tokensLabel).toBeUndefined();
    expect(card.manifestLabel).toBeUndefined();
    expect(card.costLabel).toBe("未知");
  });
});

describe("projection carries no batch field (documented gap)", () => {
  it("has no batch index/count on a real projection", () => {
    // One audit row is one batch, but the server projection deliberately has no
    // batch coordinate; the panel must not invent one.
    const keys = Object.keys(projection());
    expect(keys.filter((key) => /batch/i.test(key))).toEqual([]);
  });
});

describe("decisionEngineNotice (models-page wording parity)", () => {
  const cases: Array<DecisionEngineStatus | undefined> = [
    undefined,
    { engine: "disabled", mode: "off", configured: false, policyVersion: null },
    { engine: "mock", mode: "shadow", configured: false, policyVersion: null },
    { engine: "jev", mode: "shadow", configured: true, policyVersion: "policy-v1" },
  ];

  it("reuses the models page state/hint wording verbatim when not (un)configured", () => {
    for (const status of cases) {
      const notice = decisionEngineNotice(status);
      const models = decisionPlaneNotice(status);
      expect(notice.state).toBe(models.state);
      expect(notice.hint).toBe(models.hint);
      expect(notice.enabled).toBe(models.enabled);
    }
  });

  it("distinguishes enabled-but-unconfigured from disabled", () => {
    const unconfigured = decisionEngineNotice({ engine: "jev", mode: "shadow", configured: false, policyVersion: null });
    expect(unconfigured.health).toBe("unconfigured");
    expect(unconfigured.enabled).toBe(true);
    expect(unconfigured.hint).toBe(t("zh", "provider.credentialMissing"));

    const disabled = decisionEngineNotice({ engine: "mock", mode: "shadow", configured: false, policyVersion: null });
    expect(disabled.health).toBe("disabled");
    expect(disabled.hint).toContain("PI_DECISION_ENGINE=jev");

    const ready = decisionEngineNotice({ engine: "jev", mode: "shadow", configured: true, policyVersion: "v" });
    expect(ready.health).toBe("ready");
    expect(ready.hint).toBe(t("zh", "models.decisionEngineEnabledHint"));
  });
});
