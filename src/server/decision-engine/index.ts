/**
 * Decision-plane entry point (docs/26 §6.2/§7).
 *
 * `loadDecisionEngineConfig` is strict env parsing; `createDecisionEngine`
 * composes a concrete engine (disabled / mock / jev) with the pure policy layer,
 * which is the only thing allowed to decide whether an outcome applies. The
 * configured mode is a hard ceiling: a request can never escalate above it, and
 * `off` never reaches a provider.
 */

import { createDisabledEngine, buildDisabledEvaluation, type EngineDeps } from "./disabled.js";
import { createJevEngine } from "./jev.js";
import { createMockEngine } from "./mock.js";
import { createDecisionPolicy, planDecision, resolveAppliedOutcome, shouldSampleShadow } from "./policy.js";
import type { DecisionEngine, DecisionEngineConfig, DecisionEvaluation, DecisionRequest } from "./types.js";

export { loadDecisionEngineConfig, DECISION_ENGINE_DEFAULTS, decisionEngineEnvSchema } from "./config.js";
export type { LoadDecisionEngineConfigResult, DecisiveEngine } from "./config.js";
export * from "./types.js";
export { buildReviewTriageRequest, buildReviewTriageBatches, runReviewTriageBatches } from "./review-triage.js";
export type { ReviewTriageInput, ReviewTriageBatch, ReviewTriageRunResult } from "./review-triage.js";

export interface DecisionEngineDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Wraps a concrete engine with the policy layer. It performs the mode gating
 * (and shadow sampling) before any provider call, and stamps the only outcome
 * the pipeline may apply onto the returned evaluation.
 */
export function createPolicyEngine(inner: DecisionEngine, config: DecisionEngineConfig, deps: DecisionEngineDeps = {}): DecisionEngine {
  const now = deps.now ?? (() => new Date());
  const policy = createDecisionPolicy({ version: config.policyVersion });
  return {
    evaluate: async (request: DecisionRequest, signal?: AbortSignal): Promise<DecisionEvaluation> => {
      const plan = planDecision({
        requestedMode: request.mode,
        configuredMode: config.mode,
        kind: request.kind,
        policy,
      });
      if (plan.action === "skip") {
        return buildDisabledEvaluation({ ...request, mode: plan.mode }, config, now, plan.detail);
      }
      if (plan.mode === "shadow" && !shouldSampleShadow(request.evaluationId, config.shadowSampleRate)) {
        return buildDisabledEvaluation({ ...request, mode: plan.mode }, config, now, "shadow sample excluded this evaluation");
      }

      const evaluation = await inner.evaluate(request, signal);
      const outcome = resolveAppliedOutcome({
        mode: plan.mode,
        kind: request.kind,
        status: evaluation.status,
        answers: evaluation.answers,
        policy,
        // Deterministic gates live in the caller; the engine's own view has none
        // to report, and the caller re-applies the hard rules before acting.
        deterministicFailed: false,
      });
      return { ...evaluation, mode: plan.mode, appliedOutcome: outcome.appliedOutcome };
    },
  };
}

/**
 * Creates the configured decision engine. Never performs I/O unless the engine
 * is `jev`/`mock` AND the effective mode is not `off`.
 */
export function createDecisionEngine(config: DecisionEngineConfig, deps: DecisionEngineDeps = {}): DecisionEngine {
  const engineDeps: EngineDeps = deps.now ? { now: deps.now } : {};
  const base =
    config.engine === "disabled"
      ? createDisabledEngine(config, engineDeps)
      : config.engine === "mock"
        ? createMockEngine(config, engineDeps)
        : createJevEngine(config, { ...engineDeps, fetchImpl: deps.fetchImpl });
  return createPolicyEngine(base, config, deps);
}
