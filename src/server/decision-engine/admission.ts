/**
 * Decision-plane concurrency admission (docs/26 §4.1, AT-JEV-072).
 *
 * The decision plane had NO internal rate/concurrency cap: a 2×-peak burst of
 * `POST /api/internal/decisions/evaluate` requests all reached the provider in
 * parallel (the only protections were the *post-hoc* circuit breaker and the
 * worker's own `PI_MAX_ACTIVE_JOBS`). This module is the decision plane's own
 * *pre-dispatch* bound: the evaluate route acquires one slot before it builds a
 * batch or calls the provider and releases it when the request finishes, so the
 * number of concurrent outbound triage calls can never exceed the cap.
 *
 * Design rules (deliberately minimal):
 *  - pure in-memory, zero dependencies, synchronous, and it NEVER throws — the
 *    admission decision must not be able to fail an evaluation;
 *  - `maxConcurrent <= 0` means "no limit": `tryAcquire()` is always true and no
 *    counters are maintained, so an unlimited controller cannot grow unbounded;
 *  - concurrency safety is inherited from Node's single-threaded event loop
 *    (`tryAcquire`/`release` never `await`), so no lock/atom is needed.
 *
 * The env/config resolution (`PI_DECISION_MAX_CONCURRENT`, default 4) lives in
 * `decision-routes.ts`, not here: this module stays a pure primitive.
 */

export interface AdmissionController {
  /**
   * Reserves one slot and returns `true`, or returns `false` when the cap is
   * already saturated. A rejected call never reserves anything and bumps
   * `rejected` by one.
   */
  tryAcquire(): boolean;
  /**
   * Releases one previously reserved slot. Idempotent-safe: a stray/extra call
   * is a no-op (the counter is clamped at 0) and never throws.
   */
  release(): void;
  /** Slots currently reserved (always 0 when unlimited). */
  readonly inFlight: number;
  /** Total rejections since construction (always 0 when unlimited). */
  readonly rejected: number;
  /** Effective cap; `<= 0` means unlimited. */
  readonly maxConcurrent: number;
}

export interface CreateAdmissionControllerOptions {
  /**
   * Maximum concurrent admissions. `<= 0` (or non-finite) disables limiting.
   */
  maxConcurrent: number;
}

/** Normalizes the cap: a finite value is floored, anything else means unlimited. */
function normalizeMaxConcurrent(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

export function createAdmissionController(
  options: CreateAdmissionControllerOptions,
): AdmissionController {
  const maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);
  // Unlimited controllers keep no state at all: nothing to leak, nothing to grow.
  const limited = maxConcurrent > 0;
  let inFlight = 0;
  let rejected = 0;

  return {
    tryAcquire(): boolean {
      if (!limited) return true;
      if (inFlight >= maxConcurrent) {
        rejected += 1;
        return false;
      }
      inFlight += 1;
      return true;
    },
    release(): void {
      if (!limited) return;
      // Defensive clamp: a release without a successful acquire is a no-op, not
      // an error, so a buggy caller can never push the counter negative.
      if (inFlight > 0) inFlight -= 1;
    },
    get inFlight(): number {
      return inFlight;
    },
    get rejected(): number {
      return rejected;
    },
    get maxConcurrent(): number {
      return maxConcurrent;
    },
  };
}
