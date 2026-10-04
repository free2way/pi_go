import { describe, expect, it } from "vitest";
import { conflictReplyFor } from "./request-errors.js";
import { InvalidStateTransitionError, RunConflictError } from "./run-store-pg.js";

describe("conflictReplyFor", () => {
  it("maps a lost compare-and-swap race to a 409 RUN_CONFLICT (NEW-05)", () => {
    const reply = conflictReplyFor(new RunConflictError("run_1", "Run run_1 was modified concurrently; the stale write was rejected"));
    expect(reply).toEqual({
      status: 409,
      code: "RUN_CONFLICT",
      message: "Run run_1 was modified concurrently; the stale write was rejected",
    });
  });

  it("keeps mapping illegal state transitions to 409 INVALID_STATE_TRANSITION", () => {
    const reply = conflictReplyFor(new InvalidStateTransitionError("completed", "developing"));
    expect(reply?.status).toBe(409);
    expect(reply?.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("ignores unrelated errors so they still become 500s", () => {
    expect(conflictReplyFor(new Error("boom"))).toBeUndefined();
    expect(conflictReplyFor(undefined)).toBeUndefined();
  });
});
