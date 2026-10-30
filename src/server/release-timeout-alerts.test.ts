import { describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { readReleaseTimeoutObservation, syncReleaseTimeoutAlerts } from "./release-timeout-alerts.js";

describe("release callback timeout alert observation", () => {
  it("reads a numeric aggregate without exporting delivery identifiers or diagnostics", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ outstanding: "2" }] });
    expect(await readReleaseTimeoutObservation({ query })).toEqual({ outstanding: 2 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([[], [{ outstanding: null }], [{ outstanding: "" }], [{ outstanding: "0x10" }], [{ outstanding: -1 }], [{ outstanding: 1.5 }], [{ outstanding: true }], [{ outstanding: "9007199254740992" }]].map(rows => ({ rows })))("rejects incomplete or invalid aggregate observations: %j", async ({ rows }) => {
    await expect(readReleaseTimeoutObservation({ query: vi.fn().mockResolvedValue({ rows }) })).rejects.toThrow("Invalid release timeout observation");
  });

  it("does not reinterpret a query failure as recovery", async () => {
    await expect(readReleaseTimeoutObservation({ query: vi.fn().mockRejectedValue(new Error("unavailable")) })).rejects.toThrow("unavailable");
  });

  it("keeps the global alert until every outstanding release is recovered and rearms within cooldown", () => {
    const sink = vi.fn(), alerts = new AlertManager(sink, 900_000);
    syncReleaseTimeoutAlerts(alerts, { outstanding: 2 });
    syncReleaseTimeoutAlerts(alerts, { outstanding: 1 });
    expect(alerts.activeKeys).toEqual(["release_deploy_timeout"]);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual({ key: "release_deploy_timeout", severity: "warning", message: "发布部署回调超时，存在尚未成功恢复的发布", details: { count: 2 } });
    syncReleaseTimeoutAlerts(alerts, { outstanding: 0 });
    expect(alerts.activeKeys).toEqual([]);
    syncReleaseTimeoutAlerts(alerts, { outstanding: 1 });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("preserves a known fault on missing or malformed observations", () => {
    const sink = vi.fn(), alerts = new AlertManager(sink, 900_000);
    syncReleaseTimeoutAlerts(alerts, { outstanding: 1 });
    for (const observation of [undefined, { outstanding: NaN }, { outstanding: -1 }, { outstanding: 0.5 }]) syncReleaseTimeoutAlerts(alerts, observation);
    expect(alerts.activeKeys).toEqual(["release_deploy_timeout"]);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
