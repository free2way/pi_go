import { describe, expect, it } from "vitest";
import type { Run, RunEvent } from "../shared/types.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { createTestDb } from "./test-db.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  const run = baseRealRun({
    title: "REL store test",
    task: "验证运行、事件、检查点与任务在 PostgreSQL 中的持久化行为。",
    repository: "/srv/workspace/pi_go",
    workspaceId: "ws_1",
    mode: "real",
    checks: ["npm test"],
    developerModel: { provider: "deepseek", model: "deepseek-flash" },
    reviewerModel: { provider: "openai-proxy", model: "gpt-5.6-sol" },
  }, "owner_1");
  return { ...run, ...overrides };
}

function event(runId: string, type: string, message = type): Omit<RunEvent, "seq"> {
  return { runId, round: 1, source: "system", type, message, at: new Date().toISOString() };
}

describe("PostgresRunStore", () => {
  it("allocates monotonic per-run sequence numbers and pages them", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    for (let index = 0; index < 5; index += 1) {
      await store.appendEvent(event(run.id, `run.step.${index}`));
    }
    const all = await store.getEvents(run.id);
    expect(all.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    const page = await store.getEvents(run.id, 2, 2);
    expect(page.map((item) => item.seq)).toEqual([3, 4]);
    expect((await store.getEvents(run.id, 6)).length).toBe(0);

    // Cache stays in step with the log so REST reads report the newest state.
    expect(store.getRun(run.id)?.lastSeq).toBe(6);
  });

  it("does not double count a repeated internal delivery (AT-REL-004)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    const first = await store.appendEvent(event(run.id, "run.usage", "usage"), { deliveryId: "job1:usage:1" });
    const replay = await store.appendEvent(event(run.id, "run.usage", "usage"), { deliveryId: "job1:usage:1" });
    expect(replay.seq).toBe(first.seq);

    const events = await store.getEvents(run.id);
    expect(events.filter((item) => item.type === "run.usage").length).toBe(1);
  });

  it("persists agents, checks, findings and artifact metadata", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun({
      checks: [{ id: "c1", name: "npm test", command: "npm test", status: "passed", durationMs: 42 }],
      findings: [{ id: "f1", severity: "high", file: "src/a.ts", line: 3, title: "问题", evidence: "e", requiredChange: "r", resolved: false }],
      plan: {
        complexity: "small",
        rationale: "r",
        strategy: "single",
        tasks: [{ id: "implementation", title: "实现", description: "d", files: [], dependsOn: [], status: "completed", durationMs: 12 }],
      },
      diff: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    await store.createRun(run, event(run.id, "run.created"));

    const counts = (await store.statistics()).counts;
    expect(counts.run_agents).toBe(1);
    expect(counts.run_checks).toBe(1);
    expect(counts.run_findings).toBe(1);
    expect(counts.run_artifacts).toBe(1);
    expect(counts.run_events).toBe(1);

    const artifact = (await db.query("SELECT bytes, sha256 FROM run_artifacts WHERE run_id = $1", [run.id])).rows[0];
    expect(Number(artifact.bytes)).toBe(Buffer.byteLength(run.diff, "utf8"));
    expect(String(artifact.sha256)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores checkpoints with idempotency keys and clears them per prefix (REL-003)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    await store.saveCheckpoint({ runId: run.id, stageKey: "planning", status: "completed", payload: { tasks: 2 }, idempotencyKey: `${run.id}:planning:1` });
    await store.saveCheckpoint({ runId: run.id, stageKey: "task:implementation", status: "completed", idempotencyKey: `${run.id}:task:implementation:1` });
    await store.saveCheckpoint({ runId: run.id, stageKey: "planning", status: "completed", payload: { tasks: 3 } });

    const checkpoints = await store.listCheckpoints(run.id);
    expect(checkpoints.map((item) => item.stageKey).sort()).toEqual(["planning", "task:implementation"]);
    const planning = checkpoints.find((item) => item.stageKey === "planning")!;
    expect(planning.idempotencyKey).toBe(`${run.id}:planning:1`);
    expect(planning.payload).toEqual({ tasks: 3 });

    await store.clearCheckpoints(run.id, "task:");
    expect((await store.listCheckpoints(run.id)).map((item) => item.stageKey)).toEqual(["planning"]);
  });

  it("hands unfinished jobs to a restarted worker (REL-002 / AT-REL-002)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    await store.createJob({ id: "job_1", runId: run.id, kind: "run", payload: { runId: run.id } });
    const fresh = await store.listPendingJobs({ staleAfterMs: 60_000 });
    expect(fresh.map((job) => job.id)).toEqual(["job_1"]);

    const claimed = await store.claimJob("job_1", "worker-a");
    expect(claimed?.state).toBe("claimed");
    expect(claimed?.attempts).toBe(1);
    expect((await store.listPendingJobs({ staleAfterMs: 60_000 })).length).toBe(0);

    // A live heartbeat keeps the job with its worker.
    await store.heartbeatJob("job_1", "worker-a");
    expect((await store.listPendingJobs({ staleAfterMs: 60_000 })).length).toBe(0);

    // Worker restart: the heartbeat goes stale and the job becomes reclaimable.
    await db.query("UPDATE jobs SET heartbeat_at = $1 WHERE id = 'job_1'", [new Date(Date.now() - 600_000).toISOString()]);
    const stale = await store.listPendingJobs({ staleAfterMs: 60_000 });
    expect(stale.map((job) => job.id)).toEqual(["job_1"]);
    expect(stale[0].attempts).toBe(1);

    const requeued = await store.requeueStaleJobs(60_000);
    expect(requeued).toEqual(["job_1"]);
    expect((await store.getJob("job_1"))?.state).toBe("queued");

    await store.claimJob("job_1", "worker-b");
    await store.finishJob("job_1", "done");
    expect((await store.listPendingJobs({ staleAfterMs: 60_000 })).length).toBe(0);
  });

  it("imports a legacy runs.json exactly once", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    const legacyEvents: RunEvent[] = [
      { ...event(run.id, "run.created"), seq: 1 },
      { ...event(run.id, "run.state"), seq: 2 },
    ];
    const first = await store.importLegacy({ runs: [{ ...run, lastSeq: 2 }], events: { [run.id]: legacyEvents } });
    expect(first).toEqual({ importedRuns: 1, importedEvents: 2, skippedRuns: 0 });
    expect(store.getRun(run.id)?.lastSeq).toBe(2);

    const second = await store.importLegacy({ runs: [{ ...run, lastSeq: 2 }], events: { [run.id]: legacyEvents } });
    expect(second.importedRuns).toBe(0);
    expect((await store.getEvents(run.id)).length).toBe(2);

    const next = await store.appendEvent(event(run.id, "run.after_import"));
    expect(next.seq).toBe(3);
  });

  it("imports ownerless legacy runs under the pre-migration owner key", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    const ownerless = { ...run, ownerId: "" } as unknown as Run;
    const result = await store.importLegacy({ runs: [ownerless], events: {} }, { defaultOwnerId: "legacy_owner_1" });
    expect(result).toEqual({ importedRuns: 1, importedEvents: 0, skippedRuns: 0 });
    expect(store.getRun(run.id)?.ownerId).toBe("legacy_owner_1");
    expect(store.listRuns(["legacy_owner_1"]).length).toBe(1);

    // Runs without an id (or without any owner fallback) are skipped, not fatal.
    const skipped = await store.importLegacy({ runs: [{ ...run, id: "" } as unknown as Run], events: {} });
    expect(skipped.skippedRuns).toBe(1);
  });

  it("deletes a run together with its derived rows", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun({ diff: "diff --git a/x b/x\n", checks: [{ id: "c1", name: "n", command: "c", status: "passed" }] });
    await store.createRun(run, event(run.id, "run.created"));
    await store.saveCheckpoint({ runId: run.id, stageKey: "planning", status: "completed" });

    await store.deleteRun(run.id);
    expect(store.getRun(run.id)).toBeUndefined();
    const counts = (await store.statistics()).counts;
    expect(counts.runs).toBe(0);
    expect(counts.run_events).toBe(0);
    expect(counts.run_checks).toBe(0);
    expect(counts.run_artifacts).toBe(0);
    expect(counts.run_checkpoints).toBe(0);
  });
});
