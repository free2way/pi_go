import type { RunEvent, RunReleaseStatus } from "../shared/types";

export const RELEASE_PROGRESS_STAGES = ["validating", "deploying", "networking", "smoke", "verifying"] as const;
export type ReleaseProgressStage = typeof RELEASE_PROGRESS_STAGES[number];
export type ReleaseProgressState = "waiting" | "active" | "done" | "failed";

export function browserDeploymentUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "host.docker.internal" || hostname === "localhost" || hostname === "0.0.0.0"
      || hostname === "::1" || hostname.startsWith("127.")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function releaseProgressEventStage(event: RunEvent): ReleaseProgressStage | undefined {
  const stage = event.type === "run.release_progress" ? event.meta?.stage : undefined;
  return RELEASE_PROGRESS_STAGES.includes(stage as ReleaseProgressStage) ? stage as ReleaseProgressStage : undefined;
}

export function releaseProgressStepState(input: {
  index: number;
  latestStageIndex: number;
  releaseStatus?: RunReleaseStatus;
  running: boolean;
}): ReleaseProgressState {
  if (input.releaseStatus === "succeeded") return "done";
  if (input.index < input.latestStageIndex) return "done";
  if (input.index === input.latestStageIndex) return input.releaseStatus === "failed" ? "failed" : "active";
  if (input.latestStageIndex < 0 && input.index === 0 && input.running) return "active";
  return "waiting";
}
