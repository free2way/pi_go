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
  const merged = new Map<number, RunEvent>();
  for (const event of current) merged.set(event.seq, event);
  for (const event of incoming) {
    // Same seq = same event; keep the first occurrence (dedupe).
    if (!merged.has(event.seq)) merged.set(event.seq, event);
  }
  const sorted = [...merged.values()].sort((a, b) => a.seq - b.seq);
  const bounded = cap > 0 && sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;
  return bounded;
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
