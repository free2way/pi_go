/**
 * Decision-plane domain types (docs/26 · Jev 决策引擎; provider-agnostic).
 *
 * Nothing outside `src/server/decision-engine/**` (and the audit/route layer)
 * may depend on the TypeSafe response shape: business callers only ever see
 * these types. Two corrections over the draft design are baked in here:
 *
 *  - `score` is an ORDERED LEVEL list (Jev returns a probability-weighted value
 *    across levels plus a `legend` and a distribution), not `{value,weight}`;
 *  - `noul` (yes/no) has NO provider confidence — callers must derive certainty
 *    from the probability's distance to 0.5 (see `noulCertainty`).
 *
 * Payload limits are expressed in TOKENS (the provider's real budget is 64k per
 * request and 32k for `state` + the longest question), not bytes.
 */

/** How far the decision plane may influence the pipeline. */
export type DecisionMode = "off" | "shadow" | "assist" | "enforce";

/** Decision domains. `enforce` is opted in per kind, never globally. */
export type DecisionKind = "review_triage" | "human_queue" | "planner_route" | "failure_route" | "ci_risk";

/** Which implementation answered (audited on every evaluation). */
export type DecisionProvider = "typesafe" | "disabled" | "mock";

export type DecisionStatus = "completed" | "fallback" | "rejected" | "disabled";

/** Standard fallback reasons (docs/26 §15.3). Never free-form. */
export const FALLBACK_REASONS = [
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
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/**
 * A question as the decision plane states it. The provider mapping lives in
 * `jev.ts` only:
 *   probability → Noul       choice → Choice       score → Score (ordered levels)
 */
export type DecisionQuestion =
  | { type: "probability"; prompt: string; trueMeaning?: string; falseMeaning?: string }
  | { type: "choice"; prompt: string; options: string[] }
  | {
      type: "score";
      prompt: string;
      /** Ordered levels, low → high (Jev: 2..10 levels). */
      levels: Array<{ value: string; description: string }>;
    };

export interface DecisionRequest {
  evaluationId: string;
  runId: string;
  kind: DecisionKind;
  mode: DecisionMode;
  policyVersion: string;
  /** SHA-256 over the canonical, already-redacted state. */
  stateHash: string;
  /** Redacted, allowlisted projection — never the raw run/repository content. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  timeoutMs: number;
}

export interface DecisionAnswer {
  questionId: string;
  type: "probability" | "choice" | "score";
  /** probability: boolean at p≥0.5; choice: the option; score: level value nearest the weighted score. */
  value: boolean | string;
  /** probability only: P(yes). */
  probability?: number;
  /** choice/score: distribution over options/levels (sums to ~1). */
  probabilities?: Record<string, number>;
  /** score only: the probability-weighted value across the ordered levels. */
  weightedScore?: number;
  /** choice/score only (Noul has none): provider confidence 0..1. */
  confidence?: number;
  /** Derived certainty for probability answers: |p − 0.5| · 2 (0..1). */
  certainty?: number;
}

export interface DecisionEvaluation {
  evaluationId: string;
  runId: string;
  kind: DecisionKind;
  mode: DecisionMode;
  provider: DecisionProvider;
  requestedModel: string;
  /** Versioned id the provider reported (e.g. `jev-1.13.0`); alias drift is visible. */
  resolvedModel?: string;
  policyVersion: string;
  stateHash: string;
  status: DecisionStatus;
  answers: DecisionAnswer[];
  /** What the pipeline actually did with the result; `none` in shadow mode. */
  appliedOutcome?: string;
  fallbackReason?: FallbackReason;
  /** Human-readable detail for `fallback`/`rejected`; never contains a key or raw provider body. */
  detail?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  createdAt: string;
}

/** Durable audit row (`decision_evaluations`); the UI/query API reads only this. */
export interface DecisionEvaluationRecord extends DecisionEvaluation {
  /** Field names, counts and sizes of the outbound payload — never the payload. */
  stateManifest: Record<string, unknown>;
  questionSchemaHash: string;
  /** Immutable key for idempotent writes. */
  idempotencyKey: string;
}

export interface DecisionEngine {
  evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionEvaluation>;
}

/** Strictly validated configuration; invalid config must never degrade to a宽松 default. */
export interface DecisionEngineConfig {
  engine: "disabled" | "mock" | "jev";
  mode: DecisionMode;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  /** state + longest question budget (provider: 32k); conservative default. */
  maxStateTokens: number;
  /** Secondary hard guard on the serialized payload. */
  maxStateBytes: number;
  reviewMaxFindings: number;
  shadowSampleRate: number;
  policyVersion: string;
  allowSource: boolean;
  hasApiKey: boolean;
}

/**
 * Certainty of a Noul answer, derived locally because the provider returns only
 * the probability: 0 at p=0.5, 1 at p∈{0,1}.
 */
export function noulCertainty(probability: number): number {
  if (!Number.isFinite(probability)) return 0;
  const bounded = Math.min(1, Math.max(0, probability));
  return Math.abs(bounded - 0.5) * 2;
}
