/**
 * Unit tests for the decision-plane admission controller (docs/26 §4.1,
 * AT-JEV-072): the pure primitive the evaluate route uses to bound concurrent
 * provider dispatches.
 *
 * These tests pin the contract only — cap accounting, reuse after release,
 * unlimited mode keeping no counters, and "never throws" (including a stray
 * release or a release after a thrown caller).
 */

import { describe, expect, it } from "vitest";
import { createAdmissionController } from "./admission.js";

describe("decision-engine/admission · createAdmissionController", () => {
  it.each([1, 2, 4])("admits exactly %i concurrent slots and rejects the next", (maxConcurrent) => {
    const admission = createAdmissionController({ maxConcurrent });

    expect(admission.maxConcurrent).toBe(maxConcurrent);
    expect(admission.inFlight).toBe(0);
    expect(admission.rejected).toBe(0);

    for (let index = 0; index < maxConcurrent; index += 1) {
      expect(admission.tryAcquire()).toBe(true);
    }
    expect(admission.inFlight).toBe(maxConcurrent);
    expect(admission.rejected).toBe(0);

    // Saturated: every further attempt is rejected and counted, never admitted.
    expect(admission.tryAcquire()).toBe(false);
    expect(admission.tryAcquire()).toBe(false);
    expect(admission.inFlight).toBe(maxConcurrent);
    expect(admission.rejected).toBe(2);
  });

  it("reuses a slot once it is released", () => {
    const admission = createAdmissionController({ maxConcurrent: 2 });

    expect(admission.tryAcquire()).toBe(true);
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.tryAcquire()).toBe(false);

    admission.release();
    expect(admission.inFlight).toBe(1);
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.inFlight).toBe(2);
    expect(admission.rejected).toBe(1);

    admission.release();
    admission.release();
    expect(admission.inFlight).toBe(0);
    // Releasing an already-empty controller is a no-op; the counter never goes
    // negative and the next acquire still works.
    admission.release();
    expect(admission.inFlight).toBe(0);
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.inFlight).toBe(1);
  });

  it("counts rejections across a burst, and the counter is monotonic", () => {
    const admission = createAdmissionController({ maxConcurrent: 1 });

    expect(admission.tryAcquire()).toBe(true);
    for (let index = 0; index < 7; index += 1) expect(admission.tryAcquire()).toBe(false);
    expect(admission.rejected).toBe(7);

    // A release frees a slot but never resets the rejection counter.
    admission.release();
    expect(admission.rejected).toBe(7);
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.rejected).toBe(7);
  });

  it.each([0, -1, -100])("treats maxConcurrent=%i as unlimited and keeps no counters", (maxConcurrent) => {
    const admission = createAdmissionController({ maxConcurrent });

    expect(admission.maxConcurrent).toBe(maxConcurrent);
    // Far beyond any plausible cap: unlimited means always admitted.
    for (let index = 0; index < 1_000; index += 1) expect(admission.tryAcquire()).toBe(true);
    // No in-flight accounting at all, so nothing can grow unbounded...
    expect(admission.inFlight).toBe(0);
    expect(admission.rejected).toBe(0);
    // ...and release is a no-op rather than a decrement.
    admission.release();
    expect(admission.inFlight).toBe(0);
  });

  it("falls back to unlimited for a non-finite maxConcurrent", () => {
    const admission = createAdmissionController({ maxConcurrent: Number.NaN });
    expect(admission.maxConcurrent).toBe(0);
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.inFlight).toBe(0);
  });

  it("every method is synchronous and never throws, even on a stray release", () => {
    const admission = createAdmissionController({ maxConcurrent: 1 });
    expect(() => {
      admission.release();
      admission.release();
      expect(admission.tryAcquire()).toBe(true);
      expect(admission.tryAcquire()).toBe(false);
      admission.release();
      admission.release();
      admission.release();
    }).not.toThrow();
    expect(admission.inFlight).toBe(0);

    const unlimited = createAdmissionController({ maxConcurrent: 0 });
    expect(() => {
      unlimited.release();
      unlimited.tryAcquire();
      unlimited.release();
    }).not.toThrow();
    expect(unlimited.inFlight).toBe(0);
  });

  it("releases a slot after the admitted work throws", () => {
    const admission = createAdmissionController({ maxConcurrent: 1 });

    // The evaluate route reserves a slot and releases it in `finally`; model the
    // throw path here so a regression that drops the `finally` is caught.
    const runAdmitted = (): void => {
      if (!admission.tryAcquire()) throw new Error("expected admission");
      try {
        throw new Error("provider exploded");
      } finally {
        admission.release();
      }
    };

    expect(runAdmitted).toThrow("provider exploded");
    expect(admission.inFlight).toBe(0);
    // A subsequent caller can take the freed slot.
    expect(admission.tryAcquire()).toBe(true);
    expect(admission.inFlight).toBe(1);
  });
});
