import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REVIEW_TRIAGE_DECISION_PATH,
  REVIEW_TRIAGE_KIND,
  REVIEW_TRIAGE_REQUEST_TIMEOUT_MS,
  createReviewTriageTrigger,
  jevReviewTriageEnabled,
  recordVerdictThenReviewTriage,
  type ReviewTriageSend,
} from "./decision-triage.js";

/**
 * docs/27 §7.3/§7.6/§8 · Worker-side integration of the review-shadow call site
 * (AT-JEV-020/021/050/054).
 *
 * `decision-triage.test.ts` pins each unit in isolation. This file drives the
 * same pieces the way `index.ts` actually wires them — the opt-in read from the
 * worker's own env, the transport, the verdict-then-triage ordering and the
 * single redacted warning — through one fake gateway. It performs NO network I/O:
 * the transport is injected, so a bug here can never reach the decision gateway.
 */

const API_KEY = "sk-DUMMY-worker-integration-key-must-never-leak";

interface GatewayCall {
  path: string;
  method: string;
  body: unknown;
  timeoutMs: number;
}

/** A fake `internalRequest` that records calls; `fail` flips it to throwing. */
function fakeGateway(options: { fail?: boolean } = {}): { calls: GatewayCall[]; send: ReviewTriageSend } {
  const calls: GatewayCall[] = [];
  const send: ReviewTriageSend = async (path, init, timeoutMs) => {
    calls.push({ path, method: String(init.method), body: JSON.parse(String(init.body)), timeoutMs });
    if (options.fail) throw new Error("Internal request failed: 503");
    return {};
  };
  return { calls, send };
}

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
});

describe("worker review-triage call site", () => {
  it("records the verdict before the shadow triage is requested (AT-JEV-020)", async () => {
    const sequence: string[] = [];
    const { calls, send } = fakeGateway();
    const persisted: string[] = [];
    let durableAtTrigger: string[] | undefined;

    const trigger = createReviewTriageTrigger({
      enabled: jevReviewTriageEnabled({ PI_JEV_MODE: "shadow" }),
      send: async (path, init, timeoutMs) => {
        sequence.push("triage");
        durableAtTrigger = [...persisted];
        return send(path, init, timeoutMs);
      },
      warn: () => undefined,
    });

    const verdict = await recordVerdictThenReviewTriage({
      runId: "run_worker_1",
      recordVerdict: async () => {
        sequence.push("verdict");
        persisted.push("review.approved");
        return "review.approved";
      },
      trigger,
    });

    expect(verdict).toBe("review.approved");
    expect(sequence).toEqual(["verdict", "triage"]);
    // The verdict row was already durable before the gateway saw the request.
    expect(durableAtTrigger).toEqual(["review.approved"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(REVIEW_TRIAGE_DECISION_PATH);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ runId: "run_worker_1", kind: REVIEW_TRIAGE_KIND });
    expect(calls[0].timeoutMs).toBe(REVIEW_TRIAGE_REQUEST_TIMEOUT_MS);
    expect(JSON.stringify(calls[0].body)).not.toContain(API_KEY);
  });

  it("never dispatches when the worker env is unset, off, blank or mis-typed (AT-JEV-021)", async () => {
    for (const env of [{}, { PI_JEV_MODE: "off" }, { PI_JEV_MODE: "" }, { PI_JEV_MODE: "   " }, { PI_JEV_MODE: "ON" }, { PI_JEV_MODE: "sometimes" }]) {
      const { calls, send } = fakeGateway();
      const warnings: string[] = [];
      const trigger = createReviewTriageTrigger({
        enabled: jevReviewTriageEnabled(env),
        send,
        warn: (message) => warnings.push(message),
      });

      const verdict = await recordVerdictThenReviewTriage({
        runId: "run_worker_2",
        recordVerdict: async () => "review.changes_requested",
        trigger,
      });

      expect(verdict).toBe("review.changes_requested");
      expect(calls).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    }
  });

  it("swallows a gateway failure into one bounded, secret-free warning (AT-JEV-050)", async () => {
    const warnings: string[] = [];
    const trigger = createReviewTriageTrigger({
      enabled: true,
      send: async () => {
        throw new Error("Internal request failed: 503");
      },
      warn: (message) => warnings.push(message),
    });

    await expect(trigger("run_worker_3")).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("run_worker_3");
    expect(warnings[0]).toContain("503");
    expect(warnings[0]).not.toContain(API_KEY);
    expect(warnings[0]).not.toContain("Bearer");
    expect(warnings[0]).not.toContain("Authorization");
  });

  it("keeps the review outcome when the triage hop fails (AT-JEV-021)", async () => {
    const warnings: string[] = [];
    const { calls, send } = fakeGateway({ fail: true });
    const verdict = await recordVerdictThenReviewTriage({
      runId: "run_worker_4",
      recordVerdict: async () => ({ verdict: "approved" as const }),
      trigger: createReviewTriageTrigger({ enabled: true, send, warn: (message) => warnings.push(message) }),
    });

    expect(verdict).toEqual({ verdict: "approved" });
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("short-circuits without any request when the verdict write fails (AT-JEV-020)", async () => {
    const { calls, send } = fakeGateway();
    const trigger = createReviewTriageTrigger({ enabled: true, send, warn: () => undefined });

    await expect(
      recordVerdictThenReviewTriage({
        runId: "run_worker_5",
        recordVerdict: async () => {
          throw new Error("Callback failed: run store unreachable");
        },
        trigger,
      }),
    ).rejects.toThrow("run store unreachable");

    expect(calls).toHaveLength(0);
  });

  it("sends no credential on the internal hop — the gateway owns auth (AT-JEV-054)", async () => {
    const { calls, send } = fakeGateway();
    const trigger = createReviewTriageTrigger({ enabled: true, send, warn: () => undefined });

    await trigger("run_worker_6");

    expect(calls).toHaveLength(1);
    // The worker's transport (`internalRequest`) attaches the internal token; the
    // trigger itself must never carry the TypeSafe key or any header material.
    expect(JSON.stringify(calls[0])).not.toContain(API_KEY);
    expect(JSON.stringify(calls[0])).not.toContain("Bearer");
  });
});
