/**
 * NEW-08 follow-up (AUD-06 / NEW-05): two store errors are client-visible
 * conflicts and must not fall through to the generic 500 handler:
 *  - `INVALID_STATE_TRANSITION` — the state machine rejected the change.
 *  - `RUN_CONFLICT` — a compare-and-swap write lost a race against another
 *    committed writer; the caller should re-read and retry.
 */
export interface ConflictReply {
  status: 409;
  code: "INVALID_STATE_TRANSITION" | "RUN_CONFLICT";
  message: string;
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
