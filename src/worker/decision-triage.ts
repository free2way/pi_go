/**
 * Worker-side review-triage trigger (docs/26 §9.1/§9.2/§13).
 *
 * After the reviewer's structured `ReviewResult` has been parsed and its verdict
 * recorded, the worker asks the decision gateway for one shadow evaluation of
 * the redacted review state (`POST /api/internal/decisions/evaluate`). The call
 * is deliberately kept out of `index.ts`'s orchestration: it is a small,
 * side-effect-free unit here so its three contracts can be tested without
 * booting the worker's HTTP server.
 *
 *  1. Opt-in. It fires only when the WORKER's own env explicitly enables it
 *     (`PI_JEV_MODE` ∈ shadow|assist|enforce). An unset/`off`/mis-typed worker
 *     env is a strict no-op: no HTTP call, no event, no log line.
 *  2. Never fail the run. A gateway error, non-2xx or timeout is swallowed into
 *     a single warning; the review pipeline continues exactly as if the call had
 *     never happened. The worker-side timeout is a ceiling on this internal hop
 *     (the gateway owns the provider budget, default 3s, docs/26 §12).
 *  3. Never touch the run. The worker adds no usage for this call and emits no
 *     run events: the gateway already appends `decision.requested` plus exactly
 *     one outcome event per batch, and the audit row alone records the tokens
 *     and cost under its own `role: "decision"` accounting (docs/26 §13).
 */

/** Internal gateway path for one review-triage evaluation. */
export const REVIEW_TRIAGE_DECISION_PATH = "/decisions/evaluate";
export const REVIEW_TRIAGE_KIND = "review_triage";

/**
 * Worker-side ceiling for the internal gateway hop. It must stay comfortably
 * above the gateway's own provider budget (`PI_JEV_TIMEOUT_MS`, default 3000ms,
 * shared by all attempts) so an in-budget provider retry is never cancelled by
 * the caller, while a wedged gateway still cannot pin the review stage.
 */
export const REVIEW_TRIAGE_REQUEST_TIMEOUT_MS = 10_000;

/** Modes that opt the worker into firing the shadow review-triage call. */
export const REVIEW_TRIAGE_MODES = ["shadow", "assist", "enforce"] as const;

export type ReviewTriageSend = (pathName: string, init: RequestInit, timeoutMs: number) => Promise<unknown>;

/**
 * True only when the worker's own `PI_JEV_MODE` is one of the documented
 * enabling modes (exact match after trimming — the same strict env style as the
 * other `PI_*` knobs). The gateway stays authoritative: if the worker says
 * `shadow` while the web configuration says `off`, the gateway answers a
 * business-safe `disabled` without any outbound call, and this call is harmless.
 */
export function jevReviewTriageEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const mode = String(env.PI_JEV_MODE ?? "").trim();
  return (REVIEW_TRIAGE_MODES as readonly string[]).includes(mode);
}

/** The exact body of the evaluate request (docs/26 §8.1). */
export function reviewTriagePayload(runId: string): { runId: string; kind: typeof REVIEW_TRIAGE_KIND } {
  return { runId, kind: REVIEW_TRIAGE_KIND };
}

export interface ReviewTriageTriggerOptions {
  /** The worker's module-scope opt-in decision. */
  enabled: boolean;
  /** Transport, normally the worker's `internalRequest` (same auth as checkpoints/jobs). */
  send: ReviewTriageSend;
  /** Warning sink for a failed trigger; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

function safeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, 300);
}

/**
 * Builds the trigger. It resolves `void` in every case — a decision-plane
 * failure is logged and dropped, never rethrown.
 */
export function createReviewTriageTrigger(options: ReviewTriageTriggerOptions): (runId: string) => Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async function triggerReviewTriage(runId: string): Promise<void> {
    if (!options.enabled) return;
    try {
      await options.send(
        REVIEW_TRIAGE_DECISION_PATH,
        { method: "POST", body: JSON.stringify(reviewTriagePayload(runId)) },
        REVIEW_TRIAGE_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // docs/26 §15.1: the decision plane is an enhancement, never a dependency.
      // The message is bounded and contains ids/status only — never a credential.
      warn(`[decision] review triage evaluate failed for ${runId}: ${safeErrorText(error)}`);
    }
  };
}

/**
 * Records the authoritative review verdict FIRST, then runs the (opt-in) shadow
 * triage. The order is part of the contract (docs/26 §9.1): the reviewer's
 * verdict must already be durable before any decision-plane call, so a decision
 * outage can never precede, block or influence it. A failed verdict write
 * short-circuits and the triage is not attempted at all.
 *
 * The call itself is FIRE-AND-FORGET (P2, code review): awaiting it let a slow or
 * latched decision plane delay the review path by up to the request timeout
 * (10s), which contradicts docs/26 §15.1 — the plane is an enhancement, never a
 * dependency. The trigger already swallows its own failures.
 */
export async function recordVerdictThenReviewTriage<T>(input: {
  runId: string;
  recordVerdict: () => Promise<T>;
  trigger: (runId: string) => Promise<void>;
}): Promise<T> {
  const verdict = await input.recordVerdict();
  void input.trigger(input.runId).catch(() => undefined);
  return verdict;
}
