import type { Run, RunEvent } from "../shared/types";

/**
 * Guards asynchronous run/stream updates against selection changes.
 *
 * The run detail view can have several in-flight requests (initial snapshot,
 * SSE event refresh) for the run that was selected when they started. Once the
 * user selects another run, the old effect is invalidated and every late
 * response must be dropped so it cannot overwrite the newly selected run.
 */
export interface RunSelectionGuard {
  readonly runId: string;
  isActive(): boolean;
  /** Accepts a refreshed `Run` only if it is still the active selection. */
  acceptRun(run: Run): boolean;
  /** Accepts a streamed event only if it belongs to the active selection. */
  acceptEvent(event: RunEvent): boolean;
  invalidate(): void;
}

export function createRunSelectionGuard(runId: string): RunSelectionGuard {
  let active = true;
  return {
    runId,
    isActive: () => active,
    acceptRun: (run) => active && run.id === runId,
    acceptEvent: (event) => active && event.runId === runId,
    invalidate: () => { active = false; },
  };
}

/** Keeps only the events that belong to the given run. */
export function eventsForRun(events: RunEvent[], runId: string | undefined): RunEvent[] {
  return runId ? events.filter((event) => event.runId === runId) : [];
}
