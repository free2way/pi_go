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

/**
 * Resolves the run that must back every run-scoped panel for a selection.
 *
 * The detail view keeps the previous run's snapshot until the fetch for the
 * newly selected id resolves. Rendering that snapshot is what made the header
 * (and topology, meta, checks, diff) stick on the old run. The list entry is a
 * complete `Run`, so it can back the header immediately while the snapshot is
 * still in flight.
 */
export function pickSelectedRun(runs: Run[], selectedId: string | undefined): Run | undefined {
  if (!selectedId) return undefined;
  return runs.find((run) => run.id === selectedId);
}

/**
 * True when a snapshot may back the currently selected run. A snapshot whose id
 * no longer matches the selection is stale by definition and must never render.
 */
export function isRunSelected(run: Run | undefined, selectedId: string | undefined): boolean {
  return Boolean(run && selectedId && run.id === selectedId);
}
