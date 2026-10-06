import { describe, expect, it } from "vitest";
import type { RunState } from "../shared/types.js";
import { assertTransition } from "../server/run-store-pg.js";
import { MAX_ROUNDS_MESSAGE, planRecovery, recoveryResumePhase, recoveryUpdateState } from "./run-recovery.js";
import type { BudgetLimits } from "./budget.js";

const NO_LIMITS: BudgetLimits = { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 };
const FULL_LIMITS: BudgetLimits = { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 10, maxDurationSeconds: 3600 };

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

  it("keeps the human-continue phase instead of forcing preparing (审批「继续开发」端到端可用)", () => {
    expect(recoveryUpdateState({ current: "developing", resume: true })).toBe("developing");
    expect(recoveryUpdateState({ current: "checking", resume: true })).toBe("checking");
    expect(recoveryUpdateState({ current: "reviewing", resume: true })).toBe("reviewing");
    expect(recoveryUpdateState({ current: "needs_human", resume: true })).toBe("preparing");
  });

});

describe("planRecovery (R3-001 / R3-FINAL-ROUND-AMBIGUOUS)", () => {
  it("proceeds for a reclaim that still has rounds left", () => {
    expect(planRecovery({ state: "reviewing", recovery: true, round: 1, maxRounds: 3, limits: NO_LIMITS })).toEqual({ stop: false });
  });

  it("stops a reclaim at or past the final round with the existing max-rounds message", () => {
    const atCap = planRecovery({ state: "reviewing", recovery: true, round: 3, maxRounds: 3, limits: NO_LIMITS });
    expect(atCap).toMatchObject({ stop: true, reason: "max_rounds", eventType: "run.needs_human", message: MAX_ROUNDS_MESSAGE });
    const overCap = planRecovery({ state: "developing", recovery: true, round: 4, maxRounds: 3 });
    expect(overCap).toMatchObject({ stop: true, reason: "max_rounds" });
  });

  it("localizes the stop message and always offers the English variant (docs/24-i18n.md §9)", () => {
    const zh = planRecovery({ state: "reviewing", recovery: true, round: 3, maxRounds: 3, locale: "zh" });
    expect(zh).toMatchObject({ stop: true, message: MAX_ROUNDS_MESSAGE, messageEn: "Maximum review rounds reached; human handling required" });
    const en = planRecovery({ state: "reviewing", recovery: true, round: 3, maxRounds: 3, locale: "en" });
    expect(en).toMatchObject({ stop: true, message: "Maximum review rounds reached; human handling required" });
    // An omitted locale is the previous behaviour, byte for byte.
    expect(planRecovery({ state: "reviewing", recovery: true, round: 3, maxRounds: 3 })).toMatchObject({ message: MAX_ROUNDS_MESSAGE });
    const deadline = planRecovery({
      state: "developing",
      recovery: true,
      round: 1,
      maxRounds: 3,
      limits: { ...NO_LIMITS, maxDurationSeconds: 60 },
      createdAt: "2026-01-01T00:00:00.000Z",
      now: Date.parse("2026-01-01T00:05:00.000Z"),
      locale: "en",
    });
    expect(deadline).toMatchObject({ stop: true, reason: "deadline_exceeded" });
    if (deadline.stop) {
      expect(deadline.message).toContain("time budget");
      expect(deadline.messageEn).toContain("time budget");
    }
  });

  it("proceeds when round/maxRounds are sparse (backward compatible)", () => {
    expect(planRecovery({ state: "reviewing", recovery: true }).stop).toBe(false);
    expect(planRecovery({ state: "reviewing", recovery: true, round: 3 }).stop).toBe(false);
    expect(planRecovery({ state: "reviewing", recovery: true, maxRounds: 3 }).stop).toBe(false);
    // A non-positive/invalid maxRounds is never treated as "already exhausted".
    expect(planRecovery({ state: "reviewing", recovery: true, round: 1, maxRounds: 0 }).stop).toBe(false);
  });

  it("never pre-empts an explicit human resume or reviewer retry", () => {
    expect(planRecovery({ state: "needs_human", recovery: true, resume: true, round: 3, maxRounds: 3 }).stop).toBe(false);
    expect(planRecovery({ state: "needs_human", recovery: true, retryReview: true, round: 3, maxRounds: 3 }).stop).toBe(false);
    // A fresh (non-recovery) dispatch is not a reclaim at all.
    expect(planRecovery({ state: "queued", recovery: false, round: 0, maxRounds: 3 }).stop).toBe(false);
  });

  it("stops a reclaim whose hard budget is already exhausted", () => {
    const plan = planRecovery({
      state: "developing",
      recovery: true,
      round: 1,
      maxRounds: 3,
      limits: FULL_LIMITS,
      usage: { inputTokens: 900, outputTokens: 200, estimatedCost: 0.5 },
    });
    expect(plan).toMatchObject({ stop: true, reason: "budget_exhausted", eventType: "run.budget_exhausted" });
    expect((plan as { message: string }).message).toContain("运行预算已用尽");
    // Model-call dimension is honored too.
    expect(planRecovery({ state: "developing", recovery: true, limits: FULL_LIMITS, modelCalls: 10 }).stop).toBe(true);
    // Within budget, the reclaim proceeds.
    expect(planRecovery({ state: "developing", recovery: true, limits: FULL_LIMITS, usage: { inputTokens: 10, outputTokens: 10, estimatedCost: 0.01 }, modelCalls: 1 }).stop).toBe(false);
  });

  it("stops a reclaim whose duration deadline already elapsed", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const exceeded = planRecovery({
      state: "developing",
      recovery: true,
      limits: FULL_LIMITS,
      createdAt,
      now: Date.parse("2026-01-01T02:00:00.000Z"),
    });
    expect(exceeded).toMatchObject({ stop: true, reason: "deadline_exceeded", eventType: "run.deadline_exceeded" });
    expect((exceeded as { message: string }).message).toContain("运行超过时限预算");
    // Still inside the window, and a resume marker grants a fresh window.
    expect(planRecovery({ state: "developing", recovery: true, limits: FULL_LIMITS, createdAt, now: Date.parse("2026-01-01T00:30:00.000Z") }).stop).toBe(false);
    expect(planRecovery({
      state: "developing",
      recovery: true,
      limits: FULL_LIMITS,
      createdAt,
      deadlineBaseAt: "2026-01-01T01:59:00.000Z",
      now: Date.parse("2026-01-01T02:00:00.000Z"),
    }).stop).toBe(false);
    // 0/absent duration is unlimited → never a deadline stop.
    expect(planRecovery({ state: "developing", recovery: true, limits: NO_LIMITS, createdAt, now: Date.parse("2027-01-01T00:00:00.000Z") }).stop).toBe(false);
  });

  it("evaluates max rounds before budget/deadline (deterministic reason)", () => {
    const plan = planRecovery({
      state: "reviewing",
      recovery: true,
      round: 3,
      maxRounds: 3,
      limits: FULL_LIMITS,
      usage: { inputTokens: 9999, outputTokens: 9999, estimatedCost: 99 },
      createdAt: "2026-01-01T00:00:00.000Z",
      now: Date.parse("2026-01-02T00:00:00.000Z"),
    });
    expect(plan).toMatchObject({ stop: true, reason: "max_rounds" });
  });
});
