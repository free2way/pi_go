import { describe, expect, it } from "vitest";
import { mergeOptionState } from "./merge-option";

describe("merge option gating (A2/UX)", () => {
  it("enables the merge checkbox for an admin", () => {
    const state = mergeOptionState({ isAdmin: true });
    expect(state).toEqual({ show: true, disabled: false, hint: "" });
  });

  it("disables it for a non-admin and explains why", () => {
    const state = mergeOptionState({ isAdmin: false });
    expect(state.show).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.hint).toContain("仅管理员");
  });

  it("keeps it disabled (and does not claim admin) while the identity is unknown", () => {
    const state = mergeOptionState(undefined);
    expect(state.show).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.hint).toContain("仅管理员");
  });

  it("explains the restriction in the selected language", () => {
    expect(mergeOptionState({ isAdmin: false }, "en").hint).toContain("Only admins");
    expect(mergeOptionState(undefined, "en").hint).toContain("Only admins");
  });

  it("treats a user object without isAdmin as non-admin", () => {
    expect(mergeOptionState({}).disabled).toBe(true);
  });
});
