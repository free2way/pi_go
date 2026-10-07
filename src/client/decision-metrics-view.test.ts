import { describe, expect, it } from "vitest";
import { t } from "../shared/i18n";
import type { DecisionMetrics, DecisionMetricsResponse } from "../shared/decision-metrics";
import {
  decisionCircuitRows,
  decisionCircuitSummary,
  decisionMetricsNotice,
  decisionMetricsRows,
  decisionMetricsWindowLabel,
  decisionModelAliasRows,
  formatMetricMillis,
  formatMetricRate,
} from "./decision-metrics-view";

/** docs/26 §16.1 — pure client view helpers (no DOM). */

function metrics(overrides: Partial<DecisionMetrics> = {}): DecisionMetrics {
  return {
    total: 10,
    byStatus: { completed: 8, fallback: 2, rejected: 0, disabled: 0 },
    byFallbackReason: { timeout: 2 },
    validResponseRate: 0.8,
    fallbackRate: 0.2,
    latency: { p50: 100, p95: 300, p99: 500, max: 600, samples: 10 },
    models: { "jev-latest": ["jev-1.13.0"] },
    circuits: { total: 1, open: 0, authLocked: 0, halfOpen: 0, states: [] },
    truncated: false,
    ...overrides,
  };
}

function response(overrides: Partial<DecisionMetricsResponse> = {}): DecisionMetricsResponse {
  return {
    schemaVersion: 1,
    available: true,
    enabled: true,
    window: { hours: 24, since: "2026-10-05T12:00:00.000Z", limit: 5000 },
    computedAt: "2026-10-06T12:00:00.000Z",
    metrics: metrics(),
    ...overrides,
  };
}

describe("formatMetricRate / formatMetricMillis (null is unknown, never 0)", () => {
  it("renders null and non-finite as the explicit unknown marker", () => {
    expect(formatMetricRate(null)).toBe("—");
    expect(formatMetricRate(undefined)).toBe("—");
    expect(formatMetricRate(Number.NaN)).toBe("—");
    expect(formatMetricMillis(null)).toBe("—");
    expect(formatMetricMillis(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("renders 0 and 1 as real rates", () => {
    expect(formatMetricRate(0)).toBe("0.0%");
    expect(formatMetricRate(1)).toBe("100.0%");
    expect(formatMetricRate(0.8125)).toBe("81.3%");
    expect(formatMetricMillis(120)).toBe("120 ms");
    expect(formatMetricMillis(99.6)).toBe("100 ms");
  });
});

describe("decisionMetricsRows", () => {
  it("lists the headline rows in a stable order and marks unknown values muted", () => {
    const rows = decisionMetricsRows(metrics());
    expect(rows.map((row) => row.key)).toEqual(["total", "samples", "validRate", "fallbackRate", "p50", "p95", "p99", "max"]);
    expect(rows.every((row) => !row.muted)).toBe(true);
    expect(rows.find((row) => row.key === "validRate")?.value).toBe("80.0%");
  });

  it("marks a missing metric as muted with the unknown marker", () => {
    const rows = decisionMetricsRows(metrics({ validResponseRate: null, fallbackRate: null, latency: { p50: null, p95: null, p99: null, max: null, samples: 0 } }));
    const valid = rows.find((row) => row.key === "validRate");
    expect(valid?.muted).toBe(true);
    expect(valid?.value).toBe("—");
    const p95 = rows.find((row) => row.key === "p95");
    expect(p95?.muted).toBe(true);
    expect(p95?.value).toBe("—");
  });
});

describe("decisionMetricsNotice", () => {
  it("is null when there is data", () => {
    expect(decisionMetricsNotice(response())).toBeNull();
  });

  it("reports a degraded read before disabled, and an empty window last", () => {
    expect(decisionMetricsNotice(response({ available: false }))).toBe(t("zh", "decisions.metrics.state.unavailable"));
    expect(decisionMetricsNotice(response({ enabled: false }))).toBe(t("zh", "decisions.metrics.state.disabled"));
    expect(decisionMetricsNotice(response({ metrics: metrics({ total: 0 }) }))).toBe(t("zh", "decisions.metrics.state.noData"));
    expect(decisionMetricsNotice(response({ available: false, enabled: false }))).toBe(t("zh", "decisions.metrics.state.unavailable"));
  });

  it("localizes the empty state", () => {
    expect(decisionMetricsNotice(response({ enabled: false }), "en")).toBe("The decision plane is disabled (PI_DECISION_ENGINE=disabled); there is no evaluation data.");
  });
});

describe("decisionMetricsWindowLabel", () => {
  it("includes the window length and the lower bound", () => {
    expect(decisionMetricsWindowLabel(response())).toBe("最近 24 小时（自 2026-10-05T12:00:00.000Z）");
  });
});

describe("decisionModelAliasRows", () => {
  it("flags an alias that resolved to more than one version as drift", () => {
    const rows = decisionModelAliasRows({ "jev-latest": ["jev-1.14.0", "jev-1.13.0"], "jev-fast": ["jev-fast-2"] });
    expect(rows.map((row) => row.requested)).toEqual(["jev-fast", "jev-latest"]);
    const drifted = rows.find((row) => row.requested === "jev-latest");
    expect(drifted?.drifted).toBe(true);
    expect(drifted?.tone).toBe("warn");
    expect(drifted?.resolved).toEqual(["jev-1.13.0", "jev-1.14.0"]);
    expect(rows.find((row) => row.requested === "jev-fast")?.drifted).toBe(false);
  });

  it("renders an alias with no resolved version as an explicit placeholder", () => {
    const rows = decisionModelAliasRows({ "jev-fallback": [] });
    expect(rows[0].resolved).toEqual([]);
    expect(rows[0].drifted).toBe(false);
    expect(rows[0].label).toBe(t("zh", "decisions.metrics.models.noResolved"));
  });
});

describe("circuit rows / summary", () => {
  it("summarizes an all-closed fleet as ok", () => {
    const summary = decisionCircuitSummary({ total: 3, open: 0, authLocked: 0, halfOpen: 0, states: [] });
    expect(summary.tone).toBe("ok");
    expect(summary.label).toBe(t("zh", "decisions.metrics.circuits.summary", { total: 3, open: 0, authLocked: 0 }));
    expect(decisionCircuitRows({ total: 3, open: 0, authLocked: 0, halfOpen: 0, states: [] })).toEqual([]);
  });

  it("raises the summary tone and lists only the non-closed breakers", () => {
    const circuits = {
      total: 2,
      open: 1,
      authLocked: 1,
      halfOpen: 1,
      states: [
        { scope: "vault:u1", model: "jev-latest", state: "open" as const, authLocked: true },
        { scope: "env", model: "jev-latest", state: "half_open" as const, authLocked: false },
      ],
    };
    expect(decisionCircuitSummary(circuits).tone).toBe("error");
    const rows = decisionCircuitRows(circuits);
    expect(rows).toHaveLength(2);
    expect(rows[0].tone).toBe("error");
    expect(rows[0].label).toContain("凭据锁定");
    expect(rows[1].tone).toBe("warn");
  });
});
