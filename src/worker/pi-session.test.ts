import { describe, expect, it, vi } from "vitest";
import {
  CliSessionManager,
  SessionAccumulator,
  buildSessionMetrics,
  createCliTransport,
  createRpcTransport,
  isStatefulPiSessionRole,
  mergeSessionMetrics,
  planPiSession,
  type PiSessionPlan,
  type SessionMetrics,
} from "./pi-session.js";

const usage = (over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }> = {}) => ({
  input: over.input ?? 0,
  output: over.output ?? 0,
  cacheRead: over.cacheRead ?? 0,
  cacheWrite: over.cacheWrite ?? 0,
  totalTokens: (over.input ?? 0) + (over.output ?? 0) + (over.cacheRead ?? 0) + (over.cacheWrite ?? 0),
  cost: 0,
});

describe("planPiSession (Sprint 2)", () => {
  it("persists the developer session across repair rounds and resumes it", () => {
    const first = planPiSession({ role: "developer", run: "run_9c8e4730ae17406b", round: 1 });
    expect(first.sessionId).toBe("run-9c8e4730ae17406b-developer");
    expect(first.metricsId).toBe("run-9c8e4730ae17406b-developer");
    expect(first.fresh).toBe(true);
    expect(first.resume).toBe(false);

    const repair = planPiSession({ role: "developer", run: "run_9c8e4730ae17406b", round: 2 });
    expect(repair.sessionId).toBe(first.sessionId);
    expect(repair.resume).toBe(true);
    expect(repair.fresh).toBe(false);
  });

  it("uses a distinct key per stateful role (integrator, sub-agent)", () => {
    const integrator = planPiSession({ role: "integrator", run: "run_abc", round: 3 });
    const sub = planPiSession({ role: "sub-agent", run: "run_abc", round: 1, key: "sub-t1" });
    expect(integrator.sessionId).toBe("run-abc-integrator");
    expect(sub.sessionId).toBe("run-abc-sub-t1");
    expect(isStatefulPiSessionRole("sub-agent")).toBe(true);
    expect(isStatefulPiSessionRole("reviewer")).toBe(false);
  });

  it("is stateless for the planner", () => {
    const plan = planPiSession({ role: "planner", run: "run_abc", round: 1 });
    expect(plan.sessionId).toBeUndefined();
    expect(plan.fresh).toBe(true);
    expect(plan.resume).toBe(false);
    expect(plan.metricsId).toBe("run-abc-plan");
  });

  it("requires a fresh reviewer session per round", () => {
    const round1 = planPiSession({ role: "reviewer", run: "run_abc", round: 1 });
    const round2 = planPiSession({ role: "reviewer", run: "run_abc", round: 2 });
    expect(round1.sessionId).toBeUndefined();
    expect(round1.fresh).toBe(true);
    expect(round1.resume).toBe(false);
    expect(round1.metricsId).toBe("run-abc-review-r1");
    expect(round2.metricsId).toBe("run-abc-review-r2");
    expect(round2.metricsId).not.toBe(round1.metricsId);
  });

  it("treats a protocol retry as its own fresh reviewer session", () => {
    const retry = planPiSession({ role: "reviewer", run: "run_abc", round: 2, retry: true });
    expect(retry.sessionId).toBeUndefined();
    expect(retry.fresh).toBe(true);
    expect(retry.resume).toBe(false);
    expect(retry.metricsId).toBe("run-abc-review-r2-retry");
  });
});

describe("buildSessionMetrics", () => {
  it("reflects the invocation usage without inventing numbers", () => {
    const plan = planPiSession({ role: "developer", run: "run_abc", round: 2 });
    const metrics = buildSessionMetrics(plan, 1234.6, usage({ input: 10, output: 4, cacheRead: 6, cacheWrite: 1 }), 2);
    expect(metrics).toEqual({
      sessionId: "run-abc-developer",
      role: "developer",
      round: 2,
      resumed: true,
      durationMs: 1235,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 1,
      modelCalls: 2,
    });
  });
});

describe("mergeSessionMetrics", () => {
  const metrics = (over: Partial<SessionMetrics>): SessionMetrics => ({
    sessionId: "run-abc-developer",
    role: "developer",
    round: 1,
    resumed: false,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelCalls: 0,
    ...over,
  });

  it("creates one summary per session id and aggregates reuse across rounds", () => {
    const r1 = mergeSessionMetrics(undefined, metrics({ round: 1, durationMs: 100, inputTokens: 10, outputTokens: 1, modelCalls: 1 }), "2026-10-05T00:00:00.000Z");
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ sessionId: "run-abc-developer", rounds: [1], calls: 1, resumed: false, durationMs: 100, inputTokens: 10 });

    const r2 = mergeSessionMetrics(r1, metrics({ round: 2, resumed: true, durationMs: 50, inputTokens: 5, outputTokens: 2, modelCalls: 1 }), "2026-10-05T00:10:00.000Z");
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({
      rounds: [1, 2],
      calls: 2,
      resumed: true,
      durationMs: 150,
      inputTokens: 15,
      outputTokens: 3,
      modelCalls: 2,
      firstAt: "2026-10-05T00:00:00.000Z",
      lastAt: "2026-10-05T00:10:00.000Z",
    });
  });

  it("keeps distinct sessions (e.g. per-round reviewer) as separate summaries", () => {
    const r1 = mergeSessionMetrics(undefined, metrics({ sessionId: "run-abc-review-r1", role: "reviewer", round: 1, inputTokens: 3 }), "t1");
    const r2 = mergeSessionMetrics(r1, metrics({ sessionId: "run-abc-review-r2", role: "reviewer", round: 2, inputTokens: 4 }), "t2");
    expect(r2.map((entry) => entry.sessionId)).toEqual(["run-abc-review-r1", "run-abc-review-r2"]);
    expect(r2.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(7);
  });

  it("does not mutate the input summaries", () => {
    const r1 = mergeSessionMetrics(undefined, metrics({ inputTokens: 1 }), "t1");
    const snapshot = JSON.stringify(r1);
    mergeSessionMetrics(r1, metrics({ inputTokens: 9 }), "t2");
    expect(JSON.stringify(r1)).toBe(snapshot);
  });

  it("SessionAccumulator resumes from a persisted snapshot", () => {
    const accumulator = new SessionAccumulator(mergeSessionMetrics(undefined, metrics({ inputTokens: 5 }), "t1"));
    const merged = accumulator.merge(metrics({ round: 2, resumed: true, inputTokens: 2 }), "t2");
    expect(merged[0].inputTokens).toBe(7);
    expect(merged[0].calls).toBe(2);
    expect(merged[0].rounds).toEqual([1, 2]);
  });
});

describe("PiSessionTransport seam", () => {
  it("createCliTransport runs the supplied callback unchanged", async () => {
    const transport = createCliTransport();
    expect(transport.kind).toBe("cli");
    const call = vi.fn(async () => ({ result: "ok" as const, usage: usage(), modelCalls: 1 }));
    const plan: PiSessionPlan = { role: "developer", round: 1, sessionId: "s", metricsId: "s", resume: false, fresh: true };
    const outcome = await transport.invoke(plan, call);
    expect(outcome.result).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("createRpcTransport throws a clear not-implemented error", () => {
    expect(() => createRpcTransport()).toThrow(/not implemented/);
    expect(() => createRpcTransport()).toThrow(/createCliTransport/);
  });
});

describe("CliSessionManager", () => {
  it("passes the plan session id to the invocation and reports metrics", async () => {
    const manager = new CliSessionManager();
    const onMetrics = vi.fn();
    const invoke = vi.fn(async (sessionId: string | undefined) => ({ result: sessionId ? "text" : "none", usage: usage({ input: 7 }), modelCalls: 3 }));
    const plan = planPiSession({ role: "developer", run: "run_abc", round: 2 });
    const outcome = await manager.execute({
      plan,
      signal: new AbortController().signal,
      onActivity: async () => undefined,
      invoke: (sessionId) => invoke(sessionId),
      onMetrics,
    });
    expect(outcome.result).toBe("text");
    expect(invoke).toHaveBeenCalledWith("run-abc-developer");
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics.mock.calls[0][0]).toMatchObject({ sessionId: "run-abc-developer", resumed: true, inputTokens: 7, modelCalls: 3 });
  });
});
