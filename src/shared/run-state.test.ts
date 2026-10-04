import { describe, expect, it } from "vitest";
import { baseDemoRun } from "../server/demo-runner.js";
import { internalUpdateRejection, isTerminalRunState, terminalRunStates } from "./run-state.js";
import type { RunState } from "./types";

const runWith = (state: RunState) => ({
  ...baseDemoRun({ title: "Terminal guard", task: "A sufficiently long task", repository: "test/repo" }),
  state,
});

describe("isTerminalRunState", () => {
  it("flags lifecycle end states as terminal", () => {
    for (const state of terminalRunStates) expect(isTerminalRunState(state)).toBe(true);
    expect(isTerminalRunState("developing")).toBe(false);
    expect(isTerminalRunState("checking")).toBe(false);
    expect(isTerminalRunState("reviewing")).toBe(false);
  });
});

describe("internalUpdateRejection", () => {
  it("rejects late internal updates once the run is terminal", () => {
    expect(internalUpdateRejection(runWith("cancelled"))).toContain("cancelled");
    expect(internalUpdateRejection(runWith("completed"))).toContain("completed");
    expect(internalUpdateRejection(runWith("failed"))).toContain("failed");
  });

  it("allows updates while the run is still active", () => {
    expect(internalUpdateRejection(runWith("developing"))).toBeUndefined();
    expect(internalUpdateRejection(runWith("checking"))).toBeUndefined();
    expect(internalUpdateRejection(runWith("reviewing"))).toBeUndefined();
  });
});
