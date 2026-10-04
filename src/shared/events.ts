import type { RunEvent } from "./types";

/**
 * Merges two run-event lists and sorts ascending.
 *
 * Events are identified by `runId + seq` (not `seq` alone) so two runs — both
 * of which start their sequences at 1 — can never overwrite each other if a
 * stray event from a previously selected run reaches the merge.
 *
 * The client fetches an initial event snapshot while an SSE stream is already
 * live, so the snapshot can be older than events that just arrived. Merging
 * (instead of replacing) keeps those newly streamed events — e.g. a
 * `chat.message` that drives a rework branch — from being dropped.
 */
export function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const byKey = new Map<string, RunEvent>();
  for (const event of current) byKey.set(`${event.runId}:${event.seq}`, event);
  for (const event of incoming) byKey.set(`${event.runId}:${event.seq}`, event);
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}
