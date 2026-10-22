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

  it("redacts the same detached payload before structured logging and webhook serialization", () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const secret = 'DUMMY/+" platform';
    const original = { key: "storage_failure", severity: "critical" as const, message: "failure Bearer DUMMY_bearer", details: { runId: "run_1", count: 2, nested: [{ authorization: "DUMMY_header", message: encodeURIComponent(secret) }], error: "https://db.example.invalid/?api_key=DUMMY_query" } };
    const sink = createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch, webhookUrl: "https://alerts.example.invalid/hook", environment: { PI_INTERNAL_TOKEN: secret } });
    sink(original);
    const text = JSON.stringify([log.mock.calls, fetchImpl.mock.calls]);
    expect(text).not.toContain("DUMMY");
    expect(text).toContain("[redacted]");
    expect(log.mock.calls[0][1]).toMatchObject({ alert: "storage_failure", runId: "run_1", count: 2 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ key: "storage_failure", severity: "critical", details: { runId: "run_1", count: 2 } });
    expect(body.at).toEqual(expect.any(String));
    expect(original.details.nested[0].authorization).toBe("DUMMY_header");
  });

  it("redacts webhook delivery failures without changing the configured target", async () => {
    const log = vi.fn();
    const endpoint = "https://alerts.example.invalid/DUMMY_opaque";
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`delivery failed ${endpoint} Bearer DUMMY_echo`));
    const sink = createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch, webhookUrl: endpoint, environment: { PI_ALERT_WEBHOOK: endpoint } });
    sink({ key: "db_down", severity: "critical", message: "ordinary" });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[0][0]).toBe(endpoint);
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY");
    expect(log.mock.calls[1]).toEqual(["warn", { alert: "db_down", error: "delivery failed [redacted] Bearer [redacted]" }, "alert webhook delivery failed"]);
  });

  it("keeps cooldown identity and clear/re-raise behavior with redacted delivery", () => {
    const log = vi.fn();
    const manager = new AlertManager(createAlertSink({ log, environment: {} }), 60_000);
    const alert = { key: "db_down", severity: "critical" as const, message: "Bearer DUMMY_echo" };
    expect(manager.raise(alert)).toBe(true);
    expect(manager.raise(alert)).toBe(false);
    expect(manager.activeKeys).toEqual(["db_down"]);
    manager.clear("db_down");
    expect(manager.raise(alert)).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY");
  });
});
