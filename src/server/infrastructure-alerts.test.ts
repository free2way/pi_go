import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { createInfrastructureAlertSweeper } from "./infrastructure-alerts.js";

afterEach(() => vi.useRealTimers());

function setup() {
  const sink = vi.fn();
  const alerts = new AlertManager(sink, 900_000);
  const database = vi.fn(async () => undefined);
  const worker = vi.fn(async (): Promise<unknown> => ({ activeJobs: 0 }));
  const storage = vi.fn(async (): Promise<unknown> => ({ state: "ok", freeBytes: 1_000, totalBytes: 2_000, freePercent: 50 }));
  const sweeper = createInfrastructureAlertSweeper({ alerts, database, worker, storage });
  return { sink, alerts, database, worker, storage, sweeper };
}

describe("infrastructure alert background sweep", () => {
  it("checks real dependencies on start without any health-page request", async () => {
    vi.useFakeTimers(); const s = setup(); s.sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.database).toHaveBeenCalledOnce(); expect(s.worker).toHaveBeenCalledOnce(); expect(s.storage).toHaveBeenCalledOnce();
    expect(s.sink).not.toHaveBeenCalled(); s.sweeper.stop();
  });

  it("checks every minute and does not start duplicate timers", async () => {
    vi.useFakeTimers(); const s = setup(); s.sweeper.start(); s.sweeper.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.database).toHaveBeenCalledTimes(3); expect(s.worker).toHaveBeenCalledTimes(3); s.sweeper.stop();
  });

  it("independently detects simultaneous database and Worker outages", async () => {
    const s = setup(); s.database.mockRejectedValue(new Error("DUMMY_PRIVATE_DB")); s.worker.mockRejectedValue(new Error("DUMMY_PRIVATE_WORKER"));
    await s.sweeper.sweep(); expect(s.alerts.activeKeys).toEqual(["database_unavailable", "worker_unreachable"]);
    expect(JSON.stringify(s.sink.mock.calls)).not.toContain("DUMMY");
  });

  it("deduplicates ongoing faults and rearms after successful recovery", async () => {
    const s = setup(); s.database.mockRejectedValueOnce(new Error("down")); s.worker.mockRejectedValueOnce(new Error("down"));
    await s.sweeper.sweep(); s.database.mockRejectedValueOnce(new Error("down")); s.worker.mockRejectedValueOnce(new Error("down"));
    await s.sweeper.sweep(); expect(s.sink).toHaveBeenCalledTimes(2);
    await s.sweeper.sweep(); expect(s.alerts.activeKeys).toEqual([]);
    s.database.mockRejectedValueOnce(new Error("down")); s.worker.mockRejectedValueOnce(new Error("down")); await s.sweeper.sweep();
    expect(s.sink).toHaveBeenCalledTimes(4);
  });

  it("bounds a frozen dependency and does not block the other detector", async () => {
    vi.useFakeTimers(); const s = setup(); s.database.mockImplementation(() => new Promise(() => {})); s.worker.mockRejectedValue(new Error("down"));
    s.sweeper.start(); await vi.advanceTimersByTimeAsync(5_001);
    expect(s.alerts.activeKeys).toContain("database_unavailable"); expect(s.alerts.activeKeys).toContain("worker_unreachable");
    await vi.advanceTimersByTimeAsync(60_000); expect(s.database).toHaveBeenCalledTimes(2); s.sweeper.stop();
  });

  it("does not overlap a sweep still waiting on its dependencies", async () => {
    vi.useFakeTimers(); const s = setup(); s.database.mockImplementation(() => new Promise(() => {}));
    const first = s.sweeper.sweep(); await s.sweeper.sweep(); expect(s.database).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_001); await first; s.sweeper.stop();
  });

  it.each([undefined, {}, { activeJobs: -1 }, { activeJobs: "0" }, { activeJobs: Number.NaN }])("does not accept malformed Worker health as recovery: %o", async (value) => {
    const s = setup(); s.alerts.raise({ key: "worker_unreachable", severity: "critical", message: "down" });
    s.worker.mockResolvedValue(value); await s.sweeper.sweep(); expect(s.alerts.activeKeys).toContain("worker_unreachable"); expect(s.storage).not.toHaveBeenCalled();
  });

  it("reconciles actual storage levels after valid Worker health", async () => {
    const s = setup(); s.storage.mockResolvedValue({ state: "critical", freeBytes: 1, totalBytes: 100, freePercent: 1 });
    await s.sweeper.sweep(); expect(s.alerts.activeKeys).toContain("disk_critical");
    s.storage.mockResolvedValue({ state: "ok", freeBytes: 50, totalBytes: 100, freePercent: 50 });
    await s.sweeper.sweep(); expect(s.alerts.activeKeys).not.toContain("disk_critical");
  });

  it("does not infer disk recovery from a failed storage observation", async () => {
    const s = setup(); s.alerts.raise({ key: "disk_critical", severity: "critical", message: "disk" });
    s.storage.mockRejectedValue(new Error("down")); await s.sweeper.sweep();
    expect(s.alerts.activeKeys).toContain("disk_critical"); expect(s.alerts.activeKeys).not.toContain("worker_unreachable");
  });

  it("stop cancels future observations and ignores in-flight completions", async () => {
    vi.useFakeTimers(); const s = setup(); let done!: () => void;
    s.database.mockImplementation(() => new Promise<undefined>(resolve => { done = () => resolve(undefined); }));
    s.alerts.raise({ key: "database_unavailable", severity: "critical", message: "down" });
    s.sweeper.start(); await vi.advanceTimersByTimeAsync(0); s.sweeper.stop(); done();
    await vi.advanceTimersByTimeAsync(120_000); expect(s.database).toHaveBeenCalledOnce(); expect(s.alerts.activeKeys).toContain("database_unavailable");
  });
});
