/**
 * Default engine: `disabled` (docs/26 §6.2/§11).
 *
 * It performs no I/O whatsoever — no fetch, no timers, no env reads — and always
 * returns the structured `disabled` result so the caller can keep its existing
 * flow. This is the engine behind `PI_DECISION_ENGINE=disabled` and behind every
 * mode-gated skip.
 */

import type { DecisionEngine, DecisionEngineConfig, DecisionEvaluation, DecisionRequest } from "./types.js";

export interface EngineDeps {
  now?: () => Date;
}

/** Builds the canonical `disabled` evaluation for a request. */
export function buildDisabledEvaluation(
  request: DecisionRequest,
  config: DecisionEngineConfig,
  now: () => Date = () => new Date(),
  detail = "decision engine disabled",
): DecisionEvaluation {
  return {
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "disabled",
    requestedModel: config.model,
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "disabled",
    answers: [],
    fallbackReason: "disabled",
    detail,
    latencyMs: 0,
    createdAt: now().toISOString(),
  };
}

/** Creates the no-I/O disabled engine. */
export function createDisabledEngine(config: DecisionEngineConfig, deps: EngineDeps = {}): DecisionEngine {
  const now = deps.now ?? (() => new Date());
  return {
    evaluate: async (request: DecisionRequest) => buildDisabledEvaluation(request, config, now),
  };
}
