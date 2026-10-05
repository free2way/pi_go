import { mergeRunEvents as mergeRunEventsByRun } from "../shared/events";
import type { Run, RunEvent } from "../shared/types";

/**
 * AUD-17 / AT-UI-006/007: client-side event/run merge rules.
 *
 * Events are merged by their monotonic per-run `seq`, so a snapshot that arrives
 * after the SSE stream can never overwrite newer live events. The buffered array
 * is hard-capped so a long run cannot exhaust browser memory.
 */

/** Hard cap on buffered events kept in memory (newest are kept). */
export const MAX_BUFFERED_EVENTS = 2_000;

export function mergeRunEvents(current: RunEvent[], incoming: RunEvent[], cap = MAX_BUFFERED_EVENTS): RunEvent[] {
  // Delegate the merge to the shared helper (keyed by `runId:seq`, so two runs
  // sharing seq numbers can never overwrite each other) and keep the AUD-17
  // memory cap on top of it.
  const sorted = mergeRunEventsByRun(current, incoming);
  return cap > 0 && sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;
}

/**
 * Accepts a run snapshot only when it is at least as new as the current one.
 * `lastSeq` is monotonic per run; `updatedAt` breaks ties. A slow, older response
 * can therefore never rewind the rendered state.
 */
export function shouldAcceptRun(current: Run | undefined, next: Run): boolean {
  if (!current || current.id !== next.id) return true;
  if (next.lastSeq !== current.lastSeq) return next.lastSeq > current.lastSeq;
  return next.updatedAt >= current.updatedAt;
}

/**
 * Latest `review.nonblocking_deferred` notice for the run detail. Under
 * `reviewScope: "blocking"` the worker accepts a round whose only remaining
 * findings are medium/low; this keeps those deferred findings visible instead of
 * silent. Returns `undefined` when the run never deferred anything.
 */
export interface DeferredNonBlockingNotice {
  round: number;
  count: number;
  ids: string[];
  message: string;
}

export function deferredNonBlockingNotice(events: RunEvent[]): DeferredNonBlockingNotice | undefined {
  const latest = [...events].reverse().find((event) => event.type === "review.nonblocking_deferred");
  if (!latest) return undefined;
  const meta = latest.meta ?? {};
  const ids = Array.isArray(meta.ids) ? meta.ids.filter((id): id is string => typeof id === "string") : [];
  const count = typeof meta.count === "number" && Number.isFinite(meta.count) ? meta.count : ids.length;
  const round = typeof meta.round === "number" && Number.isFinite(meta.round) ? meta.round : latest.round;
  return { round, count, ids, message: latest.message };
}
