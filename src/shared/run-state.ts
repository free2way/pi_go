import type { Run, RunState } from "./types";

/**
 * States that end a run's lifecycle. Once reached, no further agent work or
 * internal worker updates should mutate the run.
 */
export const terminalRunStates: RunState[] = ["completed", "needs_human", "failed", "cancelled"];

export function isTerminalRunState(state: RunState): boolean {
  return terminalRunStates.includes(state);
}

/**
 * Terminal states that must NOT hold a run-level story block (kanban "阻塞").
 * `failed`/`cancelled` are final and have no follow-up action, so a story parked
 * by one is released automatically back to its pre-block status.
 *
 * `needs_human` is deliberately excluded even though it is terminal for the run
 * lifecycle: the run is parked waiting for a human, so its block stays until the
 * run is resolved. Manual unblock then rejects with `BLOCKED_BY_RUN` naming the
 * run id (a deliberate requirement).
 */
export const runStatesReleasingStoryBlocks: RunState[] = ["completed", "failed", "cancelled"];

export function releasesStoryBlocks(state: RunState): boolean {
  return runStatesReleasingStoryBlocks.includes(state);
}

/** Audit note recorded when a run reaches a terminal state and its block is lifted. */
export function storyBlockReleaseNote(state: RunState): string {
  return `运行已终态（${state}），自动解除运行级阻塞`;
}

/**
 * Returns an error message when an internal worker update must be rejected.
 * Terminal runs (e.g. one the user just cancelled) must stay final: accepting
 * a late patch or business event would overwrite `cancelled` and append
 * phantom checks/rework messages after `run.cancelled`.
 */
export function internalUpdateRejection(run: Run): string | undefined {
  return isTerminalRunState(run.state) ? `Run is in terminal state ${run.state}` : undefined;
}
