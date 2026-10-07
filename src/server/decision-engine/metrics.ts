/**
 * Decision-plane monitoring: pure metrics + alert judgement + the low-frequency
 * sweep driver (docs/26 §16.1; AT-JEV L2 gate).
 *
 * Why this exists: `decision_evaluations` already persists one row per
 * evaluation, and `DecisionAuditStore.aggregate()` can count them, but nothing
 * consumed that in production — there was no p95/p99, no fallback rate, no
 * circuit state and no alerting. This module turns the durable rows into the
 * operational signals an operator needs before the plane may be enabled in
 * `shadow`, and decides which alerts to raise or clear.
 *
 * Layering:
 *   - `computeDecisionMetrics` / `evaluateDecisionAlerts` are PURE: no IO, no
 *     clock, no globals — every branch is unit-testable.
 *   - `createDecisionMetricsSweeper` owns the loop but takes its IO (row read,
 *     circuit snapshot, alert sink, timers, clock) as injected dependencies, so
 *     a test can trigger exactly one sweep without waiting five minutes.
 *
 * Percentiles use the **nearest-rank** definition: for `n` sorted observations
 * the p-quantile is the ⌈p·n⌉-th smallest (1-indexed, clamped into `[1, n]`).
 * Every reported value is therefore an actually observed latency, never an
 * interpolated fabrication; with zero observations the value is `null`, NOT 0.
 */

import type { Alert } from "../alerts.js";
import type {
  DecisionMetricCircuits,
  DecisionMetricLatency,
  DecisionMetrics,
  DecisionMetricsWindow,
} from "../../shared/decision-metrics.js";
import { DECISION_METRIC_STATUSES } from "../../shared/decision-metrics.js";

/** The row projection the metrics need; a full audit record is assignable to it. */
export interface DecisionMetricRow {
  status: string;
  fallbackReason?: string;
  latencyMs: number;
  requestedModel: string;
  resolvedModel?: string;
  createdAt: string;
}

export type DecisionMetricCircuitState = "closed" | "open" | "half_open";

/** The circuit projection the metrics consume; `decisionCircuitSnapshot()` is assignable. */
export interface DecisionMetricCircuit {
  scope: string;
  baseUrl?: string;
  model: string;
  state: DecisionMetricCircuitState;
  authLocked: boolean;
}

/**
 * Effective row cap for one metrics read. The read is deliberately bounded:
 * a full-window scan of a busy table would be an unbounded query. Operationally
 * the newest 5000 evaluations over the window are representative; when the cap
 * is hit, `truncated` is reported so a reader knows the aggregates are a lower
 * bound rather than the whole window.
 */
export const DECISION_METRICS_MAX_ROWS = 5000;

/** Environment knobs (all defaulted; a blank/invalid value falls back). */
export const DECISION_METRICS_ENV = {
  WINDOW_HOURS: "PI_DECISION_METRICS_WINDOW_HOURS",
  INTERVAL_SECONDS: "PI_DECISION_METRICS_INTERVAL_SECONDS",
  ALERT_FALLBACK_RATE: "PI_DECISION_ALERT_FALLBACK_RATE",
  ALERT_VALID_RATE: "PI_DECISION_ALERT_VALID_RATE",
  ALERT_P95_MS: "PI_DECISION_ALERT_P95_MS",
  ALERT_MIN_SAMPLES: "PI_DECISION_ALERT_MIN_SAMPLES",
} as const;

export const DECISION_METRICS_DEFAULTS = {
  windowHours: 24,
  intervalSeconds: 300,
  fallbackRate: 0.2,
  validRate: 0.8,
  p95Ms: 2000,
  minSamples: 20,
} as const;

/** Alert keys owned by the metrics sweep (dedup/cooldown stays in `AlertManager`). */
export const DECISION_ALERT_KEYS = {
  fallbackRate: "decision_fallback_rate",
  validResponseRate: "decision_valid_response_rate",
  p95Latency: "decision_p95_latency",
  circuit: "decision_circuit_open",
} as const;

export interface DecisionAlertThresholds {
  /** fallbackRate strictly ABOVE this (and enough samples) warns. */
  fallbackRate: number;
  /** validResponseRate strictly BELOW this (and enough samples) warns. */
  validResponseRate: number;
  /** p95 strictly ABOVE this many ms (and enough samples) warns. */
  p95Ms: number;
  /** Minimum observations before any rate/latency alert may fire. */
  minSamples: number;
}

export interface DecisionMetricsConfig {
  windowHours: number;
  intervalSeconds: number;
  thresholds: DecisionAlertThresholds;
}

function envRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A strictly positive finite number, else the documented default. */
function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envRaw(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A strictly positive integer, else the documented default. */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = positiveNumber(env, name, fallback);
  return Math.min(Math.floor(value), max);
}

/** A probability in [0, 1]; anything else (including >1 / negative) is the default. */
function probability(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envRaw(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * Resolves the metrics/alert configuration. Absent, blank and invalid values
 * all fall back to the documented default — a mistyped knob can disable an
 * alert's sensitivity, never crash the sweep.
 */
export function resolveDecisionMetricsConfig(env: NodeJS.ProcessEnv): DecisionMetricsConfig {
  return {
    // Cap the window at 30 days so a mistyped value cannot scan a year of rows.
    windowHours: positiveInt(env, DECISION_METRICS_ENV.WINDOW_HOURS, DECISION_METRICS_DEFAULTS.windowHours, 24 * 30),
    intervalSeconds: positiveInt(env, DECISION_METRICS_ENV.INTERVAL_SECONDS, DECISION_METRICS_DEFAULTS.intervalSeconds, 86_400),
    thresholds: {
      fallbackRate: probability(env, DECISION_METRICS_ENV.ALERT_FALLBACK_RATE, DECISION_METRICS_DEFAULTS.fallbackRate),
      validResponseRate: probability(env, DECISION_METRICS_ENV.ALERT_VALID_RATE, DECISION_METRICS_DEFAULTS.validRate),
      p95Ms: positiveNumber(env, DECISION_METRICS_ENV.ALERT_P95_MS, DECISION_METRICS_DEFAULTS.p95Ms),
      minSamples: positiveInt(env, DECISION_METRICS_ENV.ALERT_MIN_SAMPLES, DECISION_METRICS_DEFAULTS.minSamples),
    },
  };
}

/**
 * Nearest-rank percentile over an ALREADY ascending-sorted array: the
 * ⌈p·n⌉-th smallest, clamped into `[1, n]`. `null` for an empty sample (never 0).
 */
export function nearestRankPercentile(sortedAscending: readonly number[], percentile: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const boundedP = Math.min(1, Math.max(0, percentile));
  const rank = Math.min(n, Math.max(1, Math.ceil(boundedP * n)));
  return sortedAscending[rank - 1] ?? null;
}

function latencySummary(latencies: readonly number[]): DecisionMetricLatency {
  if (latencies.length === 0) return { p50: null, p95: null, p99: null, max: null, samples: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: nearestRankPercentile(sorted, 0.5),
    p95: nearestRankPercentile(sorted, 0.95),
    p99: nearestRankPercentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
    samples: sorted.length,
  };
}

export function circuitSummary(circuits: readonly DecisionMetricCircuit[]): DecisionMetricCircuits {
  let open = 0;
  let authLocked = 0;
  let halfOpen = 0;
  const states: DecisionMetricCircuits["states"] = [];
  for (const circuit of circuits) {
    if (circuit.state === "open") open += 1;
    else if (circuit.state === "half_open") halfOpen += 1;
    if (circuit.authLocked) authLocked += 1;
    if (circuit.state === "open" || circuit.state === "half_open") {
      states.push({ scope: circuit.scope, model: circuit.model, state: circuit.state, authLocked: circuit.authLocked });
    }
  }
  return { total: circuits.length, open, authLocked, halfOpen, states };
}

/** An all-zero metrics object — the explicit degraded shape when a read fails. */
export function emptyDecisionMetrics(circuits: readonly DecisionMetricCircuit[] = []): DecisionMetrics {
  const byStatus: Record<string, number> = {};
  for (const status of DECISION_METRIC_STATUSES) byStatus[status] = 0;
  return {
    total: 0,
    byStatus,
    byFallbackReason: {},
    validResponseRate: null,
    fallbackRate: null,
    latency: { p50: null, p95: null, p99: null, max: null, samples: 0 },
    models: {},
    circuits: circuitSummary(circuits),
    truncated: false,
  };
}

/**
 * Aggregates one window of audit rows into the operational metrics. Pure: the
 * same rows + circuits always yield the same result, and nothing is guessed —
 * a rate with no rows is `null`, a percentile with no samples is `null`.
 */
export function computeDecisionMetrics(
  rows: readonly DecisionMetricRow[],
  circuits: readonly DecisionMetricCircuit[],
  options: { truncated?: boolean } = {},
): DecisionMetrics {
  const byStatus: Record<string, number> = {};
  for (const status of DECISION_METRIC_STATUSES) byStatus[status] = 0;
  const byFallbackReason: Record<string, number> = {};
  const modelVersions = new Map<string, Set<string>>();
  const latencies: number[] = [];

  for (const row of rows) {
    const status = typeof row.status === "string" && row.status ? row.status : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const reason = typeof row.fallbackReason === "string" ? row.fallbackReason.trim() : "";
    if (reason) byFallbackReason[reason] = (byFallbackReason[reason] ?? 0) + 1;
    if (Number.isFinite(row.latencyMs) && row.latencyMs >= 0) latencies.push(Math.trunc(row.latencyMs));
    const requested = typeof row.requestedModel === "string" ? row.requestedModel.trim() : "";
    if (requested) {
      const versions = modelVersions.get(requested) ?? new Set<string>();
      const resolved = typeof row.resolvedModel === "string" ? row.resolvedModel.trim() : "";
      if (resolved) versions.add(resolved);
      modelVersions.set(requested, versions);
    }
  }

  const total = rows.length;
  const completed = byStatus.completed ?? 0;
  const fallback = byStatus.fallback ?? 0;
  const models: Record<string, string[]> = {};
  for (const [requested, versions] of [...modelVersions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    models[requested] = [...versions].sort();
  }

  return {
    total,
    byStatus,
    byFallbackReason,
    validResponseRate: total > 0 ? completed / total : null,
    fallbackRate: total > 0 ? fallback / total : null,
    latency: latencySummary(latencies),
    models,
    circuits: circuitSummary(circuits),
    truncated: options.truncated === true,
  };
}

/** What the sweep should do to the alert manager this tick. */
export interface DecisionAlertPlan {
  raise: Alert[];
  clear: string[];
}

/**
 * Decides the alerts for one metrics snapshot. Pure: it neither raises nor
 * clears anything — the caller (the sweep driver) applies the plan.
 *
 * Every thresholded rule additionally requires enough observations
 * (`minSamples`) so a single early failure cannot page anyone. `clear` is
 * returned for each key whose condition is currently normal, so the sweep
 * re-arms it instead of silencing the key forever.
 *
 * Details carry counts/rates/window and, for circuits, the source `scope` and
 * `model` (identifiers only) — never a key, an Authorization header, a run id or
 * any outbound payload.
 */
export function evaluateDecisionAlerts(
  metrics: DecisionMetrics,
  thresholds: DecisionAlertThresholds,
  context: { windowHours: number },
): DecisionAlertPlan {
  const raise: Alert[] = [];
  const clear: string[] = [];
  const windowHours = context.windowHours;
  const total = metrics.total;

  // Fallback rate: warning when it EXCEEDS the budget over enough samples.
  if (metrics.fallbackRate !== null && total >= thresholds.minSamples && metrics.fallbackRate > thresholds.fallbackRate) {
    raise.push({
      key: DECISION_ALERT_KEYS.fallbackRate,
      severity: "warning",
      message: `决策平面回退率偏高：${(metrics.fallbackRate * 100).toFixed(1)}% > 阈值 ${(thresholds.fallbackRate * 100).toFixed(1)}%`,
      details: { rate: metrics.fallbackRate, threshold: thresholds.fallbackRate, samples: total, windowHours },
    });
  } else {
    clear.push(DECISION_ALERT_KEYS.fallbackRate);
  }

  // Valid-response rate: warning when it FALLS BELOW the budget.
  if (metrics.validResponseRate !== null && total >= thresholds.minSamples && metrics.validResponseRate < thresholds.validResponseRate) {
    raise.push({
      key: DECISION_ALERT_KEYS.validResponseRate,
      severity: "warning",
      message: `决策平面有效响应率偏低：${(metrics.validResponseRate * 100).toFixed(1)}% < 阈值 ${(thresholds.validResponseRate * 100).toFixed(1)}%`,
      details: { rate: metrics.validResponseRate, threshold: thresholds.validResponseRate, samples: total, windowHours },
    });
  } else {
    clear.push(DECISION_ALERT_KEYS.validResponseRate);
  }

  // p95 latency: warning when it EXCEEDS the budget over enough latency samples.
  const p95 = metrics.latency.p95;
  if (p95 !== null && metrics.latency.samples >= thresholds.minSamples && p95 > thresholds.p95Ms) {
    raise.push({
      key: DECISION_ALERT_KEYS.p95Latency,
      severity: "warning",
      message: `决策平面 p95 时延超出预算：${p95}ms > ${thresholds.p95Ms}ms`,
      details: { p95Ms: p95, threshold: thresholds.p95Ms, samples: metrics.latency.samples, windowHours },
    });
  } else {
    clear.push(DECISION_ALERT_KEYS.p95Latency);
  }

  // Circuit state: any open or auth-locked breaker is actionable, immediately.
  // (The per-event `jev_authentication_failed` alert still fires on each 401/403;
  // this one is the aggregate dashboard state, deduped by the AlertManager.)
  const { open, authLocked } = metrics.circuits;
  if (open > 0 || authLocked > 0) {
    raise.push({
      key: DECISION_ALERT_KEYS.circuit,
      severity: "critical",
      message: `决策平面熔断：${open} 个打开${authLocked > 0 ? `（其中 ${authLocked} 个凭据锁定）` : ""}`,
      details: {
        open,
        authLocked,
        halfOpen: metrics.circuits.halfOpen,
        total: metrics.circuits.total,
        // Identifiers only (credential-source scope + model), never a key.
        states: metrics.circuits.states,
      },
    });
  } else {
    clear.push(DECISION_ALERT_KEYS.circuit);
  }

  return { raise, clear };
}

/** One sweep's outcome, as returned by `sweep()`. */
export interface DecisionMetricsSweepOutcome {
  metrics: DecisionMetrics;
  window: DecisionMetricsWindow;
  computedAt: string;
  /** Alert keys actually handed to the sink this tick. */
  raised: string[];
  /** Alert keys re-armed this tick (their condition is currently normal). */
  cleared: string[];
}

export interface DecisionMetricsSweeperTimers {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface DecisionMetricsSweeperDeps {
  env: NodeJS.ProcessEnv;
  /**
   * True when the decision plane is configured to produce evaluations. When it
   * is false the sweep returns without a single query or alert (zero overhead
   * for the default `disabled` deployment).
   */
  enabled: () => boolean;
  /** Bounded newest-first read (`DecisionAuditStore.listRecent` is assignable). */
  listRecent: (query: { sinceIso: string; limit: number }) => Promise<readonly DecisionMetricRow[]>;
  /** Read-only circuit snapshot. */
  circuits: () => readonly DecisionMetricCircuit[];
  raise: (alert: Alert) => void;
  clear: (key: string) => void;
  warn?: (message: string, details: Record<string, unknown>) => void;
  now?: () => Date;
  /** Injectable for tests; defaults to the global timers (and they are unref'd). */
  timers?: DecisionMetricsSweeperTimers;
  /** Overrides the env-derived config (tests). */
  config?: DecisionMetricsConfig;
}

export interface DecisionMetricsSweeper {
  /** Runs exactly one sweep. `undefined` when disabled or when the read failed. */
  sweep(): Promise<DecisionMetricsSweepOutcome | undefined>;
  start(): void;
  stop(): void;
}

/**
 * The web-process low-frequency sweep: read the window, compute, then apply the
 * alert plan. It never throws (a failed read is a `warn` + `undefined`, and no
 * alert is raised or cleared from a failed read) and never queries while the
 * plane is disabled.
 */
export function createDecisionMetricsSweeper(deps: DecisionMetricsSweeperDeps): DecisionMetricsSweeper {
  const config = deps.config ?? resolveDecisionMetricsConfig(deps.env);
  const now = deps.now ?? (() => new Date());
  const intervalMs = config.intervalSeconds * 1000;
  let handle: unknown;

  const sweep = async (): Promise<DecisionMetricsSweepOutcome | undefined> => {
    if (!deps.enabled()) return undefined;
    const at = now();
    const sinceIso = new Date(at.getTime() - config.windowHours * 3_600_000).toISOString();
    // Fetch one extra row so "we hit the cap" is observable, not a guess.
    let rows: readonly DecisionMetricRow[];
    try {
      rows = await deps.listRecent({ sinceIso, limit: DECISION_METRICS_MAX_ROWS + 1 });
    } catch (error) {
      deps.warn?.("decision metrics sweep failed; alerts unchanged", {
        error: (error as Error)?.message?.slice(0, 200) ?? String(error),
      });
      return undefined;
    }
    const truncated = rows.length > DECISION_METRICS_MAX_ROWS;
    const bounded = truncated ? rows.slice(0, DECISION_METRICS_MAX_ROWS) : rows;
    const metrics = computeDecisionMetrics(bounded, deps.circuits(), { truncated });
    const plan = evaluateDecisionAlerts(metrics, config.thresholds, { windowHours: config.windowHours });
    for (const key of plan.clear) deps.clear(key);
    const raised: string[] = [];
    for (const alert of plan.raise) {
      deps.raise(alert);
      raised.push(alert.key);
    }
    return {
      metrics,
      window: { hours: config.windowHours, since: sinceIso, limit: DECISION_METRICS_MAX_ROWS },
      computedAt: at.toISOString(),
      raised,
      cleared: plan.clear,
    };
  };

  return {
    sweep,
    start() {
      if (handle !== undefined) return;
      const timers = deps.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
      handle = timers.setInterval(() => {
        void sweep();
      }, intervalMs);
      (handle as { unref?: () => void } | undefined)?.unref?.();
    },
    stop() {
      if (handle === undefined) return;
      const timers = deps.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
      timers.clearInterval(handle);
      handle = undefined;
    },
  };
}

/**
 * One metrics read for the read-only route. Kept separate from the sweep so the
 * route returns a `200` even when the audit read fails: it degrades to
 * `available: false` with an all-zero metrics shape (never a 500) and reports
 * the failure through `warn`.
 */
export async function readDecisionMetrics(input: {
  enabled: boolean;
  windowHours: number;
  listRecent: (query: { sinceIso: string; limit: number }) => Promise<readonly DecisionMetricRow[]>;
  circuits: () => readonly DecisionMetricCircuit[];
  now?: () => Date;
  warn?: (message: string, details: Record<string, unknown>) => void;
}): Promise<{ available: boolean; metrics: DecisionMetrics; window: DecisionMetricsWindow; computedAt: string; enabled: boolean }> {
  const at = (input.now ?? (() => new Date()))();
  const sinceIso = new Date(at.getTime() - input.windowHours * 3_600_000).toISOString();
  let circuits: readonly DecisionMetricCircuit[] = [];
  try {
    circuits = input.circuits();
  } catch {
    circuits = [];
  }
  const window: DecisionMetricsWindow = { hours: input.windowHours, since: sinceIso, limit: DECISION_METRICS_MAX_ROWS };
  if (!input.enabled) {
    // Disabled plane: no query at all. The empty shape still reports the live
    // circuit state so a stale breaker from a previous enablement stays visible.
    return { available: true, metrics: emptyDecisionMetrics(circuits), window, computedAt: at.toISOString(), enabled: false };
  }
  try {
    const rows = await input.listRecent({ sinceIso, limit: DECISION_METRICS_MAX_ROWS + 1 });
    const truncated = rows.length > DECISION_METRICS_MAX_ROWS;
    const bounded = truncated ? rows.slice(0, DECISION_METRICS_MAX_ROWS) : rows;
    return {
      available: true,
      metrics: computeDecisionMetrics(bounded, circuits, { truncated }),
      window,
      computedAt: at.toISOString(),
      enabled: true,
    };
  } catch (error) {
    input.warn?.("decision metrics read failed; serving an empty aggregate", {
      error: (error as Error)?.message?.slice(0, 200) ?? String(error),
    });
    return { available: false, metrics: emptyDecisionMetrics(circuits), window, computedAt: at.toISOString(), enabled: true };
  }
}
