import { describe, expect, it, vi } from "vitest";
import type { DecisionMetricCircuit } from "./metrics.js";
import {
  computeDecisionMetrics,
  createDecisionMetricsSweeper,
  evaluateDecisionAlerts,
  DECISION_ALERT_KEYS,
  DECISION_METRICS_DEFAULTS,
  DECISION_METRICS_MAX_ROWS,
  nearestRankPercentile,
  resolveDecisionMetricsConfig,
  type DecisionAlertThresholds,
  type DecisionMetricRow,
} from "./metrics.js";
import type { Alert } from "../alerts.js";

/**
 * docs/26 §16.1 · decision-plane monitoring. Pure: no database, no clock, no
 * timers (the sweep driver's timers are injected, so nothing waits 5 minutes).
 */

const THRESHOLDS: DecisionAlertThresholds = { fallbackRate: 0.2, validResponseRate: 0.8, p95Ms: 2000, minSamples: 3 };

function row(overrides: Partial<DecisionMetricRow> = {}): DecisionMetricRow {
  return {
    status: "completed",
    latencyMs: 100,
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    createdAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

function completed(count: number, latencyMs = 100): DecisionMetricRow[] {
  return Array.from({ length: count }, () => row({ latencyMs }));
}

function circuit(overrides: Partial<DecisionMetricCircuit> = {}): DecisionMetricCircuit {
  return { scope: "env", model: "jev-latest", state: "closed", authLocked: false, ...overrides };
}

describe("nearestRankPercentile (nearest-rank, ⌈p·n⌉-th smallest)", () => {
  it("returns null for an empty sample, never 0", () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull();
    expect(nearestRankPercentile([], 0.95)).toBeNull();
  });

  it("is the single observation for n = 1 at every percentile", () => {
    expect(nearestRankPercentile([42], 0)).toBe(42);
    expect(nearestRankPercentile([42], 0.5)).toBe(42);
    expect(nearestRankPercentile([42], 0.95)).toBe(42);
    expect(nearestRankPercentile([42], 0.99)).toBe(42);
    expect(nearestRankPercentile([42], 1)).toBe(42);
  });

  it("picks the ⌈p·n⌉-th smallest for n = 2", () => {
    const sorted = [10, 20];
    // ⌈0.5·2⌉ = 1 → the 1st smallest; ⌈0.95·2⌉ = 2 → the largest.
    expect(nearestRankPercentile(sorted, 0.5)).toBe(10);
    expect(nearestRankPercentile(sorted, 0.95)).toBe(20);
    expect(nearestRankPercentile(sorted, 0.99)).toBe(20);
  });

  it("picks the ⌈p·n⌉-th smallest for n = 3 (median is the middle sample)", () => {
    const sorted = [10, 20, 30];
    // ⌈0.5·3⌉ = 2 → 20; ⌈0.95·3⌉ = 3 → 30.
    expect(nearestRankPercentile(sorted, 0.5)).toBe(20);
    expect(nearestRankPercentile(sorted, 0.95)).toBe(30);
  });

  it("clamps out-of-range percentiles into the sample", () => {
    expect(nearestRankPercentile([5, 6, 7], -1)).toBe(5);
    expect(nearestRankPercentile([5, 6, 7], 2)).toBe(7);
  });
});

describe("computeDecisionMetrics", () => {
  it("returns an explicit empty shape for an empty window (rates are null, not 0)", () => {
    const metrics = computeDecisionMetrics([], []);
    expect(metrics.total).toBe(0);
    expect(metrics.validResponseRate).toBeNull();
    expect(metrics.fallbackRate).toBeNull();
    expect(metrics.latency).toEqual({ p50: null, p95: null, p99: null, max: null, samples: 0 });
    expect(metrics.byStatus).toEqual({ completed: 0, fallback: 0, rejected: 0, disabled: 0 });
    expect(metrics.models).toEqual({});
  });

  it("computes a 1.0 valid rate and a 0.0 fallback rate when every row completed", () => {
    const metrics = computeDecisionMetrics(completed(4), []);
    expect(metrics.total).toBe(4);
    expect(metrics.validResponseRate).toBe(1);
    expect(metrics.fallbackRate).toBe(0);
  });

  it("computes a 0.0 valid rate when nothing completed", () => {
    const metrics = computeDecisionMetrics(
      [row({ status: "fallback", fallbackReason: "timeout" }), row({ status: "rejected", fallbackReason: "contract_invalid" })],
      [],
    );
    expect(metrics.validResponseRate).toBe(0);
    expect(metrics.fallbackRate).toBe(0.5);
    expect(metrics.byFallbackReason).toEqual({ timeout: 1, contract_invalid: 1 });
  });

  it("counts unknown statuses without losing them", () => {
    const metrics = computeDecisionMetrics([row(), row({ status: "weird" })], []);
    expect(metrics.total).toBe(2);
    expect(metrics.byStatus.weird).toBe(1);
    expect(metrics.byStatus.completed).toBe(1);
  });

  it("computes latency percentiles over the observed samples only", () => {
    const metrics = computeDecisionMetrics(completed(20, 0).map((item, index) => ({ ...item, latencyMs: (index + 1) * 10 })), []);
    expect(metrics.latency.samples).toBe(20);
    // ⌈0.5·20⌉ = 10 → 100; ⌈0.95·20⌉ = 19 → 190; ⌈0.99·20⌉ = 20 → 200.
    expect(metrics.latency.p50).toBe(100);
    expect(metrics.latency.p95).toBe(190);
    expect(metrics.latency.p99).toBe(200);
    expect(metrics.latency.max).toBe(200);
  });

  it("ignores non-finite / negative latency rather than reporting 0", () => {
    const metrics = computeDecisionMetrics(
      [row({ latencyMs: Number.NaN }), row({ latencyMs: -5 }), row({ latencyMs: 30 })],
      [],
    );
    expect(metrics.latency.samples).toBe(1);
    expect(metrics.latency.p95).toBe(30);
    expect(metrics.total).toBe(3);
  });

  it("tracks requested → resolved alias sets and exposes multi-version drift", () => {
    const metrics = computeDecisionMetrics(
      [
        row({ requestedModel: "jev-latest", resolvedModel: "jev-1.13.0" }),
        row({ requestedModel: "jev-latest", resolvedModel: "jev-1.14.0" }),
        row({ requestedModel: "jev-fast", resolvedModel: "jev-fast-2" }),
        row({ requestedModel: "jev-fast", resolvedModel: "jev-fast-2" }),
        row({ requestedModel: "jev-fallback", resolvedModel: undefined, status: "fallback" }),
      ],
      [],
    );
    expect(metrics.models["jev-latest"]).toEqual(["jev-1.13.0", "jev-1.14.0"]);
    expect(metrics.models["jev-fast"]).toEqual(["jev-fast-2"]);
    // A requested alias that only ever fell back maps to an empty resolved set.
    expect(metrics.models["jev-fallback"]).toEqual([]);
  });

  it("rolls up circuit states without counting a half-open probe as open", () => {
    const metrics = computeDecisionMetrics([], [
      circuit({ state: "closed" }),
      circuit({ scope: "vault:u1", state: "open" }),
      circuit({ scope: "vault:u2", state: "open", authLocked: true }),
      circuit({ scope: "vault:u3", state: "half_open" }),
    ]);
    expect(metrics.circuits.total).toBe(4);
    expect(metrics.circuits.open).toBe(2);
    expect(metrics.circuits.authLocked).toBe(1);
    expect(metrics.circuits.halfOpen).toBe(1);
    // Only the non-closed breakers are listed, with identifiers only.
    expect(metrics.circuits.states.map((entry) => entry.state)).toEqual(["open", "open", "half_open"]);
    expect(metrics.circuits.states[1]).toEqual({ scope: "vault:u2", model: "jev-latest", state: "open", authLocked: true });
  });

  it("reports truncation when asked", () => {
    expect(computeDecisionMetrics([row()], [], { truncated: true }).truncated).toBe(true);
    expect(computeDecisionMetrics([row()], []).truncated).toBe(false);
  });
});

describe("resolveDecisionMetricsConfig", () => {
  it("uses the documented defaults when the env is absent/blank", () => {
    const config = resolveDecisionMetricsConfig({});
    expect(config.windowHours).toBe(DECISION_METRICS_DEFAULTS.windowHours);
    expect(config.intervalSeconds).toBe(DECISION_METRICS_DEFAULTS.intervalSeconds);
    expect(config.thresholds).toEqual({
      fallbackRate: 0.2,
      validResponseRate: 0.8,
      p95Ms: 2000,
      minSamples: 20,
    });
    const blank = resolveDecisionMetricsConfig({ PI_DECISION_METRICS_WINDOW_HOURS: "  ", PI_DECISION_ALERT_MIN_SAMPLES: "" });
    expect(blank.windowHours).toBe(24);
    expect(blank.thresholds.minSamples).toBe(20);
  });

  it("reads explicit values and falls back on invalid ones", () => {
    const config = resolveDecisionMetricsConfig({
      PI_DECISION_METRICS_WINDOW_HOURS: "6",
      PI_DECISION_METRICS_INTERVAL_SECONDS: "60",
      PI_DECISION_ALERT_FALLBACK_RATE: "0.05",
      PI_DECISION_ALERT_VALID_RATE: "0.95",
      PI_DECISION_ALERT_P95_MS: "750",
      PI_DECISION_ALERT_MIN_SAMPLES: "5",
    });
    expect(config).toEqual({
      windowHours: 6,
      intervalSeconds: 60,
      thresholds: { fallbackRate: 0.05, validResponseRate: 0.95, p95Ms: 750, minSamples: 5 },
    });

    const invalid = resolveDecisionMetricsConfig({
      PI_DECISION_METRICS_WINDOW_HOURS: "-3",
      PI_DECISION_METRICS_INTERVAL_SECONDS: "nope",
      PI_DECISION_ALERT_FALLBACK_RATE: "1.5",
      PI_DECISION_ALERT_VALID_RATE: "-0.2",
      PI_DECISION_ALERT_P95_MS: "0",
      PI_DECISION_ALERT_MIN_SAMPLES: "0",
    });
    expect(invalid.windowHours).toBe(24);
    expect(invalid.intervalSeconds).toBe(300);
    expect(invalid.thresholds).toEqual({ fallbackRate: 0.2, validResponseRate: 0.8, p95Ms: 2000, minSamples: 20 });
  });
});

describe("evaluateDecisionAlerts", () => {
  const context = { windowHours: 24 };

  it("raises nothing (and clears every key) when there are too few samples", () => {
    const metrics = computeDecisionMetrics([row({ status: "fallback", latencyMs: 9000 })], []);
    const plan = evaluateDecisionAlerts(metrics, THRESHOLDS, context);
    expect(plan.raise).toEqual([]);
    expect(plan.clear).toEqual(Object.values(DECISION_ALERT_KEYS));
  });

  it("raises the fallback warning above the threshold and clears it below", () => {
    const bad = computeDecisionMetrics(
      [row({ status: "fallback" }), row({ status: "fallback" }), row({ status: "completed" })],
      [],
    );
    const plan = evaluateDecisionAlerts(bad, THRESHOLDS, context);
    expect(plan.raise.map((alert) => alert.key)).toContain(DECISION_ALERT_KEYS.fallbackRate);
    const alert = plan.raise.find((item) => item.key === DECISION_ALERT_KEYS.fallbackRate) as Alert;
    expect(alert.severity).toBe("warning");
    expect(alert.details).toEqual({ rate: 2 / 3, threshold: 0.2, samples: 3, windowHours: 24 });

    const good = computeDecisionMetrics(completed(5), []);
    const goodPlan = evaluateDecisionAlerts(good, THRESHOLDS, context);
    expect(goodPlan.raise.map((item) => item.key)).not.toContain(DECISION_ALERT_KEYS.fallbackRate);
    expect(goodPlan.clear).toContain(DECISION_ALERT_KEYS.fallbackRate);
  });

  it("raises the valid-response warning below the threshold", () => {
    const metrics = computeDecisionMetrics(
      [row({ status: "fallback" }), row({ status: "rejected" }), row({ status: "completed" })],
      [],
    );
    const plan = evaluateDecisionAlerts(metrics, THRESHOLDS, context);
    const alert = plan.raise.find((item) => item.key === DECISION_ALERT_KEYS.validResponseRate) as Alert;
    expect(alert.severity).toBe("warning");
    expect(alert.details).toMatchObject({ rate: 1 / 3, threshold: 0.8, samples: 3 });
  });

  it("raises the p95 warning only with enough latency samples", () => {
    const tooFew = computeDecisionMetrics([row({ latencyMs: 9000 }), row({ latencyMs: 9000 })], []);
    expect(evaluateDecisionAlerts(tooFew, THRESHOLDS, context).raise.map((a) => a.key)).not.toContain(DECISION_ALERT_KEYS.p95Latency);

    const enough = computeDecisionMetrics(completed(3, 9000), []);
    const plan = evaluateDecisionAlerts(enough, THRESHOLDS, context);
    const alert = plan.raise.find((item) => item.key === DECISION_ALERT_KEYS.p95Latency) as Alert;
    expect(alert.severity).toBe("warning");
    expect(alert.details).toEqual({ p95Ms: 9000, threshold: 2000, samples: 3, windowHours: 24 });
  });

  it("raises a critical circuit alert on an open (or auth-locked) breaker, and clears when closed", () => {
    const open = computeDecisionMetrics([], [circuit({ state: "open", scope: "vault:u1", authLocked: true })]);
    const plan = evaluateDecisionAlerts(open, THRESHOLDS, context);
    const alert = plan.raise.find((item) => item.key === DECISION_ALERT_KEYS.circuit) as Alert;
    expect(alert.severity).toBe("critical");
    expect(alert.details).toMatchObject({ open: 1, authLocked: 1, total: 1 });
    expect(alert.details?.states).toEqual([{ scope: "vault:u1", model: "jev-latest", state: "open", authLocked: true }]);

    const closed = computeDecisionMetrics([], [circuit()]);
    const closedPlan = evaluateDecisionAlerts(closed, THRESHOLDS, context);
    expect(closedPlan.raise.map((item) => item.key)).not.toContain(DECISION_ALERT_KEYS.circuit);
    expect(closedPlan.clear).toContain(DECISION_ALERT_KEYS.circuit);
  });

  it("never puts a key/payload/run id in the alert details", () => {
    const planted = "sk-DUMMY-SECRET-DO-NOT-LEAK";
    const metrics = computeDecisionMetrics(
      [
        row({ status: "fallback", fallbackReason: "authentication_failed", resolvedModel: planted }),
        row({ status: "fallback", latencyMs: 9000, resolvedModel: planted }),
        row({ status: "fallback", latencyMs: 9000, resolvedModel: planted }),
      ],
      [circuit({ state: "open", authLocked: true, scope: "vault:user-1" })],
    );
    const plan = evaluateDecisionAlerts(metrics, THRESHOLDS, context);
    const serialized = JSON.stringify(plan.raise);
    // The planted key only ever lived in a provider field, which no alert copies.
    expect(serialized).not.toContain(planted);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("evaluationId");
    // The circuit detail carries the credential-source scope (an identifier), as
    // required, but never a credential value field.
    const circuitAlert = plan.raise.find((item) => item.key === DECISION_ALERT_KEYS.circuit) as Alert;
    expect(circuitAlert.details?.states).toEqual([{ scope: "vault:user-1", model: "jev-latest", state: "open", authLocked: true }]);
    for (const alert of plan.raise) {
      expect(Object.keys(alert.details ?? {})).not.toContain("key");
      expect(Object.keys(alert.details ?? {})).not.toContain("apiKey");
    }
  });
});

describe("createDecisionMetricsSweeper", () => {
  function harness(options: {
    rows?: DecisionMetricRow[];
    circuits?: DecisionMetricCircuit[];
    enabled?: boolean;
    fail?: boolean;
  } = {}) {
    const rows = options.rows ?? [];
    const raised: Alert[] = [];
    const cleared: string[] = [];
    const warns: Array<{ message: string; details: Record<string, unknown> }> = [];
    let readCalls = 0;
    let handler: (() => void) | undefined;
    const sweeper = createDecisionMetricsSweeper({
      env: {},
      enabled: () => options.enabled ?? true,
      listRecent: async () => {
        readCalls += 1;
        if (options.fail) throw new Error("database unavailable");
        return rows;
      },
      circuits: () => options.circuits ?? [],
      raise: (alert) => raised.push(alert),
      clear: (key) => cleared.push(key),
      warn: (message, details) => warns.push({ message, details }),
      now: () => new Date("2026-10-06T12:00:00.000Z"),
      config: { windowHours: 24, intervalSeconds: 300, thresholds: THRESHOLDS },
      timers: {
        setInterval: (fn) => {
          handler = fn;
          return "handle";
        },
        clearInterval: () => {
          handler = undefined;
        },
      },
    });
    return {
      sweeper,
      raised,
      cleared,
      warns,
      readCalls: () => readCalls,
      triggerInterval: () => handler?.(),
      intervalWired: () => handler !== undefined,
    };
  }

  it("does nothing at all (no query) when the plane is disabled", async () => {
    const h = harness({ enabled: false });
    const outcome = await h.sweeper.sweep();
    expect(outcome).toBeUndefined();
    expect(h.readCalls()).toBe(0);
    expect(h.raised).toEqual([]);
  });

  it("computes the window and applies raise/clear in one sweep", async () => {
    const h = harness({
      rows: [row({ status: "fallback" }), row({ status: "fallback" }), row({ status: "completed" })],
      circuits: [circuit({ state: "open", authLocked: true })],
    });
    const outcome = await h.sweeper.sweep();
    expect(outcome?.window).toEqual({ hours: 24, since: "2026-10-05T12:00:00.000Z", limit: DECISION_METRICS_MAX_ROWS });
    expect(outcome?.computedAt).toBe("2026-10-06T12:00:00.000Z");
    expect(h.raised.map((alert) => alert.key)).toEqual([
      DECISION_ALERT_KEYS.fallbackRate,
      DECISION_ALERT_KEYS.validResponseRate,
      DECISION_ALERT_KEYS.circuit,
    ]);
    expect(h.cleared).toContain(DECISION_ALERT_KEYS.p95Latency);
  });

  it("degrades on a read failure: warn, no raise and no clear", async () => {
    const h = harness({ fail: true });
    const outcome = await h.sweeper.sweep();
    expect(outcome).toBeUndefined();
    expect(h.raised).toEqual([]);
    expect(h.cleared).toEqual([]);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0].message).toContain("decision metrics sweep failed");
  });

  it("triggers exactly one sweep from the injected interval (no 5-minute wait)", async () => {
    const h = harness({ rows: completed(5) });
    h.sweeper.start();
    expect(h.intervalWired()).toBe(true);
    h.triggerInterval();
    await vi.waitFor(() => expect(h.readCalls()).toBe(1));
    h.sweeper.stop();
    expect(h.intervalWired()).toBe(false);
  });

  it("flags truncation when the read returns more than the cap", async () => {
    const rows = Array.from({ length: DECISION_METRICS_MAX_ROWS + 1 }, () => row());
    const h = harness({ rows });
    const outcome = await h.sweeper.sweep();
    expect(outcome?.metrics.truncated).toBe(true);
    expect(outcome?.metrics.total).toBe(DECISION_METRICS_MAX_ROWS);
  });
});
