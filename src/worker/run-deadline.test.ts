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

/**
 * run_50b554e824954ecd: a run kept a positive budget (1800s) from before the
 * "0 = unlimited" fix, so its original createdAt window had long elapsed and
 * every human 「继续开发」 bounced straight back to needs_human with
 * `run.deadline_exceeded`. A `deadlineBaseAt` marker written on human
 * continue/resume gives the continued round a fresh window.
 */
describe("resume window (deadlineBaseAt)", () => {
  const createdAt = Date.parse("2026-01-01T00:00:00.000Z");
  const resumedAt = Date.parse("2026-08-01T12:00:00.000Z");

  it("does not expire immediately when the original window already elapsed", () => {
    const delay = runDeadlineDelayMs({
      startedAt: resumedAt,
      createdAt,
      maxDurationSeconds: 1800,
      deadlineBaseAt: resumedAt,
      now: resumedAt,
    });
    expect(delay).toBe(1_800_000);
  });

  it("expires only after a full 1800s window measured from the marker", () => {
    const base = { startedAt: resumedAt, createdAt, maxDurationSeconds: 1800, deadlineBaseAt: resumedAt };
    expect(runDeadlineDelayMs({ ...base, now: resumedAt + 900_000 })).toBe(900_000);
    expect(runDeadlineDelayMs({ ...base, now: resumedAt + 1_799_999 })).toBe(1);
    expect(runDeadlineDelayMs({ ...base, now: resumedAt + 1_800_000 })).toBe(0);
    expect(runDeadlineDelayMs({ ...base, now: resumedAt + 1_800_001 })).toBe(0);
  });

  it("never bounces instantly when the worker claims the job after the marker window elapsed", () => {
    const lateStart = resumedAt + 3_000_000;
    const delay = runDeadlineDelayMs({
      startedAt: lateStart,
      createdAt: resumedAt,
      maxDurationSeconds: 1800,
      deadlineBaseAt: resumedAt,
      now: lateStart,
    });
    expect(delay).toBe(1_800_000);
  });

  it("stays unlimited for maxDurationSeconds 0 even with a marker", () => {
    expect(runDeadlineDelayMs({
      startedAt: resumedAt,
      createdAt,
      maxDurationSeconds: 0,
      deadlineBaseAt: resumedAt,
      now: resumedAt,
    })).toBeUndefined();
  });

  it("keeps the previous behaviour for a stale base without the marker", () => {
    expect(runDeadlineDelayMs({
      startedAt: resumedAt,
      createdAt,
      maxDurationSeconds: 1800,
      now: resumedAt,
    })).toBe(0);
  });
});
