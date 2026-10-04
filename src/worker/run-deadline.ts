/**
 * AUD-10 / COST-002: product semantics for run budgets (docs/03 deployment
 * record) are that a duration of 0 means UNLIMITED (`生产默认全部为 0（不限制）`).
 * Only a strictly positive value arms an elapsed-time deadline; 0, a negative
 * value, NaN and an absent/undefined value all mean "no limit".
 *
 * The earlier implementation always armed `setTimeout(..., deadlineAt - now)`;
 * with `maxDurationSeconds = 0` the deadline collapsed to `Math.max(started,
 * createdAt)` (i.e. now), so every run aborted immediately with a timeout. This
 * module centralizes the "0/absent = unlimited" rule so the run deadline, the
 * per-command timeout and the container timeout all agree.
 */

/** The effective delay is only meaningful for a finite, strictly positive limit. */
export function isUnlimitedDuration(value: number | undefined | null): boolean {
  return !Number.isFinite(value as number) || (value as number) <= 0;
}

/**
 * Milliseconds until the run deadline, or `undefined` when the duration is
 * unlimited (0/absent). `startedAt` is when this worker began the run and
 * `createdAt` when the run document was created, so a queued run does not get
 * extra time beyond the configured budget.
 *
 * RESUME: `deadlineBaseAt` is the epoch-ms marker persisted by the server when a
 * human continues/resumes a run. When present, the window is measured from
 * `max(deadlineBaseAt, startedAt, createdAt)` — a fresh `maxDurationSeconds`
 * window for the continued round — instead of the original `createdAt`, which
 * has usually already elapsed by the time the operator clicks 「继续开发」.
 */
export function runDeadlineDelayMs(input: {
  startedAt: number;
  createdAt: number;
  maxDurationSeconds: number;
  /** RESUME: fresh window start (epoch ms) written on human continue/resume. */
  deadlineBaseAt?: number;
  /** Injectable clock, defaults to `Date.now()`. */
  now?: number;
}): number | undefined {
  if (isUnlimitedDuration(input.maxDurationSeconds)) return undefined;
  const now = input.now ?? Date.now();
  const budgetMs = input.maxDurationSeconds * 1000;
  const resumeBaseAt = Number.isFinite(input.deadlineBaseAt as number) ? (input.deadlineBaseAt as number) : undefined;
  if (resumeBaseAt !== undefined) {
    const base = Math.max(resumeBaseAt, input.createdAt);
    const windowDeadlineAt = base + budgetMs;
    // Never bounce instantly: a human continuation must get a full window even
    // when the marker's window had already elapsed before this job began (busy
    // worker, restart, retry). Flooring on `startedAt` — equivalently
    // `max(deadlineBaseAt, startedAt, createdAt) + budget` — means the resume
    // always starts a fresh budget instead of an immediate deadline_exceeded.
    const deadlineAt = windowDeadlineAt > input.startedAt ? windowDeadlineAt : input.startedAt + budgetMs;
    return Math.max(0, deadlineAt - now);
  }
  // Initial round (no resume marker): unchanged — a run queued past its budget
  // does not get extra time beyond the configured window.
  const deadlineAt = Math.max(input.startedAt, input.createdAt + budgetMs);
  return Math.max(0, deadlineAt - now);
}

export interface RunDeadlineTimer {
  /** Whether the deadline elapsed and `onExceed` was invoked. */
  exceeded(): boolean;
  /** Armed delay in ms, or `undefined` when the duration is unlimited. */
  readonly delayMs: number | undefined;
  /** Cancels the timer (no-op when unlimited or already fired). */
  cancel(): void;
}

/**
 * Arms the run deadline for a positive duration and calls `onExceed` once when
 * it elapses. With 0/absent duration no timer is created and the callback is
 * never called, so the run is allowed to finish on its own.
 */
export function startRunDeadline(
  input: { startedAt: number; createdAt: number; maxDurationSeconds: number; deadlineBaseAt?: number; now?: number },
  onExceed: () => void,
): RunDeadlineTimer {
  const delayMs = runDeadlineDelayMs(input);
  let exceeded = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  if (delayMs !== undefined) {
    handle = setTimeout(() => {
      exceeded = true;
      onExceed();
    }, delayMs);
  }
  return {
    exceeded: () => exceeded,
    delayMs,
    cancel: () => {
      if (handle) clearTimeout(handle);
    },
  };
}
