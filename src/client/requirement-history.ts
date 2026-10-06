import type { HumanNote, HumanNoteKind, Run, RunState } from "../shared/types";
import { DEFAULT_LOCALE, intlLocale, t, type Locale, type MessageKey } from "../shared/i18n";

/**
 * 需求历史: pure formatting helpers for the searchable requirement history view.
 * Kept free of React/DOM so they can be unit tested directly.
 */

/**
 * Locale-neutral label keys shared by the history view and the run dashboard.
 * The rendered text lives in the shared catalog, not here.
 */
const RUN_STATE_KEYS: Record<RunState, MessageKey> = {
  queued: "run.state.queued",
  preparing: "run.state.preparing",
  developing: "run.state.developing",
  checking: "run.state.checking",
  reviewing: "run.state.reviewing",
  completed: "run.state.completed",
  needs_human: "run.state.needs_human",
  failed: "run.state.failed",
  cancelled: "run.state.cancelled",
};

export function runStateKey(state: RunState): MessageKey {
  return RUN_STATE_KEYS[state] ?? "common.unknown";
}

export function runStateLabel(state: RunState, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, runStateKey(state));
}

/** Every state the history filter offers, in dashboard order. */
export const RUN_STATE_OPTIONS: RunState[] = [
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

/** Missing `humanNotes` (runs written before the field existed) reads as `[]`. */
export function humanNotesOf(run: Pick<Run, "humanNotes">): HumanNote[] {
  return Array.isArray(run.humanNotes) ? run.humanNotes : [];
}

const NOTE_KIND_KEYS: Record<HumanNoteKind, MessageKey> = {
  approve_continue: "note.kind.approve_continue",
  approve_accept: "note.kind.approve_accept",
  resume: "note.kind.resume",
  reject: "note.kind.reject",
  reopen: "note.kind.reopen",
};

export function humanNoteKindKey(kind: HumanNoteKind): MessageKey {
  return NOTE_KIND_KEYS[kind] ?? "common.unknown";
}

export function humanNoteKindLabel(kind: HumanNoteKind, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, humanNoteKindKey(kind));
}

/** Collapses a multi-line requirement into one line, truncated for the list row. */
export function requirementSummary(task: string, maxLength = 140): string {
  const collapsed = (task ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** The full text a 复制 click puts on the clipboard (title + task). */
export function copyTextForRun(run: Pick<Run, "title" | "task">): string {
  const title = (run.title ?? "").trim();
  const task = (run.task ?? "").trim();
  return [title, task].filter(Boolean).join("\n\n");
}

/**
 * Short local timestamp for the history list/detail. Uses a fixed
 * month/day + 24h shape so both rows read consistently in every locale.
 */
export function formatHistoryTime(at: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
