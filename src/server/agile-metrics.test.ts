import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import type { AcceptanceSnapshot } from "../shared/types.js";
import { AgileService } from "./agile.js";
import { readAgileMetrics, readReleaseRetrospective, readReleaseSummary } from "./agile-metrics.js";
import { createTestDb } from "./test-db.js";
import type { Db } from "./db.js";

function makeRun(id: string, state: Run["state"], extra: Partial<Run> = {}): Run {
  return {
    id,
    ownerId: "user_a",
    title: "run title",
    task: "a sufficiently long task",
    repository: "/srv/repo",
    branch: `pigo/${id}`,
    mode: "real",
    state,
    round: 1,
    maxRounds: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    developer: { provider: "p", model: "m" },
    reviewer: { provider: "p", model: "m" },
    checks: [],
    findings: [],
    diff: "",
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
    ...extra,
  };
}

function acceptance(acceptedAt: string): AcceptanceSnapshot {
  return {
    acceptedAt,
    acceptedBy: "user_a",
    note: null,
    acknowledgedOpenFindings: false,
    findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } },
    diff: { artifactId: null, sha256: null, bytes: null },
    checks: { total: 0, passed: 0, failed: 0 },
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 },
  };
}

async function insertRun(db: Db, run: Run) {
  await db.query(
    "INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, last_seq, document_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [run.id, run.ownerId, run.state, run.mode, run.createdAt, run.updatedAt, run.lastSeq, JSON.stringify(run)],
  );
}

async function insertEvent(db: Db, runId: string, seq: number, type: string) {
  await db.query(
    "INSERT INTO run_events (run_id, seq, at, round, source, type, message) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [runId, seq, "2026-01-02T00:00:00.000Z", 1, "reviewer", type, "event"],
  );
}

describe("readAgileMetrics", () => {
  it("returns explicit zeros for an owner with no agile data", async () => {
    const db = await createTestDb();
    const metrics = await readAgileMetrics(db, ["user_a"]);
    expect(metrics.sprints).toEqual([]);
    expect(metrics.projects).toEqual([]);
  });

  it("aggregates per-sprint metrics and the project rollup", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    const done = await service.createStory("user_a", { projectId: project.id, title: "完成的", sprintId: sprint.id });
    const reviewing = await service.createStory("user_a", { projectId: project.id, title: "审核中", sprintId: sprint.id });
    await service.createStory("user_a", { projectId: project.id, title: "待办" });

    await insertRun(db, makeRun("run_done_1", "developing", { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z" }));
    await insertRun(db, makeRun("run_done_2", "completed", {
      createdAt: "2026-01-01T06:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      acceptance: acceptance("2026-01-03T00:00:00.000Z"),
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, estimatedCost: 0.5 },
      modelCalls: 4,
      findings: [{ id: "f1", severity: "high", file: null, line: null, title: "a", evidence: "", requiredChange: "x", resolved: true }],
    }));
    await insertRun(db, makeRun("run_review", "reviewing", { usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.1 } }));
    await service.linkRun(done.id, "run_done_1");
    await service.linkRun(done.id, "run_done_2");
    await service.linkRun(reviewing.id, "run_review");
    await insertEvent(db, "run_done_2", 1, "review.changes_requested");
    await insertEvent(db, "run_review", 1, "review.not_converging");

    const metrics = await readAgileMetrics(db, ["user_a"]);
    expect(metrics.sprints).toHaveLength(1);
    const sprintMetrics = metrics.sprints[0];
    expect(sprintMetrics.name).toBe("Sprint 1");
    expect(sprintMetrics.stories.total).toBe(2);
    expect(sprintMetrics.stories.completed).toBe(1);
    expect(sprintMetrics.stories.byStatus.done).toBe(1);
    expect(sprintMetrics.stories.byStatus.in_review).toBe(1);
    expect(sprintMetrics.cycleTime.samples).toBe(1);
    expect(sprintMetrics.cycleTime.items[0].seconds).toBe(172_800);
    expect(sprintMetrics.rework).toEqual({ completed: 1, reworked: 1, rate: 1 });
    expect(sprintMetrics.usage).toMatchObject({ cost: 0.6, inputTokens: 110, outputTokens: 45, cacheReadTokens: 7, modelCalls: 4, runs: 3 });
    expect(sprintMetrics.costPerCompletedStory).toBe(0.6);
    expect(sprintMetrics.reviewFindings).toEqual({ total: 1, resolved: 1, notConverging: 1 });
    expect(sprintMetrics.runOutcomes).toEqual({ completed: 1, needs_human: 0, cancelled: 0, failed: 0 });

    // Project rollup also counts the backlog story (no sprint).
    const projectMetrics = metrics.projects[0];
    expect(projectMetrics.key).toBe("AUTH");
    expect(projectMetrics.stories.total).toBe(3);
    expect(projectMetrics.stories.byStatus.backlog).toBe(1);
  });

  it("scopes results to owner keys and optional filters", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const other = await service.createProject("user_a", { name: "支付", key: "PAY" });
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    await service.createStory("user_a", { projectId: project.id, title: "故事", sprintId: sprint.id });
    await service.createStory("user_a", { projectId: other.id, title: "支付故事" });

    const foreign = await readAgileMetrics(db, ["user_b"]);
    expect(foreign.sprints).toHaveLength(0);
    expect(foreign.projects).toHaveLength(0);

    const scoped = await readAgileMetrics(db, ["user_a"], { projectId: project.id, sprintId: sprint.id });
    expect(scoped.projects).toHaveLength(1);
    expect(scoped.projects[0].stories.total).toBe(1);
    expect(scoped.sprints).toHaveLength(1);
    expect(scoped.sprints[0].stories.total).toBe(1);
    expect(scoped.sprints[0].stories.byStatus.backlog).toBe(1);
  });
});

describe("readReleaseSummary / readReleaseRetrospective", () => {
  it("shapes the release dataset from owner-scoped stories and their linked runs", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const done = await service.createStory("user_a", { projectId: project.id, title: "完成的" });
    const blocked = await service.createStory("user_a", { projectId: project.id, title: "阻塞的" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [done.id, blocked.id] });

    await insertRun(db, makeRun("run_done", "completed", {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      acceptance: acceptance("2026-01-02T00:00:00.000Z"),
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 3, estimatedCost: 0.5 },
      modelCalls: 4,
      merge: { commit: "abc123", strategy: "merge-commit", targetBranch: "main", mergedAt: "2026-01-02T01:00:00.000Z", mergedBy: "user_a" },
      release: { deliveryId: "d1", status: "succeeded", environment: "prod", commit: "abc123", targetBranch: "main", requestedAt: "2026-01-02T02:00:00.000Z", requestedBy: "user_a", startedAt: "2026-01-02T02:00:01.000Z", attempt: 1, kind: "webhook" },
    }));
    await insertRun(db, makeRun("run_blocked", "needs_human", { summary: "缺少凭据" }));
    await service.linkRun(done.id, "run_done");
    await service.linkRun(blocked.id, "run_blocked");
    await insertEvent(db, "run_done", 1, "review.changes_requested");
    await insertEvent(db, "run_blocked", 2, "review.not_converging");

    const summary = await readReleaseSummary(db, ["user_a"], release.id);
    expect(summary).toBeDefined();
    expect(summary!.totals).toEqual({ stories: 2, done: 1, inProgress: 0, blocked: 1, notStarted: 0, runs: 2 });
    expect(summary!.usage).toMatchObject({ cost: 0.5, modelCalls: 4, runs: 2 });
    expect(summary!.merges).toHaveLength(1);
    expect(summary!.deployments).toHaveLength(1);

    const retro = await readReleaseRetrospective(db, ["user_a"], release.id);
    expect(retro).toBeDefined();
    expect(retro!.cycleTime.samples).toBe(1);
    expect(retro!.notConvergingRuns).toBe(1);
    expect(retro!.reviewFindings.notConverging).toBe(1);
    expect(retro!.blockedStories.map((story) => story.reason)).toEqual(["缺少凭据"]);
    expect(retro!.costPerCompletedStory).toBe(0.5);
  });

  it("carries the publish record (releasedAt/By + deploy) into the summary and retrospective", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "完成的", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId: `release-publish:${release.id}`,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: "2026-01-03T00:00:00.000Z",
      deploy: { status: "failed", detail: "HTTP 503", at: "2026-01-03T00:00:01.000Z" },
      stories,
    });

    const summary = await readReleaseSummary(db, ["user_a"], release.id);
    expect(summary).toMatchObject({ status: "released", releasedAt: "2026-01-03T00:00:00.000Z", releasedBy: "user_a" });
    expect(summary!.deploy).toMatchObject({ status: "failed", detail: "HTTP 503" });
    const retro = await readReleaseRetrospective(db, ["user_a"], release.id);
    expect(retro).toMatchObject({ releasedAt: "2026-01-03T00:00:00.000Z", releasedBy: "user_a", deploy: { status: "failed", detail: "HTTP 503" } });
  });

  it("surfaces a manual block reason on the release story outcome", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "阻塞的" });
    await service.blockStory(["user_a"], story.id, "等待上游接口", "user_a");
    const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [story.id] });

    const summary = await readReleaseSummary(db, ["user_a"], release.id);
    expect(summary!.totals.blocked).toBe(1);
    expect(summary!.stories[0]).toMatchObject({ status: "blocked", blockedReason: "等待上游接口" });
    const retro = await readReleaseRetrospective(db, ["user_a"], release.id);
    expect(retro!.blockedStories[0]).toMatchObject({ reason: "等待上游接口" });
  });

  it("returns undefined for an unknown release and never leaks another owner's release", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [] });

    expect(await readReleaseSummary(db, ["user_b"], release.id)).toBeUndefined();
    expect(await readReleaseRetrospective(db, ["user_b"], release.id)).toBeUndefined();
    expect(await readReleaseSummary(db, ["user_a"], "rel_missing")).toBeUndefined();
    expect(await readReleaseRetrospective(db, [], release.id)).toBeUndefined();
  });

  it("shapes an empty release as explicit zeros", async () => {
    const db = await createTestDb();
    const service = new AgileService(db);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [] });

    const summary = await readReleaseSummary(db, ["user_a"], release.id);
    expect(summary).toMatchObject({ releaseId: release.id, version: "v1.0.0" });
    expect(summary!.totals).toEqual({ stories: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0, runs: 0 });
    expect(summary!.stories).toEqual([]);

    const retro = await readReleaseRetrospective(db, ["user_a"], release.id);
    expect(retro!.cycleTime.samples).toBe(0);
    expect(retro!.costPerCompletedStory).toBe(0);
  });
});
