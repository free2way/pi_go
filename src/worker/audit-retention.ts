/**
 * AT-JEV-056 (docs/27 §7.6), worker side: the low-frequency trigger that asks
 * the web to run one decision-audit retention sweep.
 *
 * The worker holds no database connection (see `Dockerfile.worker`, which only
 * ships `src/worker` + `src/shared`), so it cannot delete audit rows itself.
 * This mirrors the existing maintenance shape: the worker's tick calls an
 * internal endpoint, and the web — the only process with a database — does the
 * work (`reclaimPendingJobs` → `/api/internal/jobs/pending` is the precedent).
 *
 * Contracts:
 *  1. Opt-in on the worker's own env. `PI_DECISION_AUDIT_RETENTION_DAYS` absent,
 *     blank, or `0` is a strict no-op: no HTTP call, no log line, nothing. That
 *     also makes the default, safe configuration free of any network traffic.
 *  2. Self-throttled to one request per `intervalMs` (hourly by default), so it
 *     can be attached to the existing 60s maintenance tick without a query
 *     storm; the web throttles as well and stays authoritative.
 *  3. It never throws. Any failure (transport, non-2xx, timeout) becomes ONE
 *     bounded warning without credentials, so the worker's maintenance loop is
 *     never disturbed by retention.
 *
 * The web side is configured with the same variable names; both services must
 * receive the setting for a sweep to happen, which is why `compose.yaml`
 * forwards it to both.
 */

import { decisionAuditRetentionEnabled } from "../shared/decision-retention.js";

/** Internal web route that performs one sweep (see `decision-routes.ts`). */
export const DECISION_AUDIT_RETENTION_PATH = "/decisions/audit/retention";

/** Worker-side cadence. Hourly matches the "low frequency" requirement. */
export const DECISION_AUDIT_RETENTION_TRIGGER_INTERVAL_MS = 60 * 60_000;

/** Ceiling for the internal hop; the web caps its own SQL work well below it. */
export const DECISION_AUDIT_RETENTION_REQUEST_TIMEOUT_MS = 15_000;

export type AuditRetentionSend = (pathName: string, init: RequestInit, timeoutMs: number) => Promise<unknown>;

export interface AuditRetentionTriggerOptions {
  /** Transport, normally the worker's `internalRequest` (same internal token). */
  send: AuditRetentionSend;
  env?: Record<string, string | undefined>;
  now?: () => number;
  intervalMs?: number;
  /** Warning sink; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

function safeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, 300);
}

/**
 * Builds the trigger. It resolves `true` only when a sweep request was actually
 * sent, and `false` in every no-op case (disabled, throttled, failed). It never
 * rejects.
 */
export function createAuditRetentionTrigger(options: AuditRetentionTriggerOptions): () => Promise<boolean> {
  const env = options.env ?? process.env;
  const enabled = decisionAuditRetentionEnabled(env);
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DECISION_AUDIT_RETENTION_TRIGGER_INTERVAL_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let lastRunMs = 0;

  return async function triggerAuditRetention(): Promise<boolean> {
    // Default-off: no request, no log, no work at all.
    if (!enabled) return false;
    const at = now();
    if (at - lastRunMs < intervalMs) return false;
    // Set before the call so a failing sweep is not retried on every 60s tick.
    lastRunMs = at;
    try {
      await options.send(
        DECISION_AUDIT_RETENTION_PATH,
        { method: "POST", body: JSON.stringify({}) },
        DECISION_AUDIT_RETENTION_REQUEST_TIMEOUT_MS,
      );
      return true;
    } catch (error) {
      warn(`[decisions] audit retention sweep trigger failed: ${safeErrorText(error)}`);
      return false;
    }
  };
}
