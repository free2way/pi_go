import { withProviderRetry, type RetryPolicy } from "./provider-retry.js";
import type { ProviderErrorKind } from "./provider-errors.js";

/** Minimal budget surface a provider attempt must account against (NEW-08). */
export interface AttemptBudget {
  reserve(): void;
  recordUnknown(): void;
}

export interface RunProviderOperationOptions<T> {
  budget?: AttemptBudget;
  policy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; kind: ProviderErrorKind; message: string }) => void | Promise<void>;
  /** Called once after the retry loop returns a successful result. */
  onSuccess?: (result: T) => void | Promise<void>;
}

/**
 * NEW-08 / COST-002/003: runs one provider operation with bounded retries while
 * accounting for *every* provider attempt. Each attempt reserves a model-call
 * slot first; a failed attempt is counted as an unknown-usage call. Because the
 * reservation is evaluated before the retry, the hard model-call limit refuses
 * the next retry instead of being bypassed by the retry loop.
 */
export async function runProviderOperation<T>(
  operation: () => Promise<T>,
  options: RunProviderOperationOptions<T> = {},
): Promise<T> {
  const result = await withProviderRetry(operation, {
    policy: options.policy,
    signal: options.signal,
    onRetry: options.onRetry,
    // A BudgetExceededError here escapes the retry loop: the cap is hard.
    beforeAttempt: () => options.budget?.reserve(),
    onAttemptFailure: () => options.budget?.recordUnknown(),
  });
  await options.onSuccess?.(result);
  return result;
}
