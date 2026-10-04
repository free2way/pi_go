import { describe, expect, it } from "vitest";
import { InvalidStateTransitionError, assertTransition } from "./run-store-pg.js";
import { planReopen, reopenEventMeta } from "./run-reopen.js";

describe("planReopen (B1)", () => {
  it("refuses to reopen anything that is not completed", () => {
    const plan = planReopen({ state: "needs_human", isAdmin: true, isOwner: true });
    expect(plan.allowed).toBe(false);
    if (plan.allowed) throw new Error("expected refusal");
    expect(plan.status).toBe(409);
    expect(plan.code).toBe("REOPEN_NOT_ALLOWED");
  });

  it("lets an admin reopen without an explicit confirm", () => {
    expect(planReopen({ state: "completed", isAdmin: true, isOwner: false })).toEqual({ allowed: true, targetState: "needs_human", reason: "admin" });
  });

  it("requires the owner to confirm explicitly", () => {
    const withoutConfirm = planReopen({ state: "completed", isAdmin: false, isOwner: true });
    expect(withoutConfirm).toMatchObject({ allowed: false, code: "CONFIRM_REQUIRED", status: 409 });
    expect(planReopen({ state: "completed", isAdmin: false, isOwner: true, confirm: true })).toEqual({
      allowed: true,
      targetState: "needs_human",
      reason: "owner-confirmed",
    });
  });

  it("refuses a non-owner, non-admin caller", () => {
    expect(planReopen({ state: "completed", isAdmin: false, isOwner: false, confirm: true })).toMatchObject({ allowed: false, code: "ADMIN_REQUIRED", status: 403 });
  });
});

describe("reopenEventMeta (B1)", () => {
  it("records the operator and note", () => {
    expect(reopenEventMeta({ reopenedBy: "u1", reason: "admin", note: "测试失败" })).toEqual({ reopenedBy: "u1", reason: "admin", note: "测试失败" });
  });
});

describe("completed -> needs_human state edge (B1)", () => {
  it("allows the guarded reopen transition", () => {
    expect(() => assertTransition("completed", "needs_human")).not.toThrow();
  });

  it("still rejects a rewind straight back to development", () => {
    expect(() => assertTransition("completed", "developing")).toThrow(InvalidStateTransitionError);
  });
});
