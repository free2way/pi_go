import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import { AgileError, AgileService } from "./agile.js";
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

async function insertRun(db: Db, run: Run) {
  await db.query(
    "INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, last_seq, document_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [run.id, run.ownerId, run.state, run.mode, run.createdAt, run.updatedAt, run.lastSeq, JSON.stringify(run)],
  );
}

async function replaceRun(db: Db, run: Run) {
  await db.query("UPDATE runs SET state = $1, updated_at = $2, document_json = $3 WHERE id = $4", [run.state, run.updatedAt, JSON.stringify(run), run.id]);
}

async function seed() {
  const db = await createTestDb();
  const service = new AgileService(db);
  const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH", description: "登录与鉴权" });
  return { db, service, project };
}

describe("AgileService projects", () => {
  it("creates, lists, updates and scopes projects to the owner", async () => {
    const { service, project } = await seed();
    expect(project).toMatchObject({ name: "认证服务", key: "AUTH", ownerId: "user_a" });
    expect(await service.listProjects(["user_a"])).toHaveLength(1);
    expect(await service.listProjects(["user_b"])).toHaveLength(0);

    const updated = await service.updateProject(["user_a"], project.id, { name: "认证平台" });
    expect(updated.name).toBe("认证平台");

    await expect(service.getProject(["user_b"], project.id)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    // Admins may read another owner's project.
    expect((await service.getProject([], project.id, true)).id).toBe(project.id);
  });

  it("rejects a duplicate project key per owner", async () => {
    const { service, project } = await seed();
    await expect(service.createProject("user_a", { name: "另一个", key: project.key })).rejects.toBeInstanceOf(AgileError);
    // A different owner may reuse the key.
    await expect(service.createProject("user_b", { name: "另一个", key: project.key })).resolves.toMatchObject({ key: "AUTH" });
  });

  it("cascades deletes to stories, sprints, releases and run links", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事一" });
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    await service.createRelease("user_a", { projectId: project.id, name: "v1", version: "1.0.0" });
    await insertRun(db, makeRun("run_1", "developing"));
    await service.linkRun(story.id, "run_1");

    await service.deleteProject(["user_a"], project.id);

    expect(await service.listProjects(["user_a"])).toHaveLength(0);
    expect(await service.listStories(["user_a"])).toHaveLength(0);
    expect(await service.listSprints(["user_a"])).toHaveLength(0);
    expect(await service.listReleases(["user_a"])).toHaveLength(0);
    const links = await db.query("SELECT COUNT(*)::int AS count FROM story_runs");
    expect(Number((links.rows[0] as { count: number }).count)).toBe(0);
    expect(sprint.id).toBeTruthy();
  });
});

describe("AgileService stories", () => {
  it("persists acceptance criteria, priority, estimate and definition of done", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", {
      projectId: project.id,
      title: "限流",
      description: "给 session 加限流",
      acceptanceCriteria: ["返回 429"],
      priority: "must",
      estimate: 5,
      definitionOfDone: ["测试通过"],
      maxParallel: 2,
    });
    expect(story).toMatchObject({
      priority: "must",
      estimate: 5,
      acceptanceCriteria: ["返回 429"],
      definitionOfDone: ["测试通过"],
      maxParallel: 2,
      status: "backlog",
      sprintId: null,
    });

    const patched = await service.updateStory(["user_a"], story.id, { status: "ready", estimate: 8, acceptanceCriteria: ["返回 429", "可重试"] });
    expect(patched).toMatchObject({ status: "ready", estimate: 8 });
    expect(patched.acceptanceCriteria).toEqual(["返回 429", "可重试"]);
  });

  it("filters stories by project, sprint and status", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    const first = await service.createStory("user_a", { projectId: project.id, title: "故事一", status: "ready" });
    await service.createStory("user_a", { projectId: project.id, title: "故事二" });
    await service.updateStory(["user_a"], first.id, { sprintId: sprint.id });

    expect(await service.listStories(["user_a"], { projectId: project.id })).toHaveLength(2);
    expect(await service.listStories(["user_a"], { sprintId: sprint.id })).toHaveLength(1);
    expect(await service.listStories(["user_a"], { sprintId: null })).toHaveLength(1);
    expect(await service.listStories(["user_a"], { status: "ready" })).toHaveLength(1);
  });

  it("rejects assigning a story to a sprint of another project", async () => {
    const { service, project } = await seed();
    const other = await service.createProject("user_a", { name: "支付", key: "PAY" });
    const sprint = await service.createSprint("user_a", { projectId: other.id, name: "Sprint 支付" });
    await expect(service.createStory("user_a", { projectId: project.id, title: "故事", sprintId: sprint.id })).rejects.toMatchObject({ code: "SPRINT_NOT_FOUND" });
  });

  it("returns stories to the backlog when their sprint is deleted", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", sprintId: sprint.id });
    await service.deleteSprint(["user_a"], sprint.id);
    expect((await service.getStory(["user_a"], story.id)).sprintId).toBeNull();
  });
});

describe("AgileService releases", () => {
  it("tracks story ids and status updates", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    expect(release).toMatchObject({ version: "1.0.0", status: "planned", storyIds: [story.id] });
    const updated = await service.updateRelease(["user_a"], release.id, { status: "released", storyIds: [] });
    expect(updated).toMatchObject({ status: "released", storyIds: [] });
  });
});

describe("AgileService run linkage and reconciliation", () => {
  it("links several runs to one story and summarizes them in the detail", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });
    await insertRun(db, makeRun("run_1", "developing", {
      updatedAt: "2026-01-01T00:00:00.000Z",
      findings: [{ id: "f1", severity: "high", file: null, line: null, title: "t", evidence: "", requiredChange: "x", resolved: true }],
      checks: [{ id: "c1", name: "lint", command: "npm run lint", status: "passed" }],
      usage: { inputTokens: 1, outputTokens: 2, estimatedCost: 0.5 },
    }));
    await insertRun(db, makeRun("run_2", "completed", { updatedAt: "2026-01-02T00:00:00.000Z" }));
    await service.linkRun(story.id, "run_1");
    await service.linkRun(story.id, "run_2");

    const detail = await service.getStory(["user_a"], story.id);
    expect(detail.runs.map((entry) => entry.runId).sort()).toEqual(["run_1", "run_2"]);
    const first = detail.runs.find((entry) => entry.runId === "run_1")!;
    expect(first).toMatchObject({ state: "developing", findings: { resolved: 1, total: 1 }, checks: { passed: 1, failed: 0 }, cost: 0.5 });
    // latest linked run (run_2, completed) drives the derived status.
    expect(detail.status).toBe("awaiting_acceptance");
  });

  it("derives in_progress → awaiting_acceptance → done → blocked as the run moves", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_1", "developing"));
    await service.linkRun(story.id, "run_1");

    expect((await service.getStory(["user_a"], story.id)).status).toBe("in_progress");

    await replaceRun(db, makeRun("run_1", "completed", { updatedAt: "2026-01-02T00:00:00.000Z" }));
    expect((await service.getStory(["user_a"], story.id)).status).toBe("awaiting_acceptance");

    const accepted = makeRun("run_1", "completed", {
      updatedAt: "2026-01-03T00:00:00.000Z",
      acceptance: {
        acceptedAt: "2026-01-03T00:00:00.000Z",
        acceptedBy: "user_a",
        note: null,
        acknowledgedOpenFindings: false,
        findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } },
        diff: { artifactId: null, sha256: null, bytes: null },
        checks: { total: 0, passed: 0, failed: 0 },
        usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 },
      },
    });
    await replaceRun(db, accepted);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("done");

    await replaceRun(db, makeRun("run_1", "needs_human", { updatedAt: "2026-01-04T00:00:00.000Z", summary: "等待人工确认预算" }));
    const blocked = await service.getStory(["user_a"], story.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.runs[0].summary).toBe("等待人工确认预算");
  });

  it("reconcileRun converges a story from the run update path", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_1", "developing"));
    await service.linkRun(story.id, "run_1");
    await service.markStoryInProgress(story.id);

    await replaceRun(db, makeRun("run_1", "cancelled", { updatedAt: "2026-01-02T00:00:00.000Z", summary: "已由用户取消" }));
    expect(await service.reconcileRun("run_1")).toEqual(["blocked"]);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("blocked");
    // Unlinked runs reconcile to nothing.
    expect(await service.reconcileRun("run_missing")).toEqual([]);
  });

  it("leaves a story without runs at its manual status", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });
    expect((await service.getStory(["user_a"], story.id)).status).toBe("ready");
  });

  it("never derives across owners: a foreign story is invisible", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await expect(service.getStory(["user_b"], story.id)).rejects.toMatchObject({ code: "STORY_NOT_FOUND" });
  });
});
