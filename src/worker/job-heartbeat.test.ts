import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobHeartbeat } from "./job-heartbeat.js";

afterEach(() => vi.useRealTimers());

describe("createJobHeartbeat", () => {
  it("loses the lease immediately on an authoritative 409", async () => {
    vi.useFakeTimers();
    const onLeaseLost = vi.fn();
    const heartbeat = createJobHeartbeat({
      intervalMs: 20_000,
      staleMs: 120_000,
      heartbeat: vi.fn().mockRejectedValue(Object.assign(new Error("lost"), { status: 409, code: "JOB_LEASE_LOST" })),
      onLeaseLost,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeat.leaseLost()).toBe(true);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  it("aborts before expiry after bounded consecutive network failures", async () => {
    vi.useFakeTimers();
    const onLeaseLost = vi.fn();
    const heartbeat = createJobHeartbeat({
      intervalMs: 20_000,
      staleMs: 120_000,
      heartbeat: vi.fn().mockRejectedValue(new Error("network unavailable")),
      onLeaseLost,
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(heartbeat.leaseLost()).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeat.leaseLost()).toBe(true);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  it("resets the failure budget after a successful heartbeat", async () => {
    vi.useFakeTimers();
    const onLeaseLost = vi.fn();
    const call = vi.fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("again"));
    const heartbeat = createJobHeartbeat({ intervalMs: 20_000, staleMs: 120_000, heartbeat: call, onLeaseLost });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(heartbeat.leaseLost()).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(heartbeat.leaseLost()).toBe(true);
    heartbeat.stop();
  });
});
