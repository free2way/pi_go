import { describe, expect, it } from "vitest";
import {
  REVIEW_TRIAGE_DECISION_PATH,
  REVIEW_TRIAGE_KIND,
  REVIEW_TRIAGE_REQUEST_TIMEOUT_MS,
  createReviewTriageTrigger,
  jevReviewTriageEnabled,
  recordVerdictThenReviewTriage,
  reviewTriagePayload,
} from "./decision-triage.js";

/**
 * docs/26 §9.1/§9.2/§13 · worker-side review-triage trigger.
 *
 * The trigger lives outside `index.ts` (which boots the worker's HTTP server on
 * import) so its contracts are unit-testable: strict opt-in, exactly one
 * gateway call per review, never failing the run, and firing strictly after the
 * authoritative review verdict has been recorded. No network, no provider.
 */

function recorder() {
  const calls: Array<{ path: string; init: RequestInit; timeoutMs: number }> = [];
  return {
    calls,
    send: async (path: string, init: RequestInit, timeoutMs: number) => {
      calls.push({ path, init, timeoutMs });
      return {};
    },
  };
}

describe("jevReviewTriageEnabled (worker opt-in)", () => {
  it("enables only shadow, assist and enforce", () => {
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "shadow" })).toBe(true);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "assist" })).toBe(true);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "enforce" })).toBe(true);
  });

  it("is a strict no-op for unset, off, blank and mis-typed values", () => {
    expect(jevReviewTriageEnabled({})).toBe(false);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "" })).toBe(false);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "   " })).toBe(false);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "off" })).toBe(false);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "ON" })).toBe(false);
    expect(jevReviewTriageEnabled({ PI_JEV_MODE: "sometimes" })).toBe(false);
  });

  it("fails closed on an unset worker env (no call, no warning)", async () => {
    const { calls, send } = recorder();
    const warnings: string[] = [];
    for (const env of [{}, { PI_JEV_MODE: "off" }, { PI_JEV_MODE: "" }]) {
      const trigger = createReviewTriageTrigger({ enabled: jevReviewTriageEnabled(env), send, warn: (message) => warnings.push(message) });
      await trigger("run_1");
    }
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("createReviewTriageTrigger", () => {
  it("fires exactly one evaluate call with the minimal body when enabled", async () => {
    const { calls, send } = recorder();
    const trigger = createReviewTriageTrigger({ enabled: true, send });

    await trigger("run_abc");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(REVIEW_TRIAGE_DECISION_PATH);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ runId: "run_abc", kind: REVIEW_TRIAGE_KIND });
    // The worker-side ceiling is bounded but larger than the gateway's own 3s
    // provider budget, so an in-budget provider retry is never cancelled here.
    expect(calls[0].timeoutMs).toBe(REVIEW_TRIAGE_REQUEST_TIMEOUT_MS);
    expect(calls[0].timeoutMs).toBeGreaterThan(3000);
  });

  it("never throws on a gateway rejection and warns with bounded, secret-free context", async () => {
    const warnings: string[] = [];
    const trigger = createReviewTriageTrigger({
      enabled: true,
      send: async () => {
        throw new Error("Internal request failed: 500");
      },
      warn: (message) => warnings.push(message),
    });

    await expect(trigger("run_abc")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("run_abc");
    expect(warnings[0]).toContain("500");
  });

  it("never throws on a gateway timeout", async () => {
    const warnings: string[] = [];
    const trigger = createReviewTriageTrigger({
      enabled: true,
      send: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
      warn: (message) => warnings.push(message),
    });

    await expect(trigger("run_abc")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("does not call the gateway when disabled, even if the sender would fail", async () => {
    const { calls, send } = recorder();
    const trigger = createReviewTriageTrigger({ enabled: false, send });
    await trigger("run_abc");
    expect(calls).toHaveLength(0);
  });

  it("keeps the payload minimal and id-free", () => {
    expect(reviewTriagePayload("run_abc")).toEqual({ runId: "run_abc", kind: "review_triage" });
  });
});

describe("recordVerdictThenReviewTriage (review-stage ordering)", () => {
  it("records the review verdict before the triage call fires", async () => {
    const sequence: string[] = [];
    const verdict = await recordVerdictThenReviewTriage({
      runId: "run_abc",
      recordVerdict: async () => {
        sequence.push("verdict");
        return "recorded";
      },
      trigger: async (runId) => {
        sequence.push(`triage:${runId}`);
      },
    });

    expect(verdict).toBe("recorded");
    expect(sequence).toEqual(["verdict", "triage:run_abc"]);
  });

  it("never fires the triage when recording the verdict failed", async () => {
    const sequence: string[] = [];
    await expect(
      recordVerdictThenReviewTriage({
        runId: "run_abc",
        recordVerdict: async () => {
          throw new Error("Callback failed: store unreachable");
        },
        trigger: async () => {
          sequence.push("triage");
        },
      }),
    ).rejects.toThrow("store unreachable");
    expect(sequence).toEqual([]);
  });

  it("returns the verdict even when the triage call fails (run proceeds unchanged)", async () => {
    const verdict = await recordVerdictThenReviewTriage({
      runId: "run_abc",
      recordVerdict: async () => ({ verdict: "changes_requested" as const }),
      trigger: createReviewTriageTrigger({
        enabled: true,
        send: async () => {
          throw new Error("Internal request failed: 503");
        },
        warn: () => undefined,
      }),
    });

    expect(verdict).toEqual({ verdict: "changes_requested" });
  });
});
