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
 */
export function runDeadlineDelayMs(input: {
  startedAt: number;
  createdAt: number;
  maxDurationSeconds: number;
  /** Injectable clock, defaults to `Date.now()`. */
  now?: number;
}): number | undefined {
  if (isUnlimitedDuration(input.maxDurationSeconds)) return undefined;
  const now = input.now ?? Date.now();
  const deadlineAt = Math.max(input.startedAt, input.createdAt + input.maxDurationSeconds * 1000);
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
  input: { startedAt: number; createdAt: number; maxDurationSeconds: number; now?: number },
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
