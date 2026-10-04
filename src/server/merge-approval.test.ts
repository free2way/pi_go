import { describe, expect, it } from "vitest";
import type { AcceptanceSnapshot, Run, RunMergePending } from "../shared/types.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { createTestDb } from "./test-db.js";
import {
  MERGE_IN_PROGRESS_CODE,
  MERGE_PENDING_STALE_MS,
  MERGE_RECORD_FAILED_CODE,
  coordinateApprovedMerge,
  mergeRecordFromPending,
  planMergeBegin,
  planMergeReplay,
  replayPendingMerge,
  type MergeApprovalRequest,
  type MergeApprovalStore,
} from "./merge-approval.js";

const AT = "2026-10-04T12:00:00.000Z";
const NOW_MS = Date.parse(AT);

function makeRun(overrides: Partial<Run> = {}): Run {
  const run = baseRealRun({
    title: "merge approval test",
    task: "验证审批合并的两阶段与补偿行为。",
    repository: "/srv/workspace/pi_go",
    workspaceId: "ws_1",
    mode: "real",
    checks: ["npm test"],
    developerModel: { provider: "deepseek", model: "deepseek-flash" },
    reviewerModel: { provider: "openai-proxy", model: "gpt-5.6-sol" },
  }, "owner_1");
  return { ...run, ...overrides };
}

const acceptance: AcceptanceSnapshot = {
  acceptedAt: AT,
  acceptedBy: "admin_1",
  note: null,
  acknowledgedOpenFindings: false,
  findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } },
  diff: { artifactId: null, sha256: null, bytes: null },
  checks: { total: 0, passed: 0, failed: 0 },
  usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 },
};

function candidate(run: Run, token: string): RunMergePending {
  return {
    token,
    state: "in_progress",
    sourceBranch: run.branch,
    targetBranch: "main",
    startedAt: AT,
    startedBy: "admin_1",
    approval: { acceptedAt: AT, acceptedBy: "admin_1", summary: "人工审批通过，交付已确认", note: null, acceptance },
  };
}

async function seededStore(store: PostgresRunStore, run: Run) {
  await store.createRun(run, { runId: run.id, round: 0, source: "system", type: "run.created", message: "created", at: AT });
  await store.updateRun(run.id, { state: "needs_human" });
}

async function mergedEventCount(store: PostgresRunStore, runId: string) {
  return (await store.getEvents(runId)).filter((item) => item.type === "run.merged").length;
}

function mergeRequest(run: Run, token: string, callWorker: MergeApprovalRequest["callWorker"]): MergeApprovalRequest {
  return {
    run,
    token,
    targetBranch: "main",
    startedAt: AT,
    approval: { acceptedAt: AT, acceptedBy: "admin_1", summary: "人工审批通过，交付已确认", note: null, acceptance },
    callWorker,
  };
}

describe("planMergeBegin (B1 phase machine)", () => {
  const run = makeRun();

  it("starts a fresh merge when no marker exists", () => {
    const decision = planMergeBegin({ run, pending: candidate(run, "t1") });
    expect(decision.kind).toBe("start");
  });

  it("refuses a second approval while a merge is in progress (409 MERGE_IN_PROGRESS)", () => {
    const inProgress = { ...makeRun(), mergePending: candidate(run, "t1") };
    const decision = planMergeBegin({ run: inProgress, pending: candidate(run, "t2") });
    expect(decision).toMatchObject({ kind: "conflict", status: 409, code: MERGE_IN_PROGRESS_CODE });
  });

  it("converges a committed_unrecorded marker instead of merging again", () => {
    const committed: RunMergePending = {
      ...candidate(run, "t1"),
      state: "committed_unrecorded",
      commit: "deadbeef",
      strategy: "merge-commit",
      mergedAt: AT,
    };
    const decision = planMergeBegin({ run: { ...makeRun(), mergePending: committed }, pending: candidate(run, "t2") });
    expect(decision).toMatchObject({ kind: "converge" });
  });

  it("treats an already-recorded merge as done", () => {
    const merged = makeRun({ merge: { commit: "c1", strategy: "fast-forward", targetBranch: "main", mergedAt: AT, mergedBy: "admin_1" } });
    expect(planMergeBegin({ run: merged, pending: candidate(merged, "t2") })).toMatchObject({ kind: "already-merged" });
  });
});

describe("planMergeReplay / mergeRecordFromPending (B1 replay)", () => {
  it("is a no-op without a marker or while a claim is still fresh", () => {
    expect(planMergeReplay(makeRun(), NOW_MS).kind).toBe("none");
    const fresh = { ...makeRun(), mergePending: candidate(makeRun(), "t1") };
    expect(planMergeReplay(fresh, NOW_MS).kind).toBe("none");
  });

  it("finalizes only a committed_unrecorded marker and recovers the merge record", () => {
    const pending: RunMergePending = {
      ...candidate(makeRun(), "t1"),
      state: "committed_unrecorded",
      commit: "cafebabe",
      strategy: "fast-forward",
      mergedAt: AT,
    };
    const plan = planMergeReplay({ ...makeRun({ state: "needs_human" }), mergePending: pending }, NOW_MS);
    expect(plan).toMatchObject({ kind: "finalize" });
    if (plan.kind !== "finalize") throw new Error("expected finalize");
    expect(plan.merge).toEqual({ commit: "cafebabe", strategy: "fast-forward", targetBranch: "main", mergedAt: AT, mergedBy: "admin_1" });
    expect(mergeRecordFromPending(pending)?.commit).toBe("cafebabe");
  });

  it("clears a pending marker whose merge is already recorded", () => {
    const run = makeRun({
      merge: { commit: "c1", strategy: "fast-forward", targetBranch: "main", mergedAt: AT, mergedBy: "admin_1" },
      mergePending: candidate(makeRun(), "t1"),
    });
    expect(planMergeReplay(run, NOW_MS).kind).toBe("clear-pending");
  });

  it("abandons only a genuinely stale in_progress marker", () => {
    const stale = { ...makeRun(), mergePending: { ...candidate(makeRun(), "t1"), startedAt: new Date(NOW_MS - MERGE_PENDING_STALE_MS - 1).toISOString() } };
    expect(planMergeReplay(stale, NOW_MS).kind).toBe("clear-pending");
  });
});

describe("coordinateApprovedMerge (B1 two-phase)", () => {
  it("merges once, records the commit and clears the marker", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await seededStore(store, run);

    let calls = 0;
    const outcome = await coordinateApprovedMerge(store, mergeRequest(run, "t1", async () => {
      calls += 1;
      return { ok: true, commit: "abc123", targetBranch: "main", strategy: "merge-commit" };
    }));

    expect(outcome.kind).toBe("merged");
    expect(calls).toBe(1);
    const stored = store.getRun(run.id)!;
    expect(stored.state).toBe("completed");
    expect(stored.merge?.commit).toBe("abc123");
    expect(stored.mergePending).toBeUndefined();
    expect(await mergedEventCount(store, run.id)).toBe(1);
  });

  it("rejects a concurrent approval so only one caller ever touches Git", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await seededStore(store, run);

    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => { started = resolve; });
    const workerGate = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinateApprovedMerge(store, mergeRequest(run, "t1", async () => {
      calls += 1;
      started();
      await workerGate;
      return { ok: true, commit: "abc123", targetBranch: "main", strategy: "fast-forward" };
    }));
    await workerStarted;

    // While the first caller owns the merge, a second approval must not proceed.
    const inFlight = store.getRun(run.id)!;
    expect(inFlight.mergePending?.state).toBe("in_progress");
    const second = await coordinateApprovedMerge(store, mergeRequest(inFlight, "t2", async () => {
      calls += 1;
      return { ok: true, commit: "other", targetBranch: "main", strategy: "fast-forward" };
    }));
    expect(second).toMatchObject({ kind: "conflict", status: 409, code: MERGE_IN_PROGRESS_CODE });
    expect(calls).toBe(1);

    release();
    const outcome = await first;
    expect(outcome.kind).toBe("merged");
    expect(store.getRun(run.id)?.merge?.commit).toBe("abc123");
  });

  it("clears the claim when the worker refuses, leaving the run approvable", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await seededStore(store, run);

    const outcome = await coordinateApprovedMerge(store, mergeRequest(run, "t1", async () => ({
      ok: false,
      code: "MERGE_CONFLICT",
      error: "conflict",
      conflictingPaths: ["src/a.ts"],
    })));
    expect(outcome).toMatchObject({ kind: "worker-error", status: 409, code: "MERGE_CONFLICT" });
    const stored = store.getRun(run.id)!;
    expect(stored.state).toBe("needs_human");
    expect(stored.mergePending).toBeUndefined();
  });

  it("converges a committed_unrecorded marker without calling the worker again", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await seededStore(store, run);
    await store.updateRun(run.id, {
      mergePending: { ...candidate(run, "t0"), state: "committed_unrecorded", commit: "beef", strategy: "merge-commit", mergedAt: AT },
    });

    let calls = 0;
    const current = store.getRun(run.id)!;
    const outcome = await coordinateApprovedMerge(store, mergeRequest(current, "t1", async () => {
      calls += 1;
      return { ok: true, commit: "should-not-run", targetBranch: "main", strategy: "fast-forward" };
    }));

    expect(outcome).toMatchObject({ kind: "merged", replayed: true });
    expect(calls).toBe(0);
    expect(store.getRun(run.id)?.merge?.commit).toBe("beef");
    expect(store.getRun(run.id)?.mergePending).toBeUndefined();
  });
});

describe("replayPendingMerge (B1 compensation)", () => {
  it("records a DB write failure exactly once and converges on the next replay", async () => {
    const db = await createTestDb();
    const real = new PostgresRunStore(db);
    await real.init();
    const run = makeRun();
    await seededStore(real, run);

    // Finalize (the write carrying `state: "completed"`) fails after the worker
    // merged; the durable intent write still succeeds.
    const failing: MergeApprovalStore = {
      getRun: (id) => real.getRun(id),
      updateRun: (id, patch) => real.updateRun(id, patch),
      appendEvent: (event, options) => real.appendEvent(event, options),
      updateRunGuarded: async (id, guard, patch) => {
        if (patch.state === "completed") throw new Error("injected DB write failure");
        return real.updateRunGuarded(id, guard, patch);
      },
    };

    const outcome = await coordinateApprovedMerge(failing, mergeRequest(run, "t1", async () => ({
      ok: true,
      commit: "feedface",
      targetBranch: "main",
      strategy: "merge-commit",
    })));
    expect(outcome).toMatchObject({ kind: "record-failed", status: 503, code: MERGE_RECORD_FAILED_CODE });

    // Workspace merged: the durable intent carries the commit, run still open.
    const pending = real.getRun(run.id)!;
    expect(pending.state).toBe("needs_human");
    expect(pending.mergePending).toMatchObject({ state: "committed_unrecorded", commit: "feedface" });

    // First replay converges the row and appends exactly one merge event.
    const converged = await replayPendingMerge(real, run.id, NOW_MS);
    expect(converged?.state).toBe("completed");
    expect(converged?.merge?.commit).toBe("feedface");
    expect(converged?.mergePending).toBeUndefined();
    expect(await mergedEventCount(real, run.id)).toBe(1);

    // A second replay is a no-op: the merge is recorded exactly once.
    const again = await replayPendingMerge(real, run.id, NOW_MS);
    expect(again?.merge?.commit).toBe("feedface");
    expect(await mergedEventCount(real, run.id)).toBe(1);
    expect(real.getRun(run.id)?.state).toBe("completed");
  });

  it("clears a stale in_progress claim so an abandoned attempt cannot block approval", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await seededStore(store, run);
    await store.updateRun(run.id, {
      mergePending: { ...candidate(run, "t0"), startedAt: new Date(NOW_MS - MERGE_PENDING_STALE_MS - 1).toISOString() },
    });

    await replayPendingMerge(store, run.id, NOW_MS);
    expect(store.getRun(run.id)?.mergePending).toBeUndefined();
    expect(store.getRun(run.id)?.state).toBe("needs_human");
  });
});
