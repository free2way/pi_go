import { describe, expect, it } from "vitest";
import type { RunState } from "../shared/types.js";
import { assertTransition } from "../server/run-store-pg.js";
import { recoveryResumePhase, recoveryUpdateState } from "./run-recovery.js";

const reclaimable: RunState[] = ["queued", "preparing", "developing", "checking", "reviewing"];

describe("recoveryUpdateState (NEW-04)", () => {
  it.each(reclaimable)("preserves the %s phase when reclaiming a started job", (state) => {
    const next = recoveryUpdateState({ current: state });
    expect(next).toBe(state);
    // The preserved self-transition must be accepted by the run state machine.
    expect(() => assertTransition(state, next)).not.toThrow();
    // And the pipeline's next update (back to developing) must also be legal.
    expect(() => assertTransition(state, "developing")).not.toThrow();
  });

  it("would have failed with the old forced `preparing` transition", () => {
    // Regression guard for the exact repro: `Illegal run state transition: reviewing -> preparing`.
    for (const state of ["developing", "checking", "reviewing"] as RunState[]) {
      expect(() => assertTransition(state, "preparing")).toThrow(/Illegal run state transition/);
    }
  });

  it("keeps explicit human actions on their own entry states", () => {
    expect(recoveryUpdateState({ current: "needs_human", resume: true })).toBe("preparing");
    expect(recoveryUpdateState({ current: "needs_human", retryReview: true })).toBe("reviewing");
  });
});

describe("recoveryResumePhase (NEW-04)", () => {
  it("maps each preserved phase to the pipeline stage it resumes from", () => {
    expect(recoveryResumePhase("queued")).toBe("planning");
    expect(recoveryResumePhase("preparing")).toBe("planning");
    expect(recoveryResumePhase("developing")).toBe("development");
    expect(recoveryResumePhase("checking")).toBe("checks");
    expect(recoveryResumePhase("reviewing")).toBe("review");
  });
});
