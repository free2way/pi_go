import { describe, expect, it } from "vitest";
import type { Run, RunEvent } from "../shared/types";
import { deferredNonBlockingNotice, mergeRunEvents, shouldAcceptRun } from "./run-events";

function event(seq: number): RunEvent {
  return { seq, runId: "run_1", round: 1, source: "system", type: `e${seq}`, message: `${seq}`, at: new Date(seq).toISOString() };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ownerId: "owner_1",
    title: "t",
    task: "task task task",
    repository: "/repo",
    branch: "pigo/1",
    mode: "real",
    state: "developing",
    round: 1,
    maxRounds: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    developer: { provider: "deepseek", model: "m" },
    reviewer: { provider: "openai-proxy", model: "m" },
    checks: [],
    findings: [],
    diff: "",
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
    ...overrides,
  };
}

describe("mergeRunEvents (AUD-17)", () => {
  it("dedupes by seq and keeps ascending order", () => {
    const merged = mergeRunEvents([event(1), event(3)], [event(3), event(2)]);
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("never drops newer live events when a late snapshot arrives", () => {
    // Live stream delivered seq 5 while the initial snapshot still has 1..4.
    const live = [event(5)];
    const snapshot = [event(1), event(2), event(3), event(4)];
    const merged = mergeRunEvents(live, snapshot);
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("caps the buffered array so long runs stay bounded in memory", () => {
    const many = Array.from({ length: 100 }, (_, index) => event(index + 1));
    const merged = mergeRunEvents([], many, 10);
    expect(merged.length).toBe(10);
    expect(merged[0].seq).toBe(91);
    expect(merged[9].seq).toBe(100);
  });

  it("ignores older revisions of a run snapshot", () => {
    const current = run({ lastSeq: 10, updatedAt: "2026-01-01T00:00:10.000Z" });
    expect(shouldAcceptRun(current, run({ lastSeq: 9 }))).toBe(false);
    expect(shouldAcceptRun(current, run({ lastSeq: 11 }))).toBe(true);
    // Same seq: the newer timestamp wins; an older one is rejected.
    expect(shouldAcceptRun(current, run({ lastSeq: 10, updatedAt: "2026-01-01T00:00:11.000Z" }))).toBe(true);
    expect(shouldAcceptRun(current, run({ lastSeq: 10, updatedAt: "2026-01-01T00:00:09.000Z" }))).toBe(false);
    expect(shouldAcceptRun(undefined, current)).toBe(true);
    expect(shouldAcceptRun(current, run({ id: "run_2" }))).toBe(true);
  });
});

describe("deferredNonBlockingNotice (reviewScope: blocking)", () => {
  function deferred(seq: number, meta: Record<string, unknown>, message = "deferred"): RunEvent {
    return { seq, runId: "run_1", round: 3, source: "reviewer", type: "review.nonblocking_deferred", message, at: new Date(seq).toISOString(), meta };
  }

  it("returns undefined when the run never deferred anything", () => {
    expect(deferredNonBlockingNotice([event(1), event(2)])).toBeUndefined();
  });

  it("reads count/ids/round from the latest deferral event", () => {
    const notice = deferredNonBlockingNotice([
      deferred(1, { round: 2, count: 1, ids: ["a"] }, "old"),
      deferred(2, { round: 4, count: 2, ids: ["b", "c"] }, "latest"),
    ]);
    expect(notice).toEqual({ round: 4, count: 2, ids: ["b", "c"], message: "latest" });
  });

  it("falls back to the ids length when count is missing and ignores non-string ids", () => {
    const notice = deferredNonBlockingNotice([deferred(1, { ids: ["b", 7, "c"] })]);
    expect(notice?.count).toBe(2);
    expect(notice?.ids).toEqual(["b", "c"]);
    expect(notice?.round).toBe(3);
  });
});
