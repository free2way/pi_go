import { describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { readQueueObservation, syncQueueAlerts as reconcileQueueAlerts } from "./queue-alerts.js";

const now = Date.parse("2026-01-01T00:00:00Z");
const job = (state: "queued" | "claimed", ageMs = 1_000) => ({ state, createdAt: new Date(now - ageMs).toISOString() });
const syncQueueAlerts = (alerts: AlertManager, jobs: readonly { state: string; createdAt: string }[] | undefined, threshold: number, at: number) => {
  const queued = jobs?.filter((j) => j.state === "queued");
  reconcileQueueAlerts(alerts, jobs ? {
    pending: jobs.length,
    stale: jobs.filter((j) => j.state === "claimed").length,
    queued: queued!.length,
    oldestQueuedAt: queued!.length ? queued!.map((j) => j.createdAt).sort()[0] : null,
  } : undefined, threshold, at);
};
const setup = () => {
  const sink = vi.fn();
  const alerts = new AlertManager(sink, 900_000);
  return { sink, alerts };
};

describe("syncQueueAlerts", () => {
  it("does not alert for a recent small queue or healthy active work", () => {
    const { sink, alerts } = setup();
    syncQueueAlerts(alerts, [job("queued")], 120_000, now);
    expect(sink).not.toHaveBeenCalled();
  });

  it("raises stale claims and deduplicates repeated observations", () => {
    const { sink, alerts } = setup();
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(alerts.activeKeys).toEqual(["queue_stale"]);
  });

  it("clears stale claims after recovery and rearms immediately within cooldown", () => {
    const { sink, alerts } = setup();
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    syncQueueAlerts(alerts, [], 120_000, now);
    expect(alerts.activeKeys).toEqual([]);
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("raises for twenty waiting jobs, not nineteen recent jobs", () => {
    const { sink, alerts } = setup();
    syncQueueAlerts(alerts, Array.from({ length: 19 }, () => job("queued")), 120_000, now);
    expect(sink).not.toHaveBeenCalled();
    syncQueueAlerts(alerts, Array.from({ length: 20 }, () => job("queued")), 120_000, now);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ key: "queue_backlog", details: { pending: 20, oldestWaitMs: 1_000 } }));
  });

  it("raises for a single old job and rearms after a healthy queue observation", () => {
    const { sink, alerts } = setup();
    syncQueueAlerts(alerts, [job("queued", 119_999)], 120_000, now);
    expect(sink).not.toHaveBeenCalled();
    syncQueueAlerts(alerts, [job("queued", 120_000)], 120_000, now);
    syncQueueAlerts(alerts, [job("queued", 180_000)], 120_000, now);
    expect(sink).toHaveBeenCalledTimes(1);
    syncQueueAlerts(alerts, [], 120_000, now);
    syncQueueAlerts(alerts, [job("queued", 120_000)], 120_000, now);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    [{ state: "queued" as const, createdAt: "invalid" }],
    [{ state: "queued" as const, createdAt: new Date(now + 1).toISOString() }],
    [{ state: "done", createdAt: new Date(now).toISOString() }] as never,
  ])("does not clear a known condition on an invalid observation: %o", (jobs) => {
    const { alerts } = setup();
    syncQueueAlerts(alerts, [job("claimed"), job("queued", 120_000)], 120_000, now);
    syncQueueAlerts(alerts, jobs, 120_000, now);
    expect(alerts.activeKeys).toEqual(["queue_stale", "queue_backlog"]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not infer recovery from an invalid threshold: %s", (threshold) => {
    const { alerts } = setup();
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    syncQueueAlerts(alerts, [], threshold, now);
    expect(alerts.activeKeys).toEqual(["queue_stale"]);
  });

  it("does not clear alerts owned by another detector or leak job details", () => {
    const { alerts, sink } = setup();
    alerts.raise({ key: "database_unavailable", severity: "critical", message: "db down" });
    const observed = { ...job("queued", 120_000), payload: "DUMMY_private", runId: "DUMMY_owner" };
    syncQueueAlerts(alerts, [observed], 120_000, now);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("DUMMY");
    syncQueueAlerts(alerts, [], 120_000, now);
    expect(alerts.activeKeys).toEqual(["database_unavailable"]);
  });
});

describe("readQueueObservation", () => {
  it("counts the entire eligible queue without loading payloads or a mixed LIMIT sample", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ pending: "120", stale: "60", queued: "60", oldest_queued_at: new Date(now - 180_000).toISOString() }] });
    const observed = await readQueueObservation({ query }, 120_000, now);
    expect(observed).toMatchObject({ pending: 120, stale: 60, queued: 60 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("attempts < 5");
    expect(sql).toContain("heartbeat_at < $1");
    expect(sql).not.toMatch(/LIMIT|payload_json|run_id/i);
    expect(params).toEqual([new Date(now - 120_000).toISOString()]);
    const { sink, alerts } = setup();
    reconcileQueueAlerts(alerts, observed, 120_000, now);
    expect(alerts.activeKeys).toEqual(["queue_stale", "queue_backlog"]);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    { pending: "wrong", stale: "0", queued: "0", oldest_queued_at: null },
    { pending: null, stale: "0", queued: "0", oldest_queued_at: null },
    { pending: "", stale: "0", queued: "0", oldest_queued_at: null },
    { pending: "1", stale: "0", queued: "0", oldest_queued_at: null },
    { pending: "1", stale: "0", queued: "1", oldest_queued_at: null },
    { pending: "0", stale: "0", queued: "0", oldest_queued_at: "invalid" },
    { pending: "-1", stale: "-1", queued: "0", oldest_queued_at: null },
  ])("rejects an incomplete or inconsistent aggregate instead of reporting recovery: %o", async (row) => {
    await expect(readQueueObservation({ query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) }, 120_000, now)).rejects.toThrow("Invalid queue observation");
  });

  it("propagates a failed database observation and preserves active conditions", async () => {
    const { alerts } = setup();
    syncQueueAlerts(alerts, [job("claimed")], 120_000, now);
    await expect(readQueueObservation({ query: vi.fn().mockRejectedValue(new Error("database unavailable")) }, 120_000, now)).rejects.toThrow("database unavailable");
    expect(alerts.activeKeys).toEqual(["queue_stale"]);
  });
});
