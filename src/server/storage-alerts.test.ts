import { describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { syncStorageAlerts, type WorkspaceStorageStatus } from "./storage-alerts.js";

const observation = (state: WorkspaceStorageStatus["state"]): WorkspaceStorageStatus => ({
  state, freeBytes: 1024, totalBytes: 4096, freePercent: 25,
});

describe("workspace disk alert reconciliation", () => {
  it("deduplicates a persistent low condition and delivers its safe measurements", () => {
    const sink = vi.fn();
    const alerts = new AlertManager(sink, 60_000);
    syncStorageAlerts(alerts, observation("low"));
    syncStorageAlerts(alerts, observation("low"));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({ key: "disk_low", severity: "warning", message: "工作区磁盘空间偏低", details: { freeBytes: 1024, freePercent: 25 } });
  });

  it("replaces low with critical and critical with low without retaining stale keys", () => {
    const sink = vi.fn();
    const alerts = new AlertManager(sink, 60_000);
    syncStorageAlerts(alerts, observation("low"));
    syncStorageAlerts(alerts, observation("critical"));
    expect(alerts.activeKeys).toEqual(["disk_critical"]);
    expect(sink.mock.calls[1][0]).toMatchObject({ key: "disk_critical", severity: "critical" });
    syncStorageAlerts(alerts, observation("critical"));
    expect(sink).toHaveBeenCalledTimes(2);
    syncStorageAlerts(alerts, observation("low"));
    expect(alerts.activeKeys).toEqual(["disk_low"]);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it.each(["low", "critical"] as const)("clears recovered %s and rearms an immediate recurrence", (state) => {
    const sink = vi.fn();
    const alerts = new AlertManager(sink, 60_000);
    alerts.raise({ key: "database_unavailable", severity: "critical", message: "unrelated" });
    syncStorageAlerts(alerts, observation(state));
    syncStorageAlerts(alerts, observation("ok"));
    expect(alerts.activeKeys).toEqual(["database_unavailable"]);
    syncStorageAlerts(alerts, observation(state));
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("does not report recovery when the worker probe fails", () => {
    const alerts = new AlertManager(vi.fn(), 60_000);
    syncStorageAlerts(alerts, observation("critical"));
    syncStorageAlerts(alerts, undefined);
    expect(alerts.activeKeys).toEqual(["disk_critical"]);
  });

  it.each([
    { state: "ok" as const, freeBytes: -1, totalBytes: -1, freePercent: -1 },
    { ...observation("ok"), freeBytes: Number.NaN },
    { ...observation("ok"), totalBytes: 0 },
    { ...observation("ok"), freePercent: 101 },
  ])("does not treat an invalid observation as recovery: %o", (storage) => {
    const alerts = new AlertManager(vi.fn(), 60_000);
    syncStorageAlerts(alerts, observation("critical"));
    syncStorageAlerts(alerts, storage);
    expect(alerts.activeKeys).toEqual(["disk_critical"]);
  });

  it("clears both stale keys from an older process state on healthy observation", () => {
    const sink = vi.fn();
    const alerts = new AlertManager(sink, 60_000);
    alerts.raise({ key: "disk_low", severity: "warning", message: "previous" });
    alerts.raise({ key: "disk_critical", severity: "critical", message: "previous" });
    syncStorageAlerts(alerts, observation("ok"));
    expect(alerts.activeKeys).toEqual([]);
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
