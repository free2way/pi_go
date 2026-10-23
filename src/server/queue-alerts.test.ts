import { describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { syncQueueAlerts } from "./queue-alerts.js";

const now = Date.parse("2026-01-01T00:00:00Z");
const job = (state: "queued" | "claimed", ageMs = 1_000) => ({ state, createdAt: new Date(now - ageMs).toISOString() });
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
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ key: "queue_backlog", details: { sampledPending: 20, oldestWaitMs: 1_000 } }));
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
