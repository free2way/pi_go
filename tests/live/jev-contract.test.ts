import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECISION_ENGINE_DEFAULTS } from "../../src/server/decision-engine/config.js";
import { createJevEngine, resetDecisionCircuitBreakers } from "../../src/server/decision-engine/jev.js";
import type { DecisionEngineConfig, DecisionQuestion, DecisionRequest } from "../../src/server/decision-engine/types.js";

/**
 * docs/27 §7.9/§8 · Live Smoke against the official System One API
 * (AT-JEV-080 real minimal call, AT-JEV-081 alias drift observation,
 * AT-JEV-071 latency statistics).
 *
 * This suite spends the provider's quota, so it is opt-in and NEVER part of the
 * normal gate: it runs only with `PI_JEV_LIVE=1` (otherwise the whole describe is
 * skipped, and the main `vitest.config.ts` does not even collect `tests/live`).
 * The state is entirely synthetic — no run, repository or customer data — and the
 * key is read from `TYPESAFE_API_KEY` and never echoed into any output.
 *
 *   PI_JEV_LIVE=1 TYPESAFE_API_KEY=... npx vitest run --config vitest.live.config.ts
 *   PI_JEV_LIVE=1 TYPESAFE_API_KEY=... PI_JEV_LIVE_CALLS=5 npm run test:jev:live
 */

const liveEnabled = process.env.PI_JEV_LIVE === "1";
const suite = liveEnabled ? describe : describe.skip;

/** Synthetic, self-authored state: no run id, repo, diff or customer content. */
const syntheticState = {
  kind: "live_contract_smoke",
  locale: "en",
  message:
    "SYNTHETIC TICKET (no real data): a customer reports a cosmetic typo in the footer of the settings page. " +
    "No data loss, no authentication impact, one-line fix.",
};

const questions: Record<string, DecisionQuestion> = {
  relevant: {
    type: "probability",
    prompt: "Is this report relevant to the current release scope?",
    trueMeaning: "relevant",
    falseMeaning: "not relevant",
  },
  impact: {
    type: "choice",
    prompt: "What is the impact of this report?",
    options: ["none", "minor", "material"],
  },
  priority: {
    type: "score",
    prompt: "How urgent is this report?",
    levels: [
      { value: "p3", description: "low urgency" },
      { value: "p2", description: "moderate urgency" },
      { value: "p1", description: "high urgency" },
    ],
  },
};

function liveConfig(): DecisionEngineConfig {
  return {
    engine: "jev",
    mode: "shadow",
    baseUrl: process.env.PI_JEV_BASE_URL?.trim() || DECISION_ENGINE_DEFAULTS.baseUrl,
    model: process.env.PI_JEV_MODEL?.trim() || DECISION_ENGINE_DEFAULTS.model,
    timeoutMs: Number(process.env.PI_JEV_TIMEOUT_MS ?? "30000") || 30_000,
    maxAttempts: 2,
    maxStateTokens: DECISION_ENGINE_DEFAULTS.maxStateTokens,
    maxStateBytes: DECISION_ENGINE_DEFAULTS.maxStateBytes,
    reviewMaxFindings: 50,
    shadowSampleRate: 1,
    policyVersion: "live-contract-v1",
    allowSource: false,
    hasApiKey: true,
  };
}

function plannedCalls(): number {
  const raw = Number(process.env.PI_JEV_LIVE_CALLS ?? "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(50, Math.floor(raw));
}

/** Nearest-rank percentile over an ascending array. */
function percentile(ascending: number[], p: number): number {
  if (ascending.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank - 1))];
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();

suite("Jev live contract smoke", () => {
  beforeAll(() => {
    if (!apiKey) {
      throw new Error(
        "PI_JEV_LIVE=1 requires TYPESAFE_API_KEY (or PI_JEV_BASE_URL+key) to call the official System One API. " +
          "Export a key (never commit it) or unset PI_JEV_LIVE to skip this live suite.",
      );
    }
    resetDecisionCircuitBreakers();
  });

  afterAll(() => {
    resetDecisionCircuitBreakers();
  });

  it("returns a completed, schema-valid evaluation with a resolved model and usage", async () => {
    const config = liveConfig();
    const engine = createJevEngine(config);
    const calls = plannedCalls();
    const latencies: number[] = [];
    const resolvedModels = new Set<string>();
    const observations: Array<{ call: number; resolvedModel: string; latencyMs: number }> = [];

    for (let index = 0; index < calls; index += 1) {
      const request: DecisionRequest = {
        evaluationId: `de_live_${index}`,
        runId: `live_smoke_${index}`,
        kind: "review_triage",
        mode: "shadow",
        policyVersion: config.policyVersion,
        stateHash: "synthetic-state-hash",
        state: syntheticState,
        questions,
        timeoutMs: config.timeoutMs,
      };

      const evaluation = await engine.evaluate(request);

      // A live failure is not a flaky test to hide: surface the fallback reason
      // (never the key) so an operator can act on it. The reason is repeated in
      // the message because vitest truncates the compared object.
      expect(
        { status: evaluation.status, fallbackReason: evaluation.fallbackReason, detail: evaluation.detail, resolvedModel: evaluation.resolvedModel },
        `live call ${index} did not complete: status=${evaluation.status} reason=${evaluation.fallbackReason ?? "-"} detail=${evaluation.detail ?? "-"} (401 => the key is wrong/revoked; a network error => this host cannot reach ${config.baseUrl})`,
      ).toMatchObject({ status: "completed" });

      expect(evaluation.provider).toBe("typesafe");
      expect(evaluation.requestedModel).toBe(config.model);
      expect(evaluation.resolvedModel).toBeTruthy();
      expect(evaluation.answers).toHaveLength(3);
      expect(evaluation.inputTokens ?? 0).toBeGreaterThan(0);

      // Each fixed question got exactly one typed answer (AT-JEV-010/011/012).
      const byId = Object.fromEntries(evaluation.answers.map((answer) => [answer.questionId, answer]));
      expect(Object.keys(byId).sort()).toEqual(["impact", "priority", "relevant"]);
      expect(byId.relevant.type).toBe("probability");
      expect(byId.impact.type).toBe("choice");
      expect(byId.priority.type).toBe("score");
      expect(typeof byId.relevant.value).toBe("boolean");
      expect(byId.impact.probabilities).toBeDefined();
      expect(byId.priority.probabilities).toBeDefined();

      latencies.push(evaluation.latencyMs);
      resolvedModels.add(evaluation.resolvedModel ?? "");
      observations.push({ call: index, resolvedModel: evaluation.resolvedModel ?? "", latencyMs: evaluation.latencyMs });

      // AT-JEV-050: the key must not appear anywhere in the result.
      expect(JSON.stringify(evaluation)).not.toContain(apiKey);
    }

    const ascending = [...latencies].sort((a, b) => a - b);
    // AT-JEV-071: record the latency distribution, not just the last sample.
    console.log(
      `[jev-live] calls=${calls} latencyMs min=${ascending[0]} p50=${percentile(ascending, 50)} p95=${percentile(ascending, 95)} max=${ascending[ascending.length - 1]}`,
    );
    // AT-JEV-081: log the resolved model(s) so alias drift (`jev-latest` →
    // a new version) is observable in the run output.
    console.log(`[jev-live] requested=${config.model} resolved=${[...resolvedModels].join(",")}`);
    for (const observation of observations) {
      console.log(`[jev-live] call=${observation.call} resolved=${observation.resolvedModel} latencyMs=${observation.latencyMs}`);
    }

    expect(ascending[0]).toBeGreaterThanOrEqual(0);
    expect([...resolvedModels].every((model) => model.length > 0)).toBe(true);
  });
});
