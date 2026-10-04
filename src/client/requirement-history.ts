import type { HumanNote, HumanNoteKind, Run, RunState } from "../shared/types";

/**
 * 需求历史: pure formatting helpers for the searchable requirement history view.
 * Kept free of React/DOM so they can be unit tested directly.
 */

/** Chinese state labels shared by the history view and the run dashboard. */
export const runStateLabels: Record<RunState, string> = {
  queued: "排队中",
  preparing: "准备工作区",
  developing: "开发中",
  checking: "检查中",
  reviewing: "审核中",
  completed: "已通过",
  needs_human: "需要人工处理",
  failed: "失败",
  cancelled: "已取消",
};

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

const NOTE_KIND_LABELS: Record<HumanNoteKind, string> = {
  approve_continue: "继续开发",
  approve_accept: "接受交付",
  resume: "恢复下一轮",
  reject: "拒绝交付",
};

export function humanNoteKindLabel(kind: HumanNoteKind): string {
  return NOTE_KIND_LABELS[kind] ?? String(kind);
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
 * Short local timestamp for the history list/detail. Uses a fixed zh-CN shape
 * (month/day + 24h clock) so both rows read consistently.
 */
export function formatHistoryTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
