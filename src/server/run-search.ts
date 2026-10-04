import type { Run, RunState } from "../shared/types.js";
import { humanNotesOf } from "./run-notes.js";

/** Every valid run state, in the order the UI uses (mirrors `RunState`). */
export const RUN_STATES: readonly RunState[] = [
  "queued",
  "preparing",
  "developing",
  "checking",
  "reviewing",
  "completed",
  "needs_human",
  "failed",
  "cancelled",
];

const RUN_STATE_SET = new Set<string>(RUN_STATES);

export function isRunState(value: string): value is RunState {
  return RUN_STATE_SET.has(value);
}

export interface RunSearchFilter {
  /** Case-insensitive substring over title, task and humanNotes[].note. */
  query?: string;
  state?: RunState;
}

export type RunSearchParse =
  | { ok: true; filter: RunSearchFilter }
  | { ok: false; error: string };

/**
 * Parses `?query=` / `?state=` for `GET /api/runs`. Both are optional and the
 * endpoint stays backward compatible when they are absent; an unknown `state`
 * is rejected so the caller can answer 400 instead of silently ignoring it.
 */
export function parseRunSearch(raw: { query?: unknown; state?: unknown }): RunSearchParse {
  const filter: RunSearchFilter = {};
  if (raw.query !== undefined && raw.query !== null && String(raw.query).trim() !== "") {
    filter.query = String(raw.query).trim().slice(0, 200);
  }
  if (raw.state !== undefined && raw.state !== null && String(raw.state).trim() !== "") {
    const state = String(raw.state).trim();
    if (!isRunState(state)) return { ok: false, error: `Unknown run state: ${state.slice(0, 40)}` };
    filter.state = state;
  }
  return { ok: true, filter };
}

/**
 * Applies the owner-scoped search filter. The input list keeps its caller's
 * ordering (newest `updatedAt` first); no extra pagination is added because the
 * list is already bounded to one owner and the UI renders it client-side.
 */
export function searchRuns(runs: Run[], filter: RunSearchFilter): Run[] {
  const query = filter.query?.trim().toLowerCase();
  if (!query && !filter.state) return runs;
  return runs.filter((run) => {
    if (filter.state && run.state !== filter.state) return false;
    if (!query) return true;
    const haystacks = [run.title, run.task, ...humanNotesOf(run.humanNotes).map((note) => note.note)];
    return haystacks.some((value) => (value ?? "").toLowerCase().includes(query));
  });
}
