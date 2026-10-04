import { describe, expect, it, vi } from "vitest";
import { AlertManager, createAlertSink } from "./alerts.js";

describe("AlertManager", () => {
  it("deduplicates repeated alerts inside the cooldown window", () => {
    const sink = vi.fn();
    const manager = new AlertManager(sink, 60_000);
    expect(manager.raise({ key: "db_down", severity: "critical", message: "db down" })).toBe(true);
    expect(manager.raise({ key: "db_down", severity: "critical", message: "db down" })).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);

    manager.clear("db_down");
    expect(manager.raise({ key: "db_down", severity: "critical", message: "db down again" })).toBe(true);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("alerts independently per key", () => {
    const sink = vi.fn();
    const manager = new AlertManager(sink, 60_000);
    manager.raise({ key: "disk_low", severity: "warning", message: "disk" });
    manager.raise({ key: "worker_down", severity: "critical", message: "worker" });
    expect(sink).toHaveBeenCalledTimes(2);
    expect(manager.activeKeys).toEqual(["disk_low", "worker_down"]);
  });
});

describe("createAlertSink", () => {
  it("logs every alert and posts to the webhook when configured", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const sink = createAlertSink({ log, webhookUrl: "https://alerts.example.test/hook", fetchImpl: fetchImpl as unknown as typeof fetch });
    sink({ key: "worker_down", severity: "critical", message: "worker unreachable", details: { runId: "run_1" } });
    expect(log).toHaveBeenCalledWith("error", expect.objectContaining({ alert: "worker_down" }), "worker unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://alerts.example.test/hook");
    expect(JSON.parse(init.body)).toMatchObject({ key: "worker_down", severity: "critical" });
  });

  it("skips the webhook when none is configured", () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    const sink = createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch });
    sink({ key: "queue_stale", severity: "warning", message: "stale jobs" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
