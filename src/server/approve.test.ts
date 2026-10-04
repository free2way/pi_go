import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/types.js";
import { approveEventMeta, planApprove, summarizeOpenFindings } from "./approve.js";
import { InvalidStateTransitionError, assertTransition } from "./run-store-pg.js";

function finding(id: string, resolved: boolean): Pick<Finding, "id" | "resolved"> {
  return { id, resolved };
}

// RUN-006: the approve route used to complete a needs_human run and silently
// accept every open finding. These tests pin the two explicit intents.
describe("planApprove (RUN-006)", () => {
  it("continue: goes back to development, never completes, keeps the open-findings count", () => {
    const plan = planApprove({ mode: "continue", findings: [finding("f1", false), finding("f2", true), finding("f3", false)] });
    expect(plan.decision).toBe("continue");
    if (plan.decision !== "continue") throw new Error("expected continue");
    expect(plan.targetState).toBe("developing");
    expect(plan.openFindings).toEqual({ count: 2, ids: ["f1", "f3"] });
    expect(approveEventMeta(plan, "owner_1")).toEqual({
      approvedBy: "owner_1",
      mode: "continue",
      openFindingsCount: 2,
      openFindings: { count: 2, ids: ["f1", "f3"] },
    });
  });

  it("default mode is accept and refuses open findings without acknowledgement (409 OPEN_FINDINGS)", () => {
    const plan = planApprove({ findings: [finding("f1", false), finding("f2", false)] });
    expect(plan.decision).toBe("conflict");
    if (plan.decision !== "conflict") throw new Error("expected conflict");
    expect(plan.status).toBe(409);
    expect(plan.code).toBe("OPEN_FINDINGS");
    expect(plan.openFindings).toEqual({ count: 2, ids: ["f1", "f2"] });
  });

  it("accept + acknowledgeOpenFindings completes with the accepted open findings in the meta", () => {
    const plan = planApprove({ mode: "accept", acknowledgeOpenFindings: true, findings: [finding("f1", false), finding("f2", true)] });
    expect(plan.decision).toBe("accept");
    if (plan.decision !== "accept") throw new Error("expected accept");
    expect(plan.targetState).toBe("completed");
    expect(plan.acknowledged).toBe(true);
    expect(approveEventMeta(plan, "owner_1")).toEqual({
      approvedBy: "owner_1",
      mode: "accept",
      acceptedOpenFindings: { count: 1, ids: ["f1"] },
    });
  });

  it("accept with zero open findings completes without acknowledgement", () => {
    const plan = planApprove({ mode: "accept", findings: [finding("f1", true)] });
    expect(plan.decision).toBe("accept");
    if (plan.decision !== "accept") throw new Error("expected accept");
    expect(plan.targetState).toBe("completed");
    expect(plan.acknowledged).toBe(false);
    expect(plan.openFindings).toEqual({ count: 0, ids: [] });
    expect(approveEventMeta(plan, "owner_1")).toEqual({
      approvedBy: "owner_1",
      mode: "accept",
      acceptedOpenFindings: { count: 0, ids: [] },
    });
  });

  it("treats a missing findings array as zero open findings", () => {
    expect(summarizeOpenFindings(undefined)).toEqual({ count: 0, ids: [] });
    const plan = planApprove({ mode: "accept" });
    expect(plan.decision).toBe("accept");
    expect(plan.openFindings.count).toBe(0);
  });
});

describe("needs_human -> developing state edge (RUN-006)", () => {
  it("allows the continued run to enter development from needs_human", () => {
    expect(() => assertTransition("needs_human", "developing")).not.toThrow();
  });

  it("still rejects a transition that would rewind a terminal state", () => {
    expect(() => assertTransition("completed", "developing")).toThrow(InvalidStateTransitionError);
  });
});
