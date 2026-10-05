import { describe, expect, it } from "vitest";
import { baseDemoRun } from "../server/demo-runner.js";
import { internalUpdateRejection, isTerminalRunState, releasesStoryBlocks, runStatesReleasingStoryBlocks, storyBlockReleaseNote, terminalRunStates } from "./run-state.js";
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

describe("releasesStoryBlocks", () => {
  it("releases the block for every terminal run that cannot advance on its own", () => {
    for (const state of runStatesReleasingStoryBlocks) expect(releasesStoryBlocks(state)).toBe(true);
    expect(releasesStoryBlocks("completed")).toBe(true);
    expect(releasesStoryBlocks("failed")).toBe(true);
    expect(releasesStoryBlocks("cancelled")).toBe(true);
  });

  it("keeps the block while the run still needs a human or is active", () => {
    // needs_human is terminal for the run lifecycle but deliberately still holds
    // the story block: a human must resolve the run first.
    expect(releasesStoryBlocks("needs_human")).toBe(false);
    expect(releasesStoryBlocks("developing")).toBe(false);
    expect(releasesStoryBlocks("reviewing")).toBe(false);
  });

  it("records a Chinese audit note naming the terminal state", () => {
    expect(storyBlockReleaseNote("cancelled")).toBe("运行已终态（cancelled），自动解除运行级阻塞");
    expect(storyBlockReleaseNote("failed")).toContain("failed");
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
