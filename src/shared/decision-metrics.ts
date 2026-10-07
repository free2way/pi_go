/**
 * Decision-plane monitoring read model (docs/26 §16.1).
 *
 * The client mirror of `GET /api/decisions/metrics`. It is deliberately an
 * *aggregate projection*: counts, rates, percentiles, model-alias sets and
 * circuit states only. It never carries a run id, an evaluation id, a
 * credential, the outbound payload or any per-row detail, so it is safe to show
 * on a shared operations dashboard.
 *
 * A `null` means "not computable from the available sample" (e.g. a percentile
 * with zero observations) — it is never a stand-in for a real `0`. The same
 * contract holds on the server (`src/server/decision-engine/metrics.ts`), which
 * imports these types so the two sides cannot drift.
 */

/** Every outcome an evaluation can be persisted with (mirror of `DecisionStatus`). */
export const DECISION_METRIC_STATUSES = ["completed", "fallback", "rejected", "disabled"] as const;

export type DecisionMetricStatus = (typeof DECISION_METRIC_STATUSES)[number];

/**
 * Latency percentiles over the window, computed with the **nearest-rank**
 * method (see `src/server/decision-engine/metrics.ts`): the ⌈p·n⌉-th smallest
 * observed `latencyMs`. Every value is therefore an actually observed sample.
 * `null` (and `samples: 0`) when the window held no latency observation.
 */
export interface DecisionMetricLatency {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  /** Number of latency observations the percentiles were computed from. */
  samples: number;
}

/** One non-closed breaker, surfaced so an operator (and the alert) can name it. */
export interface DecisionMetricCircuitStateEntry {
  /** Credential source identity (e.g. `vault:<userId>` / `env`); never the key. */
  scope: string;
  model: string;
  state: "open" | "half_open";
  authLocked: boolean;
}

/** Circuit-breaker rollup. `open`/`authLocked` are the two alarmable states. */
export interface DecisionMetricCircuits {
  total: number;
  /** Breakers whose `state()` is exactly `open` (a half-open probe is not open). */
  open: number;
  /** Breakers latched by a provider 401/403 (subset of the open ones). */
  authLocked: number;
  /** Breakers granting a single half-open probe (recovery in progress). */
  halfOpen: number;
  /** The non-closed breakers only, so a closed circuit adds no noise. */
  states: DecisionMetricCircuitStateEntry[];
}

export interface DecisionMetrics {
  /** Rows observed inside the window (may be capped — see `truncated`). */
  total: number;
  /** Count per known status; every known status is present (0 when unseen). */
  byStatus: Record<string, number>;
  byFallbackReason: Record<string, number>;
  /**
   * completed / total, or `null` when the window held no rows (0/0 is not 0).
   * The companion `samples` gate lives in the alert decision, not here.
   */
  validResponseRate: number | null;
  /** fallback / total, or `null` when the window held no rows. */
  fallbackRate: number | null;
  latency: DecisionMetricLatency;
  /** requested model alias → sorted, unique set of resolved versions (drift signal). */
  models: Record<string, string[]>;
  circuits: DecisionMetricCircuits;
  /**
   * True when the query hit its row cap, so the aggregates are a lower bound
   * over the newest `limit` rows rather than the whole window.
   */
  truncated: boolean;
}

export interface DecisionMetricsWindow {
  hours: number;
  /** Inclusive lower bound, fixed-width ISO-8601 UTC (same basis as `created_at`). */
  since: string;
  /** Effective row cap for this read. */
  limit: number;
}

/** `GET /api/decisions/metrics` response (read-only, aggregate-only). */
export interface DecisionMetricsResponse {
  schemaVersion: 1;
  /** false when the audit read failed: the rest is an explicit empty/degraded shape. */
  available: boolean;
  /** true when the decision plane is configured to produce evaluations. */
  enabled: boolean;
  window: DecisionMetricsWindow;
  /** Server-side computation timestamp (ISO-8601 UTC). */
  computedAt: string;
  metrics: DecisionMetrics;
}
