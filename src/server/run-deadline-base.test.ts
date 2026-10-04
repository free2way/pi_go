import { describe, expect, it } from "vitest";
import { resumeDeadlinePatch } from "./run-deadline-base.js";

/**
 * run_50b554e824954ecd: the approve `mode:"continue"` path and the resume route
 * must stamp a fresh `deadlineBaseAt` so the continued round is not measured
 * against the run's original (already elapsed) window.
 */
describe("resumeDeadlinePatch", () => {
  it("returns an additive deadlineBaseAt marker normalised to ISO", () => {
    expect(resumeDeadlinePatch("2026-08-01T12:00:00.000Z")).toEqual({ deadlineBaseAt: "2026-08-01T12:00:00.000Z" });
    const patch = resumeDeadlinePatch("2026-08-01T20:00:00+08:00");
    expect(patch.deadlineBaseAt).toBe("2026-08-01T12:00:00.000Z");
    expect(Object.keys(patch)).toEqual(["deadlineBaseAt"]);
  });

  it("rejects an invalid timestamp instead of writing a bogus window base", () => {
    expect(() => resumeDeadlinePatch("not-a-date")).toThrow(/invalid timestamp/);
  });
});
