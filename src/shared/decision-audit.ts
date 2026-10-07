/**
 * Decision-audit read model — the client-side mirror of the server's redacted
 * audit projection (docs/26 §8.2).
 *
 * This file is deliberately a *mirror*, not the source of truth: the server
 * keeps its own `DecisionProjection` (`src/server/decision-routes.ts`) and
 * `DecisionAnswer` (`src/server/decision-engine/types.ts`). The two sides are
 * held together by the bidirectional assignability + runtime key-set guard in
 * `src/shared/decision-audit.test.ts`, so a field added, removed, made optional
 * or re-typed on either side fails the suite instead of drifting silently.
 *
 * The shape is a *projection*: it never carries the outbound payload, a
 * credential, the idempotency key or any raw provider body. The client must
 * never expect such a field here.
 */

/** Decision domains (mirror of `DecisionKind`). */
export type DecisionAuditKind = "review_triage" | "human_queue" | "planner_route" | "failure_route" | "ci_risk";

/** How far the decision plane may influence the pipeline (mirror of `DecisionMode`). */
export type DecisionAuditMode = "off" | "shadow" | "assist" | "enforce";

/** Which implementation answered (mirror of `DecisionProvider`). */
export type DecisionAuditProvider = "typesafe" | "disabled" | "mock";

/** Outcome of one evaluation (mirror of `DecisionStatus`). */
export type DecisionAuditStatus = "completed" | "fallback" | "rejected" | "disabled";

/**
 * Standard fallback reasons (mirror of `FALLBACK_REASONS`, docs/26 §15.3).
 * Never free-form, so the union — not an open `string` — is the contract.
 */
export const DECISION_AUDIT_FALLBACK_REASONS = [
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

export type DecisionAuditFallbackReason = (typeof DECISION_AUDIT_FALLBACK_REASONS)[number];

/** Answer kinds the provider can return (mirror of `DecisionAnswer["type"]`). */
export type DecisionAuditAnswerType = "probability" | "choice" | "score";

/** One answer inside a projection (mirror of `DecisionAnswer`). */
export interface DecisionAuditAnswer {
  questionId: string;
  type: DecisionAuditAnswerType;
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

/**
 * Whitelisted, redacted projection of one audit row, exactly as
 * `GET /api/runs/:runId/decisions` returns it (mirror of `DecisionProjection`).
 */
export interface DecisionAuditProjection {
  evaluationId: string;
  runId: string;
  kind: DecisionAuditKind;
  mode: DecisionAuditMode;
  provider: DecisionAuditProvider;
  requestedModel: string;
  /** Versioned id the provider reported; absent when it was never resolved. */
  resolvedModel?: string;
  policyVersion: string;
  stateHash: string;
  questionSchemaHash: string;
  status: DecisionAuditStatus;
  answers: DecisionAuditAnswer[];
  /** What the pipeline actually did with the result; `none` in shadow mode. */
  appliedOutcome?: string;
  fallbackReason?: DecisionAuditFallbackReason;
  /** Human-readable detail for `fallback`/`rejected`; never a key or raw provider body. */
  detail?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Absent (never 0) when a cost cannot be computed reliably (AT-JEV-062). */
  estimatedCostUsd?: number;
  createdAt: string;
  /** Field names, array counts and sizes of the outbound payload — never the payload. */
  stateManifest: Record<string, unknown>;
}
