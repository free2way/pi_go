import { describe, expect, it, vi } from "vitest";
import { isUnlimitedDuration, runDeadlineDelayMs, startRunDeadline } from "./run-deadline.js";

/**
 * COST-002 / AUD-10: a run duration budget of 0 means UNLIMITED. The regression
 * this guards against is `deadlineAt = max(started, createdAt + 0)` collapsing to
 * "now" and aborting every run immediately.
 */
describe("run deadline 0/absent = unlimited (COST-002)", () => {
  it("does not arm a timeout for a 0 duration (runs to completion)", async () => {
    const controller = new AbortController();
    const now = Date.now();
    const deadline = startRunDeadline({ startedAt: now, createdAt: now, maxDurationSeconds: 0 }, () => controller.abort());
    expect(deadline.delayMs).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(controller.signal.aborted).toBe(false);
    expect(deadline.exceeded()).toBe(false);
    deadline.cancel();
  });

  it("arms and aborts for a positive (tiny) duration", async () => {
    const controller = new AbortController();
    const now = Date.now();
    const deadline = startRunDeadline({ startedAt: now, createdAt: now, maxDurationSeconds: 0.01 }, () => controller.abort());
    expect(deadline.delayMs).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deadline.exceeded()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    deadline.cancel();
  });

  it("treats absent, NaN and negative durations as unlimited", () => {
    expect(isUnlimitedDuration(0)).toBe(true);
    expect(isUnlimitedDuration(undefined)).toBe(true);
    expect(isUnlimitedDuration(Number.NaN)).toBe(true);
    expect(isUnlimitedDuration(-5)).toBe(true);
    expect(isUnlimitedDuration(0.5)).toBe(false);
    expect(runDeadlineDelayMs({ startedAt: Date.now(), createdAt: Date.now(), maxDurationSeconds: Number.NaN })).toBeUndefined();
  });

  it("never invokes the callback once cancelled", async () => {
    const onExceed = vi.fn();
    const now = Date.now();
    const deadline = startRunDeadline({ startedAt: now, createdAt: now, maxDurationSeconds: 0.05 }, onExceed);
    deadline.cancel();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onExceed).not.toHaveBeenCalled();
    expect(deadline.exceeded()).toBe(false);
  });
});
