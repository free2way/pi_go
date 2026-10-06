/**
 * Deterministic mock engine (docs/26 §6.2; acceptance §4.1).
 *
 * Answers are a pure function of the question id/prompt/options, so unit,
 * integration and E2E tests are reproducible without a network. A failure mode
 * can be injected (`options.failure`, or `PI_JEV_MOCK_FAILURE` for integration
 * runs) to exercise timeout/429/5xx/contract-invalid paths through the real
 * policy wrapper.
 */

import { canonicalJson, measurePayload, sha256Hex } from "./redaction.js";
import { noulCertainty, type DecisionAnswer, type DecisionEngine, type DecisionEngineConfig, type DecisionEvaluation, type DecisionQuestion, type DecisionRequest, type FallbackReason } from "./types.js";
import type { EngineDeps } from "./disabled.js";

export type MockFailureMode =
  | "none"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "authentication_failed"
  | "contract_invalid";

const FAILURE_MODES: ReadonlyArray<MockFailureMode> = [
  "none",
  "timeout",
  "rate_limited",
  "server_error",
  "authentication_failed",
  "contract_invalid",
];

const FAILURE_REASONS: Record<Exclude<MockFailureMode, "none" | "timeout">, FallbackReason> = {
  rate_limited: "rate_limited",
  server_error: "provider_unavailable",
  authentication_failed: "authentication_failed",
  contract_invalid: "contract_invalid",
};

function resolveFailureMode(explicit: MockFailureMode | undefined): MockFailureMode {
  if (explicit) return explicit;
  const fromEnv = String(process.env.PI_JEV_MOCK_FAILURE ?? "").trim();
  return (FAILURE_MODES as ReadonlyArray<string>).includes(fromEnv) ? (fromEnv as MockFailureMode) : "none";
}

/** Stable 32-bit seed for a question. */
function seedOf(questionId: string, question: DecisionQuestion): number {
  return Number.parseInt(sha256Hex(canonicalJson({ questionId, question })).slice(0, 8), 16);
}

/** Rounds to 4 decimals and forces the values to sum to exactly 1. */
function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return weights.map(() => Number((1 / weights.length).toFixed(4)));
  const raw = weights.map((weight) => weight / total);
  const rounded = raw.map((value) => Math.round(value * 10_000) / 10_000);
  const head = rounded.slice(0, -1);
  const last = Math.round((1 - head.reduce((sum, value) => sum + value, 0)) * 10_000) / 10_000;
  if (last < 0 || last > 1) {
    // Rounding drift only; fall back to the unrounded distribution, re-scaled.
    const fixed = raw.slice(0, -1);
    return [...fixed, 1 - fixed.reduce((sum, value) => sum + value, 0)];
  }
  return [...head, last];
}

function answerFor(questionId: string, question: DecisionQuestion): DecisionAnswer {
  const seed = seedOf(questionId, question);
  if (question.type === "probability") {
    const probability = Math.round((0.15 + ((seed % 1000) / 1000) * 0.7) * 10_000) / 10_000;
    return {
      questionId,
      type: "probability",
      value: probability >= 0.5,
      probability,
      certainty: noulCertainty(probability),
    };
  }
  const confidence = Math.round((0.65 + ((seed % 30) / 100) * 1) * 100) / 100;
  if (question.type === "choice") {
    const weights = question.options.map((_, index) => 1 + (((seed >>> (index % 24)) & 0xff) % 7));
    const normalized = normalizeWeights(weights);
    const probabilities = Object.fromEntries(question.options.map((option, index) => [option, normalized[index]]));
    const value = question.options.reduce((best, option) => (probabilities[option] > probabilities[best] ? option : best), question.options[0]);
    return { questionId, type: "choice", value, probabilities, confidence };
  }
  const levelIndex = seed % question.levels.length;
  const weights = question.levels.map((_, index) => (index === levelIndex ? 6 : 1));
  const normalized = normalizeWeights(weights);
  const probabilities = Object.fromEntries(question.levels.map((level, index) => [level.value, normalized[index]]));
  return {
    questionId,
    type: "score",
    value: question.levels[levelIndex].value,
    weightedScore: levelIndex,
    probabilities,
    confidence,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<"elapsed" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mockFallback(
  request: DecisionRequest,
  config: DecisionEngineConfig,
  now: () => Date,
  reason: FallbackReason,
  detail: string,
): DecisionEvaluation {
  return {
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "mock",
    requestedModel: config.model,
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "fallback",
    answers: [],
    fallbackReason: reason,
    detail,
    latencyMs: 0,
    createdAt: now().toISOString(),
  };
}

/**
 * Deterministic mock engine. Returns schema-valid answers derived from a stable
 * hash of each question, or a deterministic failure when one is injected.
 */
export function createMockEngine(
  config: DecisionEngineConfig,
  options: EngineDeps & { failure?: MockFailureMode } = {},
): DecisionEngine {
  const now = options.now ?? (() => new Date());
  return {
    evaluate: async (request: DecisionRequest, signal?: AbortSignal): Promise<DecisionEvaluation> => {
      const failure = resolveFailureMode(options.failure);
      if (failure === "timeout") {
        const outcome = await delay(config.timeoutMs, signal);
        if (outcome === "aborted") return mockFallback(request, config, now, "aborted", "mock engine aborted");
        return mockFallback(request, config, now, "timeout", "mock engine simulated timeout");
      }
      if (failure !== "none") {
        const reason = FAILURE_REASONS[failure];
        return mockFallback(request, config, now, reason, `mock engine simulated ${failure}`);
      }
      if (signal?.aborted) return mockFallback(request, config, now, "aborted", "mock engine aborted");

      const answers = Object.entries(request.questions).map(([questionId, question]) => answerFor(questionId, question));
      const measurement = measurePayload(request.state, request.questions);
      return {
        evaluationId: request.evaluationId,
        runId: request.runId,
        kind: request.kind,
        mode: request.mode,
        provider: "mock",
        requestedModel: config.model,
        resolvedModel: `mock:${config.model}`,
        policyVersion: request.policyVersion,
        stateHash: request.stateHash,
        status: "completed",
        answers,
        latencyMs: 0,
        inputTokens: measurement.tokens,
        outputTokens: answers.length * 8,
        createdAt: now().toISOString(),
      };
    },
  };
}
