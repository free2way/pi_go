/**
 * RESUME / run_50b554e824954ecd: a run created before the "0 = unlimited" fix keeps
 * a positive `budget.maxDurationSeconds` (e.g. 1800), so its original
 * `createdAt` window has already elapsed by the time the operator clicks
 * 「继续开发」. Without a fresh window base the worker computes a deadline in the
 * past and aborts the resumed round immediately with `run.deadline_exceeded`,
 * bouncing it straight back to needs_human.
 *
 * Every human continuation (`approve mode:"continue"` and the resume route)
 * therefore stamps a fresh window base on the run document. The worker measures
 * the next round from `max(deadlineBaseAt, startedAt, createdAt)`.
 */
export interface DeadlineBasePatch {
  /** ISO timestamp at which the continued round's duration window starts. */
  deadlineBaseAt: string;
}

/** Builds the additive `deadlineBaseAt` marker written on a human continuation. */
export function resumeDeadlinePatch(now: string): DeadlineBasePatch {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error(`resumeDeadlinePatch: invalid timestamp ${JSON.stringify(now)}`);
  return { deadlineBaseAt: at.toISOString() };
}
