import type { HumanNote } from "../shared/types.js";

/**
 * 需求历史: durable, append-only human notes on a run.
 *
 * Notes are never edited or removed, so a merge that appears late (another web
 * instance wrote first, or a retry replays the same patch) must union rather
 * than replace. The identity of a note is the tuple below: a stale patch that
 * carries an already-persisted note cannot duplicate it, and a concurrent note
 * written elsewhere cannot be dropped by the stale patch.
 */
function noteKey(note: HumanNote): string {
  return `${note.at}|${note.kind}|${note.note}|${note.by ?? ""}`;
}

/** Missing `humanNotes` (runs written before the field existed) reads as `[]`. */
export function humanNotesOf(value: HumanNote[] | undefined | null): HumanNote[] {
  return Array.isArray(value) ? value : [];
}

/** Returns `existing` plus `note`; a note already present is not duplicated. */
export function appendHumanNote(existing: HumanNote[] | undefined | null, note: HumanNote): HumanNote[] {
  return mergeHumanNotes(existing, [note]);
}

/**
 * Append-only union of note lists, ordered by time. `patchNotes` is what a
 * caller read + wants to add; `currentNotes` is the authoritative row. Notes
 * present in either side are kept exactly once, so merge is idempotent.
 */
export function mergeHumanNotes(
  currentNotes: HumanNote[] | undefined | null,
  patchNotes: HumanNote[] | undefined | null,
): HumanNote[] {
  const merged = new Map<string, HumanNote>();
  for (const note of [...humanNotesOf(currentNotes), ...humanNotesOf(patchNotes)]) {
    if (!note || typeof note.note !== "string" || !note.note) continue;
    const key = noteKey(note);
    if (!merged.has(key)) merged.set(key, note);
  }
  return [...merged.values()].sort((a, b) => a.at.localeCompare(b.at));
}
