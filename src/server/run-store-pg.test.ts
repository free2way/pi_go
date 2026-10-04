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

  it("upserts repeated findings instead of failing on the primary key (AUD-11)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    const finding = { id: "stable-finding", severity: "high" as const, file: "src/a.ts", line: 3, title: "Race", evidence: "first", requiredChange: "fix", resolved: false, fingerprint: "fp1", observations: 1, consecutiveRounds: 1 };
    await store.updateRun(run.id, { findings: [finding] });
    await store.updateRun(run.id, { findings: [{ ...finding, evidence: "second", observations: 2, consecutiveRounds: 2 }] });

    const row = (await db.query("SELECT observations, consecutive_rounds, title FROM run_findings WHERE run_id = $1", [run.id])).rows[0];
    expect(Number(row.observations)).toBe(2);
    expect(Number(row.consecutive_rounds)).toBe(2);
    const count = (await db.query("SELECT COUNT(*) AS total FROM run_findings WHERE run_id = $1", [run.id])).rows[0];
    expect(Number(count.total)).toBe(1);
  });

  it("rejects illegal state transitions and keeps the cache consistent (AUD-15)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));
    await store.updateRun(run.id, { state: "cancelled" });

    await expect(store.updateRun(run.id, { state: "completed" })).rejects.toThrow(/Illegal run state transition/);
    expect(store.getRun(run.id)?.state).toBe("cancelled");
    const stored = (await db.query("SELECT state FROM runs WHERE id = $1", [run.id])).rows[0];
    expect(String(stored.state)).toBe("cancelled");
  });

  it("applies an internal delivery at most once, patch and event atomically (AUD-15)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    const first = await store.applyDelivery({
      runId: run.id,
      deliveryId: "job1:1",
      patch: { summary: "round one" },
      event: { runId: run.id, round: 1, source: "system", type: "run.usage", message: "usage", at: new Date().toISOString() },
    });
    expect(first.applied).toBe(true);
    const repeat = await store.applyDelivery({
      runId: run.id,
      deliveryId: "job1:1",
      patch: { summary: "stale retry", state: "cancelled" },
      event: { runId: run.id, round: 1, source: "system", type: "run.usage", message: "usage", at: new Date().toISOString() },
    });
    expect(repeat.applied).toBe(false);
    expect(store.getRun(run.id)?.summary).toBe("round one");
    expect((await store.getEvents(run.id)).filter((item) => item.type === "run.usage").length).toBe(1);
  });

  it("does not publish a failed transaction to the read cache (AUD-06)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "withTransaction") {
          return async () => { throw new Error("injected transaction failure"); };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const broken = new PostgresRunStore(failing as typeof db);
    await broken.init();
    await expect(broken.updateRun(run.id, { state: "preparing", summary: "should not stick" })).rejects.toThrow(/injected/);
    expect(broken.getRun(run.id)?.state).toBe("queued");
    expect(broken.getRun(run.id)?.summary).not.toBe("should not stick");
  });

  it("stores the full diff artifact body and keeps it across later run updates (AUD-16)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun({ diff: "diff --git a/f b/f\n+first preview\n" });
    await store.createRun(run, event(run.id, "run.created"));
    // createRun projects metadata only (no body yet).
    expect(await store.getArtifact(run.id, "diff")).toMatchObject({ bytes: Buffer.byteLength(run.diff), content: null });

    const full = "diff --git a/f b/f\n+full body\n+".concat("x".repeat(50_000), "\n");
    await store.saveArtifact({ runId: run.id, artifactId: "diff", kind: "patch", content: full, baseSha: "abc123" });
    // A later update with a (possibly truncated) preview must not wipe the body.
    await store.updateRun(run.id, { diff: "diff --git a/f b/f\n+truncated\n" });

    const artifacts = await store.listArtifacts(run.id);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]).toMatchObject({ artifactId: "diff", kind: "patch", bytes: Buffer.byteLength(full), baseSha: "abc123" });
    const stored = await store.getArtifact(run.id, "diff");
    expect(stored?.content).toBe(full);
    const row = (await db.query("SELECT content, base_sha FROM run_artifacts WHERE run_id = $1 AND artifact_id = 'diff'", [run.id])).rows[0];
    expect(String(row.content)).toBe(full);
    expect(String(row.base_sha)).toBe("abc123");
  });

  it("stores check exit codes for check records (GAP-04)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun({ checks: [{ id: "c1", name: "tests", command: "npm test", status: "failed", exitCode: 2, durationMs: 12 }] });
    await store.createRun(run, event(run.id, "run.created"));
    const row = (await db.query("SELECT exit_code, status FROM run_checks WHERE run_id = $1 AND check_id = 'c1'", [run.id])).rows[0];
    expect(Number(row.exit_code)).toBe(2);
    expect(String(row.status)).toBe("failed");
  });


  it("hydrates a run written by another process instead of reporting it missing", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = { id: "run_other_process", ownerId: "owner-1", state: "running", mode: "real", round: 1, title: "外部进程创建", task: "t", checks: [], events: [], artifacts: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    await db.query(
      "INSERT INTO runs (id, owner_id, state, mode, last_seq, document_json, updated_at, created_at) VALUES ($1, $2, $3, 'real', 3, $4, $5, $6)",
      [run.id, run.ownerId, run.state, JSON.stringify(run), run.createdAt, run.createdAt],
    );
    expect(store.getRun(run.id)).toBeUndefined();
    const hydrated = await store.hydrate(run.id);
    expect(hydrated?.id).toBe(run.id);
    expect(hydrated?.lastSeq).toBe(3);
    expect(store.getRun(run.id)?.title).toBe("外部进程创建");
  });


  it("refreshes a stale cached snapshot when the database moved on", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const base = { id: "run_stale_cache", ownerId: "owner-1", state: "running", mode: "real", round: 1, checks: [], events: [], artifacts: [], task: "t" };
    const older = { ...base, title: "旧快照", updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...base, title: "新快照", state: "cancelled", updatedAt: "2026-01-01T01:00:00.000Z" };
    await db.query(
      "INSERT INTO runs (id, owner_id, state, mode, last_seq, document_json, updated_at, created_at) VALUES ($1, $2, 'running', 'real', 1, $3, $4, $5)",
      [base.id, base.ownerId, JSON.stringify(older), older.updatedAt, older.updatedAt],
    );
    await store.hydrate(base.id);
    expect(store.getRun(base.id)?.title).toBe("旧快照");

    // Another process cancels the run: the cached snapshot must not keep serving cancelled=false.
    await db.query("UPDATE runs SET document_json = $2, updated_at = $3, last_seq = 2 WHERE id = $1", [base.id, JSON.stringify(newer), newer.updatedAt]);
    await store.hydrate(base.id);
    expect(store.getRun(base.id)?.state).toBe("cancelled");
    expect(store.getRun(base.id)?.title).toBe("新快照");

    // And a strictly newer cache is never downgraded by an older database row.
    await db.query("UPDATE runs SET document_json = $2, updated_at = $3 WHERE id = $1", [base.id, JSON.stringify({ ...base, title: "更旧", updatedAt: "2025-12-31T00:00:00.000Z" }), "2025-12-31T00:00:00.000Z"]);
    await store.hydrate(base.id);
    expect(store.getRun(base.id)?.title).toBe("新快照");
  });
  it("never lets a stale second-instance patch resurrect a cancelled run (NEW-05)", async () => {
    const db = await createTestDb();
    const storeA = new PostgresRunStore(db);
    const storeB = new PostgresRunStore(db);
    await storeA.init();
    await storeB.init();
    const run = makeRun({ state: "reviewing" });
    await storeA.createRun(run, event(run.id, "run.created"));

    // Both web instances hydrate the same `reviewing` snapshot (rolling deploy).
    await storeA.hydrate(run.id);
    await storeB.hydrate(run.id);
    expect(storeB.getRun(run.id)?.state).toBe("reviewing");

    // Instance A commits a cancellation.
    await storeA.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
    // Instance B still holds the stale snapshot.
    expect(storeB.getRun(run.id)?.state).toBe("reviewing");

    // A late callback on B carries only accounting fields; it must be rebased on
    // the database row and must not write `reviewing` back.
    await storeB.applyDelivery({ runId: run.id, deliveryId: "job1:late-model-calls", patch: { modelCalls: 3 } });

    const stored = (await db.query("SELECT state, document_json FROM runs WHERE id = $1", [run.id])).rows[0];
    expect(String(stored.state)).toBe("cancelled");
    expect((JSON.parse(String(stored.document_json)) as Run).state).toBe("cancelled");
    expect(storeB.getRun(run.id)?.state).toBe("cancelled");
    expect(storeB.getRun(run.id)?.modelCalls).toBe(3);

    // An explicit stale state patch is rejected, not silently applied.
    await expect(storeB.updateRun(run.id, { state: "reviewing" })).rejects.toThrow(/Illegal run state transition/);
    await expect(
      storeB.applyDelivery({ runId: run.id, deliveryId: "job1:late-state", patch: { state: "reviewing" } }),
    ).rejects.toThrow(/Illegal run state transition/);
    expect(storeB.getRun(run.id)?.state).toBe("cancelled");
  });

  it("never regresses last_seq from a stale cache or duplicate delivery (NEW-05)", async () => {
    const db = await createTestDb();
    const storeA = new PostgresRunStore(db);
    const storeB = new PostgresRunStore(db);
    await storeA.init();
    await storeB.init();
    const run = makeRun();
    await storeA.createRun(run, event(run.id, "run.created"));
    await storeB.hydrate(run.id);

    await storeA.appendEvent(event(run.id, "run.step"));
    const committed = Number((await db.query("SELECT last_seq FROM runs WHERE id = $1", [run.id])).rows[0].last_seq);
    expect(committed).toBe(2);
    // B's cache is now stale (lastSeq 1 vs committed 2).
    expect(storeB.getRun(run.id)?.lastSeq).toBe(1);

    // Even an explicitly stale sequence in the patch cannot rewind the column.
    await storeB.applyDelivery({ runId: run.id, deliveryId: "job1:stale-seq", patch: { summary: "stale", lastSeq: 0 } });
    expect(Number((await db.query("SELECT last_seq FROM runs WHERE id = $1", [run.id])).rows[0].last_seq)).toBe(committed);

    // A repeated delivery is a no-op and leaves the sequence untouched.
    const replay = await storeB.applyDelivery({ runId: run.id, deliveryId: "job1:stale-seq", patch: { summary: "retry" } });
    expect(replay.applied).toBe(false);
    expect(Number((await db.query("SELECT last_seq FROM runs WHERE id = $1", [run.id])).rows[0].last_seq)).toBe(committed);
    expect(storeB.getRun(run.id)?.lastSeq).toBe(committed);
  });

  it("still applies a legitimate sequential update and bumps the revision (NEW-05)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));

    await store.updateRun(run.id, { state: "preparing", summary: "first" });
    const updated = await store.updateRun(run.id, { state: "developing", summary: "second" });

    expect(updated.state).toBe("developing");
    expect(updated.summary).toBe("second");
    const stored = (await db.query("SELECT state, revision FROM runs WHERE id = $1", [run.id])).rows[0];
    expect(String(stored.state)).toBe("developing");
    expect(Number(stored.revision)).toBe(2);
  });

  // ------------------------------------------------------------------ B5 delete

  const RUN_ID_TABLES = [
    "run_events",
    "run_agents",
    "run_checks",
    "run_findings",
    "run_artifacts",
    "run_usage_role",
    "run_checkpoints",
    "run_deliveries",
    "jobs",
  ];

  async function orphanCounts(db: Awaited<ReturnType<typeof createTestDb>>, runId: string) {
    const counts: Record<string, number> = {};
    for (const table of RUN_ID_TABLES) {
      const row = (await db.query(`SELECT COUNT(*) AS total FROM ${table} WHERE run_id = $1`, [runId])).rows[0];
      counts[table] = Number(row.total);
    }
    return counts;
  }

  it("deletes run, jobs and deliveries together, leaving no orphan rows (B5)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun({
      diff: "diff --git a/x b/x\n",
      checks: [{ id: "c1", name: "npm test", command: "npm test", status: "passed" }],
      findings: [{ id: "f1", severity: "high", file: "src/a.ts", line: 1, title: "t", evidence: "e", requiredChange: "r", resolved: false }],
      plan: {
        complexity: "small",
        rationale: "r",
        strategy: "single",
        tasks: [{ id: "implementation", title: "实现", description: "d", files: [], dependsOn: [], status: "completed" }],
      },
      usageRoles: [{ role: "developer", provider: "deepseek", model: "deepseek-flash", inputTokens: 1, outputTokens: 2, estimatedCost: 0.01, calls: 1 }],
    });
    await store.createRun(run, event(run.id, "run.created"));
    await store.createJob({ id: "job_1", runId: run.id, kind: "run", payload: { runId: run.id } });
    await store.saveCheckpoint({ runId: run.id, stageKey: "planning", status: "completed" });
    await store.applyDelivery({ runId: run.id, deliveryId: "job_1:1", patch: { summary: "one" } });
    await store.saveArtifact({ runId: run.id, artifactId: "review", kind: "text", content: "body" });

    // Every dependent table actually has rows before the delete.
    const before = await orphanCounts(db, run.id);
    for (const table of RUN_ID_TABLES) expect(before[table]).toBeGreaterThan(0);

    await store.deleteRun(run.id);

    expect(store.getRun(run.id)).toBeUndefined();
    const after = await orphanCounts(db, run.id);
    for (const table of RUN_ID_TABLES) expect(`${table}=${after[table]}`).toBe(`${table}=0`);
    expect(Number((await db.query("SELECT COUNT(*) AS total FROM runs")).rows[0].total)).toBe(0);

    // A deleted run cannot be deleted twice.
    await expect(store.deleteRun(run.id)).rejects.toThrow(/Run not found/);
  });

  it("keeps the cache and database intact when the delete transaction fails (B5)", async () => {
    const db = await createTestDb();
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id, "run.created"));
    await store.createJob({ id: "job_1", runId: run.id, kind: "run", payload: { runId: run.id } });

    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "withTransaction") {
          return async () => { throw new Error("injected delete failure"); };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const broken = new PostgresRunStore(failing as typeof db);
    await broken.init();
    await expect(broken.deleteRun(run.id)).rejects.toThrow(/injected delete failure/);

    // The cache still serves the run and the database still owns every row.
    expect(broken.getRun(run.id)?.id).toBe(run.id);
    const after = await orphanCounts(db, run.id);
    expect(after.run_events).toBeGreaterThan(0);
    expect(after.jobs).toBeGreaterThan(0);
    expect(Number((await db.query("SELECT COUNT(*) AS total FROM runs WHERE id = $1", [run.id])).rows[0].total)).toBe(1);
  });

});

