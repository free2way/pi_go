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

/**
 * Simulates the run-level block the reconciler produces (or a story already
 * stuck from before the fix): status `blocked` with no manual `blocked_reason`.
 */
async function forceRunBlock(db: Db, storyId: string, before: string | null = null) {
  await db.query(
    "UPDATE agile_stories SET status = 'blocked', blocked_reason = NULL, blocked_at = NULL, blocked_by = NULL, status_before_block = $1 WHERE id = $2",
    [before, storyId],
  );
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

  it("列表接口带子对象计数（删除前如实告知），单项读取不带", async () => {
    const { service, project } = await seed();
    await service.createStory("user_a", { projectId: project.id, title: "故事一" });
    await service.createStory("user_a", { projectId: project.id, title: "故事二" });
    await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    await service.createRelease("user_a", { projectId: project.id, name: "v1", version: "1.0.0" });

    const [listed] = await service.listProjects(["user_a"]);
    expect(listed.counts).toEqual({ stories: 2, sprints: 1, releases: 1 });

    // 单项读取不带计数（避免多余查询），字段是 optional
    const single = await service.getProject(["user_a"], project.id);
    expect(single.counts).toBeUndefined();

    // 空项目是 0，不是缺字段
    const empty = await service.createProject("user_a", { name: "空项目", key: "EMPTY" });
    const listedEmpty = (await service.listProjects(["user_a"])).find((row) => row.id === empty.id);
    expect(listedEmpty?.counts).toEqual({ stories: 0, sprints: 0, releases: 0 });
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

describe("AgileService templates", () => {
  it("creates, lists, scopes and deletes owner-scoped model templates", async () => {
    const { service } = await seed();
    const template = await service.createTemplate("user_a", {
      name: "快速组合",
      developerModel: { provider: "deepseek", model: "flash" },
      reviewerModel: { provider: "openai-proxy", model: "gpt" },
      budget: { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 },
      maxParallel: 2,
    });
    expect(template).toMatchObject({ name: "快速组合", maxParallel: 2, ownerId: "user_a" });
    expect(template.developerModel).toEqual({ provider: "deepseek", model: "flash" });
    expect(template.budget).toEqual({ maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 });

    expect(await service.listTemplates(["user_a"])).toHaveLength(1);
    expect(await service.listTemplates(["user_b"])).toHaveLength(0);

    await service.deleteTemplate(["user_a"], template.id);
    expect(await service.listTemplates(["user_a"])).toHaveLength(0);
    await expect(service.deleteTemplate(["user_a"], template.id)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", status: 404 });
  });

  it("rejects a duplicate template name for the same owner but allows another owner to reuse it", async () => {
    const { service } = await seed();
    const input = {
      name: "省钱",
      developerModel: { provider: "deepseek", model: "flash" },
      reviewerModel: { provider: "anthropic", model: "sonnet" },
    };
    await service.createTemplate("user_a", input);
    await expect(service.createTemplate("user_a", input)).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN", status: 409 });
    await expect(service.createTemplate("user_b", input)).resolves.toMatchObject({ name: "省钱", ownerId: "user_b" });
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

    await replaceRun(db, makeRun("run_1", "reviewing", { updatedAt: "2026-01-01T12:00:00.000Z" }));
    expect((await service.getStory(["user_a"], story.id)).status).toBe("in_review");

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

    // A terminal cancelled run must not hold a run-level block: reconcile
    // returns the story to `ready` so it can be retried.
    await replaceRun(db, makeRun("run_1", "cancelled", { updatedAt: "2026-01-02T00:00:00.000Z", summary: "已由用户取消" }));
    expect(await service.reconcileRun("run_1")).toEqual(["ready"]);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("ready");
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

const acceptance: NonNullable<Run["acceptance"]> = {
  acceptedAt: "2026-01-03T00:00:00.000Z",
  acceptedBy: "user_a",
  note: null,
  acknowledgedOpenFindings: false,
  findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } },
  diff: { artifactId: null, sha256: null, bytes: null },
  checks: { total: 0, passed: 0, failed: 0 },
  usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 },
};

describe("AgileService manual blocking", () => {
  it("blocks a run-less story and restores the pre-block status on unblock", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });

    const blocked = await service.blockStory(["user_a"], story.id, "等待上游接口", "user_a");
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "等待上游接口", blockedBy: "user_a" });
    expect(blocked.blockedAt).toBeTruthy();

    const unblocked = await service.unblockStory(["user_a"], story.id);
    expect(unblocked).toMatchObject({ status: "ready", blockedReason: null, blockedBy: null });
  });

  it("lets a manual block win over a derived in-progress status", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_1", "developing"));
    await service.linkRun(story.id, "run_1");
    expect((await service.getStory(["user_a"], story.id)).status).toBe("in_progress");

    await service.blockStory(["user_a"], story.id, "暂停开发", "user_a");
    expect((await service.getStory(["user_a"], story.id)).status).toBe("blocked");
    expect((await service.listStories(["user_a"])).find((entry) => entry.id === story.id)?.blockedReason).toBe("暂停开发");

    // Unblocking re-derives from the still-active run.
    expect((await service.unblockStory(["user_a"], story.id)).status).toBe("in_progress");
  });

  it("refuses to unblock while a linked run is parked, naming the run", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_parked", "needs_human", { summary: "预算超限" }));
    await service.linkRun(story.id, "run_parked");
    await service.reconcileRun("run_parked");

    await expect(service.unblockStory(["user_a"], story.id)).rejects.toMatchObject({ code: "BLOCKED_BY_RUN", status: 409 });
    await expect(service.unblockStory(["user_a"], story.id)).rejects.toThrow(/run_parked/);
    // The run-derived reason is surfaced without a stored manual block.
    const listed = (await service.listStories(["user_a"])).find((entry) => entry.id === story.id);
    expect(listed?.status).toBe("blocked");
    expect(listed?.blockedReason).toBe("预算超限");
  });

  it("refuses to manually block a delivered (done) story", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_1", "completed", { acceptance }));
    await service.linkRun(story.id, "run_1");
    expect((await service.getStory(["user_a"], story.id)).status).toBe("done");

    await expect(service.blockStory(["user_a"], story.id, "手动原因", "user_a")).rejects.toMatchObject({ code: "STORY_DONE", status: 409 });
  });
});

describe("AgileService automatic run-block release", () => {
  it("releases a story blocked by a cancelled run, restoring the pre-block status", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });
    await insertRun(db, makeRun("run_cancel", "developing"));
    await service.linkRun(story.id, "run_cancel");
    await service.markStoryInProgress(story.id);
    await forceRunBlock(db, story.id);
    await replaceRun(db, makeRun("run_cancel", "cancelled", { summary: "已由用户取消", updatedAt: "2026-01-02T00:00:00.000Z" }));

    // The released ids drive the run audit event recorded by the caller.
    expect(await service.releaseStoryBlocksForTerminalRun("run_cancel", "cancelled")).toEqual([story.id]);
    const detail = await service.getStory(["user_a"], story.id);
    expect(detail.status).toBe("ready");
    expect(detail.blockedReason).toBeNull();
    expect(detail.blockedBy).toBeNull();
  });

  it("releases a story blocked by a failed run", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_failed", "developing"));
    await service.linkRun(story.id, "run_failed");
    await service.markStoryInProgress(story.id);
    await forceRunBlock(db, story.id);
    await replaceRun(db, makeRun("run_failed", "failed", { summary: "运行失败", updatedAt: "2026-01-02T00:00:00.000Z" }));

    expect(await service.releaseStoryBlocksForTerminalRun("run_failed", "failed")).toEqual([story.id]);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("ready");
  });

  it("releases a story blocked by a completed run to awaiting_acceptance", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_done", "completed"));
    await service.linkRun(story.id, "run_done");
    await forceRunBlock(db, story.id);

    expect(await service.releaseStoryBlocksForTerminalRun("run_done", "completed")).toEqual([story.id]);
    const detail = await service.getStory(["user_a"], story.id);
    expect(detail.status).toBe("awaiting_acceptance");
    expect(detail.blockedReason).toBeNull();
  });

  it("keeps a needs_human run's block and does not release it", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_parked", "needs_human", { summary: "预算超限" }));
    await service.linkRun(story.id, "run_parked");
    await service.reconcileRun("run_parked");

    expect((await service.getStory(["user_a"], story.id)).status).toBe("blocked");
    expect(await service.releaseStoryBlocksForTerminalRun("run_parked", "needs_human")).toEqual([]);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("blocked");
  });

  it("unblock succeeds when the blocking run is terminal (defense in depth)", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_cancel", "cancelled", { summary: "已由用户取消" }));
    await service.linkRun(story.id, "run_cancel");
    await forceRunBlock(db, story.id);

    const unblocked = await service.unblockStory(["user_a"], story.id);
    expect(unblocked).toMatchObject({ status: "ready", blockedReason: null, blockedBy: null });
  });

  it("releases an already-stuck story and the kanban query stops reporting it blocked", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_stuck", "cancelled", { summary: "已由用户取消" }));
    await service.linkRun(story.id, "run_stuck");
    await forceRunBlock(db, story.id);

    expect(await service.releaseStoryBlocksForTerminalRun("run_stuck", "cancelled")).toEqual([story.id]);
    const listed = (await service.listStories(["user_a"])).find((entry) => entry.id === story.id);
    expect(listed?.status).not.toBe("blocked");
    expect(listed?.blockedReason ?? null).toBeNull();
  });

  it("heals a stale run-level block on the detail read path", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_stuck", "cancelled", { summary: "已由用户取消" }));
    await service.linkRun(story.id, "run_stuck");
    await forceRunBlock(db, story.id);

    // No new run transition fires; reading the story must release the stale block.
    const detail = await service.getStory(["user_a"], story.id);
    expect(detail.status).toBe("ready");
    expect(detail.blockedReason).toBeNull();
  });

  it("leaves a manual block untouched when a linked run goes terminal", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_1", "developing"));
    await service.linkRun(story.id, "run_1");
    await service.blockStory(["user_a"], story.id, "暂停开发", "user_a");

    expect(await service.releaseStoryBlocksForTerminalRun("run_1", "cancelled")).toEqual([]);
    const detail = await service.getStory(["user_a"], story.id);
    expect(detail).toMatchObject({ status: "blocked", blockedReason: "暂停开发", blockedBy: "user_a" });
  });
});

describe("AgileService story reopen (failed latest run)", () => {
  it("reopens a failed story to ready, keeps run history and allows a new run afterwards", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });
    await insertRun(db, makeRun("run_failed", "failed", { updatedAt: "2026-01-02T00:00:00.000Z", summary: "运行失败" }));
    await service.linkRun(story.id, "run_failed");
    await service.markStoryInProgress(story.id);

    // The story row is stuck at in_progress (the pre-fix deadlock); the reopen
    // moves it back to ready and reports the observed previous status.
    const stuck = (await db.query("SELECT status FROM agile_stories WHERE id = $1", [story.id])).rows[0] as { status: string };
    expect(stuck.status).toBe("in_progress");

    const reopened = await service.reopenStory(["user_a"], story.id);
    expect(reopened.story.status).toBe("ready");
    expect(reopened.runId).toBe("run_failed");
    expect(reopened.previousStatus).toBe("in_progress");
    // The previous run row survives the reopen (and the audit is keyed by its id).
    expect(reopened.story.runs.map((entry) => entry.runId)).toEqual(["run_failed"]);
    // The read path also heals the stuck status on its own (before any reopen).
    expect((await service.getStory(["user_a"], story.id)).status).toBe("ready");

    // A new run can now be created against the reopened story; both rows remain.
    await insertRun(db, makeRun("run_retry", "developing", { updatedAt: "2026-01-03T00:00:00.000Z" }));
    await service.linkRun(story.id, "run_retry");
    const after = await service.getStory(["user_a"], story.id);
    expect(after.status).toBe("in_progress");
    expect(after.runs.map((entry) => entry.runId).sort()).toEqual(["run_failed", "run_retry"]);
  });

  it("refuses to reopen while the latest run needs a human, naming the run id", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_parked", "needs_human", { summary: "预算超限" }));
    await service.linkRun(story.id, "run_parked");
    await service.reconcileRun("run_parked");

    await expect(service.reopenStory(["user_a"], story.id)).rejects.toMatchObject({ code: "BLOCKED_BY_RUN", status: 409 });
    await expect(service.reopenStory(["user_a"], story.id)).rejects.toThrow(/run_parked/);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("blocked");
  });

  it("refuses to reopen while the latest run is still live, naming the run id", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_live", "developing"));
    await service.linkRun(story.id, "run_live");

    await expect(service.reopenStory(["user_a"], story.id)).rejects.toMatchObject({ code: "BLOCKED_BY_RUN", status: 409 });
    await expect(service.reopenStory(["user_a"], story.id)).rejects.toThrow(/run_live/);
  });

  it("does not silently reopen a manually blocked story", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "ready" });
    await insertRun(db, makeRun("run_failed", "failed", { summary: "运行失败" }));
    await service.linkRun(story.id, "run_failed");
    await service.blockStory(["user_a"], story.id, "等待上游接口", "user_a");

    await expect(service.reopenStory(["user_a"], story.id)).rejects.toMatchObject({ code: "BLOCKED_BY_MANUAL", status: 409 });
    const detail = await service.getStory(["user_a"], story.id);
    expect(detail).toMatchObject({ status: "blocked", blockedReason: "等待上游接口" });
  });

  it("refuses to reopen an already delivered (completed) run", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });
    await insertRun(db, makeRun("run_done", "completed"));
    await service.linkRun(story.id, "run_done");

    await expect(service.reopenStory(["user_a"], story.id)).rejects.toMatchObject({ code: "STORY_NOT_REOPENABLE", status: 409 });
    await expect(service.reopenStory(["user_a"], story.id)).rejects.toThrow(/run_done/);
    expect((await service.getStory(["user_a"], story.id)).status).toBe("awaiting_acceptance");
  });
});

describe("AgileService release publish", () => {
  it("records releasedAt/By, the deploy outcome and an audit row", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    expect(stories).toHaveLength(1);

    const started = await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId: `release-publish:${release.id}`,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: "2026-01-02T00:00:00.000Z",
      note: "首次发布",
      deploy: { status: "ok", detail: "HTTP 200", at: "2026-01-02T00:00:00.000Z" },
      stories,
    });
    expect(started.claimed).toBe(true);
    const published = started.release;
    expect(published).toMatchObject({ status: "released", releasedAt: "2026-01-02T00:00:00.000Z", releasedBy: "user_a" });
    expect(published.deploy).toMatchObject({ status: "ok", detail: "HTTP 200" });

    const audit = await db.query("SELECT action, actor_id, note, status FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "release.published", actor_id: "user_a", note: "首次发布", status: "released" });
  });

  it("treats released as terminal for edits, and a duplicate attempt is never claimed twice", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    const input = {
      releaseId: release.id,
      deliveryId: `release-publish:${release.id}`,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: "2026-01-02T00:00:00.000Z",
      deploy: { status: "not_configured" as const, detail: "未配置", at: "2026-01-02T00:00:00.000Z" },
      stories,
    };
    expect((await service.startReleaseDeploy(input)).claimed).toBe(true);

    await expect(service.updateRelease(["user_a"], release.id, { name: "改名" })).rejects.toMatchObject({ code: "RELEASE_RELEASED", status: 409 });
    expect((await service.startReleaseDeploy(input)).claimed).toBe(false);
  });

  it("claims exactly one attempt when two confirms race (audit P1)", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    const attempt = {
      releaseId: release.id,
      deliveryId: `release-publish:${release.id}`,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: "2026-01-02T00:00:00.000Z",
      deploy: { status: "pending" as const, detail: "HTTP 202", at: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-02T00:00:00.000Z" },
      stories,
    };
    const [first, second] = await Promise.all([service.startReleaseDeploy(attempt), service.startReleaseDeploy(attempt)]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
  });

  it("settles a pending attempt once and never lets a stale writer clobber the callback", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    const deliveryId = `release-publish:${release.id}`;
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: "2026-01-02T00:00:00.000Z",
      stories,
      deploy: { status: "pending", detail: "HTTP 202", at: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-02T00:00:00.000Z", deliveryId, attempt: 1 },
    });

    const ok = await service.settleReleaseDeployResult({
      releaseId: release.id,
      action: "release.deploy_succeeded",
      actorId: "deploy-system",
      now: "2026-01-02T00:01:00.000Z",
      deploy: { status: "ok", detail: "部署系统回调：成功", at: "2026-01-02T00:01:00.000Z", finishedAt: "2026-01-02T00:01:00.000Z", deliveryId, attempt: 1 },
    });
    expect(ok.applied).toBe(true);
    expect(ok.release.deploy).toMatchObject({ status: "ok", attempt: 1 });

    // A late duplicate writer must not overwrite the recorded callback result.
    const late = await service.settleReleaseDeployResult({
      releaseId: release.id,
      action: "release.deploy_failed",
      actorId: "deploy-system",
      now: "2026-01-02T00:02:00.000Z",
      deploy: { status: "failed", detail: "late", at: "2026-01-02T00:02:00.000Z", finishedAt: "2026-01-02T00:02:00.000Z", deliveryId, attempt: 1 },
    });
    expect(late.applied).toBe(false);
    expect(late.release.deploy).toMatchObject({ status: "ok" });

    const audit = await db.query("SELECT action FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(["release.deploy_succeeded", "release.published"]);
  });

  it("expires a pending attempt whose callback never arrived, recording the failure", async () => {
    const { db, service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事", status: "done" });
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [story.id] });
    const stories = await service.collectReleaseStories(["user_a"], release);
    const startedAt = "2026-01-02T00:00:00.000Z";
    const deliveryId = `release-publish:${release.id}`;
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId,
      attempt: 1,
      releasedBy: "user_a",
      releasedAt: startedAt,
      stories,
      deploy: { status: "pending", detail: "HTTP 202", at: startedAt, startedAt, deliveryId, attempt: 1 },
    });

    const expired = await service.expireStaleReleaseDeploys({ now: "2026-01-02T00:10:00.000Z", timeoutMs: 5 * 60_000 });
    expect(expired).toEqual([release.id]);
    const after = await service.getRelease(["user_a"], release.id);
    expect(after.deploy).toMatchObject({ status: "failed", finishedAt: "2026-01-02T00:10:00.000Z" });
    expect(after.deploy?.detail).toContain("超时");

    const audit = await db.query("SELECT action, status FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(["release.deploy_failed", "release.published"]);
    expect(audit.rows.find((row) => row.action === "release.deploy_failed")).toMatchObject({ status: "failed" });
  });

  it("skips foreign story ids and reports a blocked story with its reason", async () => {
    const { service, project } = await seed();
    const blocked = await service.createStory("user_a", { projectId: project.id, title: "阻塞故事" });
    await service.blockStory(["user_a"], blocked.id, "等待上游", "user_a");
    const release = await service.createRelease("user_a", { projectId: project.id, name: "v1.0", version: "1.0.0", storyIds: [blocked.id, "story_foreign"] });

    const stories = await service.collectReleaseStories(["user_a"], release);
    expect(stories.map((entry) => entry.storyId)).toEqual([blocked.id]);
    expect(stories[0]).toMatchObject({ status: "blocked", reason: "等待上游" });
  });
});

describe("AgileService sprint editing", () => {
  it("更新冲刺的名称、目标、状态与起止日期", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", {
      projectId: project.id,
      name: "Sprint 1",
      goal: "完成登录",
      startDate: "2026-01-01",
      endDate: "2026-01-14",
    });
    expect(sprint).toMatchObject({ name: "Sprint 1", goal: "完成登录", status: "planned", startDate: "2026-01-01", endDate: "2026-01-14" });

    const patched = await service.updateSprint(["user_a"], sprint.id, {
      name: "Sprint 1 改名",
      goal: "完成登录与鉴权",
      status: "active",
      startDate: "2026-01-02",
      endDate: "2026-01-15",
    });
    expect(patched).toMatchObject({
      name: "Sprint 1 改名",
      goal: "完成登录与鉴权",
      status: "active",
      startDate: "2026-01-02",
      endDate: "2026-01-15",
    });
  });

  it("目标传空串清空为 \"\"、日期传 null 清空为 null", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", {
      projectId: project.id,
      name: "Sprint 1",
      goal: "完成登录",
      startDate: "2026-01-01",
      endDate: "2026-01-14",
    });

    const cleared = await service.updateSprint(["user_a"], sprint.id, { goal: "", startDate: null, endDate: null });
    expect(cleared).toMatchObject({ goal: "", startDate: null, endDate: null });
  });

  it("省略字段保留原值，只有显式传入的字段被改写", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1", goal: "完成登录", startDate: "2026-01-01" });

    const patched = await service.updateSprint(["user_a"], sprint.id, { status: "closed" });
    expect(patched).toMatchObject({ name: "Sprint 1", goal: "完成登录", startDate: "2026-01-01", status: "closed" });
  });

  it("非 owner 编辑冲刺返回 SPRINT_NOT_FOUND，管理员可以编辑他人冲刺", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });

    await expect(service.updateSprint(["user_b"], sprint.id, { name: "越权改名" })).rejects.toMatchObject({ code: "SPRINT_NOT_FOUND", status: 404 });
    // 管理员可编辑他人冲刺
    expect((await service.updateSprint(["user_b"], sprint.id, { name: "管理员改名" }, true)).name).toBe("管理员改名");
  });
});

describe("AgileService story editing", () => {
  it("编辑故事的标题、描述、验收标准、完成定义与优先级", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", {
      projectId: project.id,
      title: "限流",
      description: "给 session 加限流",
      acceptanceCriteria: ["返回 429"],
      definitionOfDone: ["测试通过"],
      priority: "should",
    });

    const patched = await service.updateStory(["user_a"], story.id, {
      title: "登录限流",
      description: "给登录接口加限流",
      acceptanceCriteria: ["返回 429", "可重试"],
      definitionOfDone: ["单测通过", "已上线"],
      priority: "must",
    });
    expect(patched).toMatchObject({ title: "登录限流", description: "给登录接口加限流", priority: "must" });
    expect(patched.acceptanceCriteria).toEqual(["返回 429", "可重试"]);
    expect(patched.definitionOfDone).toEqual(["单测通过", "已上线"]);
  });

  it("编辑估算、并发、预算与开发/评审模型", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "限流" });

    const patched = await service.updateStory(["user_a"], story.id, {
      estimate: 8,
      maxParallel: 3,
      budget: { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 },
      developerModel: { provider: "deepseek", model: "flash" },
      reviewerModel: { provider: "openai-proxy", model: "gpt" },
    });
    expect(patched).toMatchObject({ estimate: 8, maxParallel: 3 });
    expect(patched.budget).toEqual({ maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 });
    expect(patched.developerModel).toEqual({ provider: "deepseek", model: "flash" });
    expect(patched.reviewerModel).toEqual({ provider: "openai-proxy", model: "gpt" });
  });

  it("把故事放入冲刺，sprintId: null 等于放回 backlog", async () => {
    const { service, project } = await seed();
    const sprint = await service.createSprint("user_a", { projectId: project.id, name: "Sprint 1" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });

    expect((await service.updateStory(["user_a"], story.id, { sprintId: sprint.id })).sprintId).toBe(sprint.id);
    expect((await service.updateStory(["user_a"], story.id, { sprintId: null })).sprintId).toBeNull();
  });

  it("工作区可编辑并可用 null 清空", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });

    expect((await service.updateStory(["user_a"], story.id, { workspaceId: "ws_1" })).workspaceId).toBe("ws_1");
    expect((await service.updateStory(["user_a"], story.id, { workspaceId: null })).workspaceId).toBeNull();
  });

  it("描述传空串清空为 \"\"、验收标准与完成定义传空数组清空为 []", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", {
      projectId: project.id,
      title: "限流",
      description: "给 session 加限流",
      acceptanceCriteria: ["返回 429"],
      definitionOfDone: ["测试通过"],
    });

    const cleared = await service.updateStory(["user_a"], story.id, { description: "", acceptanceCriteria: [], definitionOfDone: [] });
    expect(cleared.description).toBe("");
    expect(cleared.acceptanceCriteria).toEqual([]);
    expect(cleared.definitionOfDone).toEqual([]);
  });

  it("估算、并发、预算与开发/评审模型可传 null 清空", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", {
      projectId: project.id,
      title: "限流",
      estimate: 5,
      maxParallel: 2,
      budget: { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 },
      developerModel: { provider: "deepseek", model: "flash" },
      reviewerModel: { provider: "openai-proxy", model: "gpt" },
    });

    const cleared = await service.updateStory(["user_a"], story.id, {
      estimate: null,
      maxParallel: null,
      budget: null,
      developerModel: null,
      reviewerModel: null,
    });
    expect(cleared).toMatchObject({ estimate: null, maxParallel: null, budget: null, developerModel: null, reviewerModel: null });
  });

  it("省略字段保留原值，只有显式传入的字段被改写", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", {
      projectId: project.id,
      title: "原始标题",
      description: "原始描述",
      priority: "must",
      estimate: 5,
    });

    const patched = await service.updateStory(["user_a"], story.id, { title: "新标题" });
    expect(patched).toMatchObject({ title: "新标题", description: "原始描述", priority: "must", estimate: 5 });
  });

  it("每次编辑都刷新 updatedAt 且不改动 createdAt", async () => {
    const db = await createTestDb();
    let clock = "2026-02-01T00:00:00.000Z";
    const service = new AgileService(db, () => clock);
    const project = await service.createProject("user_a", { name: "认证服务", key: "AUTH" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "原始标题" });

    clock = "2026-02-02T00:00:00.000Z";
    const patched = await service.updateStory(["user_a"], story.id, { title: "新标题" });
    expect(patched.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(patched.updatedAt).not.toBe(story.updatedAt);
    expect(patched.createdAt).toBe(story.createdAt);
  });

  it("把故事指派到其它项目的冲刺返回 SPRINT_NOT_FOUND (422)", async () => {
    const { service, project } = await seed();
    const other = await service.createProject("user_a", { name: "支付", key: "PAY" });
    const sprint = await service.createSprint("user_a", { projectId: other.id, name: "Sprint 支付" });
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });

    await expect(service.updateStory(["user_a"], story.id, { sprintId: sprint.id })).rejects.toMatchObject({ code: "SPRINT_NOT_FOUND", status: 422 });
  });

  it("非 owner 编辑故事返回 STORY_NOT_FOUND，管理员可以编辑他人故事", async () => {
    const { service, project } = await seed();
    const story = await service.createStory("user_a", { projectId: project.id, title: "故事" });

    await expect(service.updateStory(["user_b"], story.id, { title: "越权改名" })).rejects.toMatchObject({ code: "STORY_NOT_FOUND", status: 404 });
    // 管理员可编辑他人故事
    expect((await service.updateStory(["user_b"], story.id, { title: "管理员改名" }, true)).title).toBe("管理员改名");
  });
});
