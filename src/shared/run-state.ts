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
 * Returns an error message when an internal worker update must be rejected.
 * Terminal runs (e.g. one the user just cancelled) must stay final: accepting
 * a late patch or business event would overwrite `cancelled` and append
 * phantom checks/rework messages after `run.cancelled`.
 */
export function internalUpdateRejection(run: Run): string | undefined {
  return isTerminalRunState(run.state) ? `Run is in terminal state ${run.state}` : undefined;
}
