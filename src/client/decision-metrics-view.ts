/**
 * Decision-plane monitoring — client view helpers (docs/26 §16.1).
 *
 * The 「系统状态」 card stays a thin presentational shell; every mapping from the
 * `GET /api/decisions/metrics` response to a label/tone/row is a pure function
 * here, so it is unit-testable without a DOM harness (the repo has no
 * jsdom/testing-library setup, matching `decisions-view.ts` / `budget-roles-view.ts`).
 *
 * Two rules are load-bearing:
 *
 *  - A `null` metric means "not computable from the sample" and renders as the
 *    shared "unknown" wording — NEVER as `0` / `0%`.
 *  - Threshold judgements live on the SERVER (`PI_DECISION_ALERT_*`), so the
 *    client never re-derives an alert tone from a hard-coded threshold it could
 *    disagree with. It only surfaces the empty states (plane disabled / no rows /
 *    read degraded) and the circuit/alias facts the server reported.
 */

import {
  DEFAULT_LOCALE,
  t,
  type Locale,
  type MessageKey,
} from "../shared/i18n";
import type { DecisionMetricCircuits, DecisionMetrics } from "../shared/decision-metrics";
import type { DecisionMetricsResponse } from "./api";

export type DecisionMetricsTone = "ok" | "warn" | "error" | "muted";

export const DECISION_CIRCUIT_STATE_KEYS: Record<"closed" | "open" | "half_open", MessageKey> = {
  closed: "decisions.metrics.circuit.closed",
  open: "decisions.metrics.circuit.open",
  half_open: "decisions.metrics.circuit.halfOpen",
};

/** A rate as a percentage; `null`/non-finite is the explicit unknown wording. */
export function formatMetricRate(value: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t(locale, "decisions.metrics.unknown");
  return `${(value * 100).toFixed(1)}%`;
}

/** A millisecond value; `null`/non-finite is the explicit unknown wording. */
export function formatMetricMillis(value: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t(locale, "decisions.metrics.unknown");
  return `${Math.round(value)} ms`;
}

export interface DecisionMetricRow {
  key: string;
  label: string;
  value: string;
  /** The value is unknown (source metric was null) — rendered muted, never as 0. */
  muted: boolean;
}

/** The headline rows of the metrics card, in a stable order. */
export function decisionMetricsRows(metrics: DecisionMetrics, locale: Locale = DEFAULT_LOCALE): DecisionMetricRow[] {
  const rows: DecisionMetricRow[] = [
    { key: "total", label: t(locale, "decisions.metrics.total"), value: String(metrics.total), muted: false },
    { key: "samples", label: t(locale, "decisions.metrics.samples"), value: String(metrics.latency.samples), muted: false },
    { key: "validRate", label: t(locale, "decisions.metrics.validRate"), value: formatMetricRate(metrics.validResponseRate, locale), muted: metrics.validResponseRate === null },
    { key: "fallbackRate", label: t(locale, "decisions.metrics.fallbackRate"), value: formatMetricRate(metrics.fallbackRate, locale), muted: metrics.fallbackRate === null },
    { key: "p50", label: t(locale, "decisions.metrics.p50"), value: formatMetricMillis(metrics.latency.p50, locale), muted: metrics.latency.p50 === null },
    { key: "p95", label: t(locale, "decisions.metrics.p95"), value: formatMetricMillis(metrics.latency.p95, locale), muted: metrics.latency.p95 === null },
    { key: "p99", label: t(locale, "decisions.metrics.p99"), value: formatMetricMillis(metrics.latency.p99, locale), muted: metrics.latency.p99 === null },
    { key: "max", label: t(locale, "decisions.metrics.max"), value: formatMetricMillis(metrics.latency.max, locale), muted: metrics.latency.max === null },
  ];
  return rows;
}

/**
 * The card's empty state, or `null` when there is data to show. Order matters:
 * a degraded read is reported before "disabled", which is reported before the
 * genuinely empty window.
 */
export function decisionMetricsNotice(response: DecisionMetricsResponse, locale: Locale = DEFAULT_LOCALE): string | null {
  if (!response.available) return t(locale, "decisions.metrics.state.unavailable");
  if (!response.enabled) return t(locale, "decisions.metrics.state.disabled");
  if (response.metrics.total === 0) return t(locale, "decisions.metrics.state.noData");
  return null;
}

/** `最近 24 小时 · 自 2026-10-06 00:00` — the window the aggregate covers. */
export function decisionMetricsWindowLabel(response: DecisionMetricsResponse, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, "decisions.metrics.windowValue", {
    hours: response.window.hours,
    since: response.window.since,
  });
}

export interface DecisionModelAliasRow {
  key: string;
  requested: string;
  resolved: string[];
  /** The alias resolved to more than one version inside the window (drift). */
  drifted: boolean;
  label: string;
  tone: DecisionMetricsTone;
}

/**
 * requested alias → resolved version set, sorted by alias. More than one
 * resolved version is the alias-drift signal (the same one `jev_model_drift`
 * warns about per evaluation, shown here as a window aggregate).
 */
export function decisionModelAliasRows(models: Record<string, string[]>, locale: Locale = DEFAULT_LOCALE): DecisionModelAliasRow[] {
  return Object.entries(models)
    .map(([requested, resolved]) => {
      const clean = [...resolved].filter((value) => value.length > 0).sort();
      const drifted = clean.length > 1;
      const label = clean.length === 0
        ? t(locale, "decisions.metrics.models.noResolved")
        : drifted
          ? t(locale, "decisions.metrics.models.drift", { models: clean.join("、"), count: clean.length })
          : clean.join("、");
      return {
        key: requested,
        requested,
        resolved: clean,
        drifted,
        label,
        tone: drifted ? "warn" : "ok",
      } as DecisionModelAliasRow;
    })
    .sort((a, b) => a.requested.localeCompare(b.requested));
}

export interface DecisionCircuitRow {
  key: string;
  scope: string;
  model: string;
  state: "open" | "half_open";
  label: string;
  tone: DecisionMetricsTone;
}

/** One row per non-closed breaker (closed circuits add no noise). */
export function decisionCircuitRows(circuits: DecisionMetricCircuits, locale: Locale = DEFAULT_LOCALE): DecisionCircuitRow[] {
  return circuits.states.map((entry) => ({
    key: `${entry.scope}|${entry.model}|${entry.state}`,
    scope: entry.scope,
    model: entry.model,
    state: entry.state,
    label: `${entry.scope} · ${entry.model} · ${t(locale, DECISION_CIRCUIT_STATE_KEYS[entry.state])}${entry.authLocked ? ` · ${t(locale, "decisions.metrics.circuit.authLocked")}` : ""}`,
    tone: entry.state === "open" || entry.authLocked ? "error" : "warn",
  }));
}

/** The one-line circuit rollup shown next to the row list. */
export function decisionCircuitSummary(circuits: DecisionMetricCircuits, locale: Locale = DEFAULT_LOCALE): { label: string; tone: DecisionMetricsTone } {
  if (circuits.total === 0) return { label: t(locale, "decisions.metrics.circuits.none"), tone: "ok" };
  const alarm = circuits.open > 0 || circuits.authLocked > 0;
  return {
    label: t(locale, "decisions.metrics.circuits.summary", {
      total: circuits.total,
      open: circuits.open,
      authLocked: circuits.authLocked,
    }),
    tone: alarm ? "error" : "ok",
  };
}
