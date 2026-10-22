/**
 * NEW-08 follow-up (AUD-06 / NEW-05): two store errors are client-visible
 * conflicts and must not fall through to the generic 500 handler:
 *  - `INVALID_STATE_TRANSITION` — the state machine rejected the change.
 *  - `RUN_CONFLICT` — a compare-and-swap write lost a race against another
 *    committed writer; the caller should re-read and retry.
 */
import { diagnosticSecrets, redactDiagnosticText } from "../shared/diagnostics.js";

export interface ConflictReply {
  status: 409;
  code: "INVALID_STATE_TRANSITION" | "RUN_CONFLICT";
  message: string;
}

export function isStorageFailure(message: string): boolean {
  return /ECONNREFUSED|Connection terminated|connection is closed|connection timeout|ETIMEDOUT|terminating connection|57P0|STORAGE_UNAVAILABLE|no space left on device|ENOSPC/i.test(message);
}

/** Classify the original error, then redact in full before any display limit. */
export function requestErrorReply(error: unknown, environment: NodeJS.ProcessEnv = process.env) {
  const raw = String((error as { message?: unknown } | null)?.message ?? "");
  const message = redactDiagnosticText(raw, diagnosticSecrets(environment));
  const storage = isStorageFailure(raw);
  const status = storage ? 503 : (error as { statusCode?: number } | null)?.statusCode ?? 500;
  return {
    status,
    storage,
    message,
    body: storage
      ? { error: `存储不可用：${message.slice(0, 200)}`, code: "STORAGE_UNAVAILABLE" }
      : { error: status >= 500 ? "Internal error" : message },
  };
}

/** Maps a state/conflict store error to a 409 reply descriptor, or undefined. */
export function conflictReplyFor(error: unknown): ConflictReply | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code !== "INVALID_STATE_TRANSITION" && code !== "RUN_CONFLICT") return undefined;
  return {
    status: 409,
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
