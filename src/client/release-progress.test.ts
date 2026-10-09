import { describe, expect, it } from "vitest";
import type { RunEvent } from "../shared/types";
import { browserDeploymentUrl, RELEASE_PROGRESS_STAGES, releaseProgressEventStage, releaseProgressStepState } from "./release-progress";

const event = (stage: unknown): RunEvent => ({
  seq: 1,
  runId: "run_1",
  round: 1,
  source: "system",
  type: "run.release_progress",
  message: "progress",
  at: "2026-10-09T00:00:00.000Z",
  meta: { stage },
});

describe("release progress view", () => {
  it("shows only browser-reachable deployment URLs", () => {
    expect(browserDeploymentUrl("https://staging.example.com/build/1")).toBe("https://staging.example.com/build/1");
    expect(browserDeploymentUrl("http://192.168.2.20:18080")).toBe("http://192.168.2.20:18080/");
    expect(browserDeploymentUrl("http://host.docker.internal:18080")).toBeUndefined();
    expect(browserDeploymentUrl("http://127.0.0.1:18080")).toBeUndefined();
    expect(browserDeploymentUrl("not a url")).toBeUndefined();
  });

  it("accepts only known executor stages", () => {
    expect(releaseProgressEventStage(event("smoke"))).toBe("smoke");
    expect(releaseProgressEventStage(event("arbitrary"))).toBeUndefined();
    expect(releaseProgressEventStage({ ...event("smoke"), type: "run.other" })).toBeUndefined();
  });

  it("advances the timeline without pretending future stages completed", () => {
    const latestStageIndex = RELEASE_PROGRESS_STAGES.indexOf("smoke");
    expect(releaseProgressStepState({ index: 1, latestStageIndex, releaseStatus: "triggered", running: true })).toBe("done");
    expect(releaseProgressStepState({ index: latestStageIndex, latestStageIndex, releaseStatus: "triggered", running: true })).toBe("active");
    expect(releaseProgressStepState({ index: 4, latestStageIndex, releaseStatus: "triggered", running: true })).toBe("waiting");
  });

  it("marks the observed failing stage and all stages done on success", () => {
    expect(releaseProgressStepState({ index: 2, latestStageIndex: 2, releaseStatus: "failed", running: false })).toBe("failed");
    expect(releaseProgressStepState({ index: 4, latestStageIndex: 2, releaseStatus: "failed", running: false })).toBe("waiting");
    expect(releaseProgressStepState({ index: 4, latestStageIndex: 2, releaseStatus: "succeeded", running: false })).toBe("done");
  });
});
