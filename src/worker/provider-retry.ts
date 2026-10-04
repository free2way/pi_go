import { classifyProviderError, type ProviderErrorKind } from "./provider-errors.js";

export interface RetryPolicy {
  /** Maximum number of provider attempts (first try included). */
  attempts: number;
  /** Base delay in milliseconds; grows exponentially with each retry. */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs: number;
  /** Error kinds worth retrying; permanent errors fail fast. */
  retryable: ProviderErrorKind[];
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: Number(process.env.PI_PROVIDER_ATTEMPTS || 3),
  baseDelayMs: Number(process.env.PI_PROVIDER_BACKOFF_MS || 2_000),
  maxDelayMs: Number(process.env.PI_PROVIDER_MAX_BACKOFF_MS || 30_000),
  retryable: ["rate_limit", "timeout", "provider", "unknown"],
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * REL-005 / AT-REL-006: transient provider failures (429, 5xx, timeouts) are
 * retried with bounded exponential backoff; permanent credential/model errors
 * fail immediately so the run reaches needs_human without spinning.
 */
export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: {
    policy?: Partial<RetryPolicy>;
    signal?: AbortSignal;
    onRetry?: (info: { attempt: number; delayMs: number; kind: ProviderErrorKind; message: string }) => void | Promise<void>;
  } = {},
): Promise<T> {
  const policy: RetryPolicy = { ...defaultRetryPolicy, ...options.policy };
  const attempts = Math.max(1, Math.min(6, policy.attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = (error as Error)?.message ?? String(error);
      const kind = classifyProviderError(message);
      const canRetry = attempt < attempts && policy.retryable.includes(kind) && !options.signal?.aborted;
      if (!canRetry) break;
      const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await options.onRetry?.({ attempt, delayMs, kind, message });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
