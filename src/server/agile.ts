import {
  deriveStoryStatus,
  latestLinkedRun,
  summarizeStoryRun,
  type AgileProject,
  type AgileRelease,
  type AgileSprint,
  type AgileStory,
  type ModelTemplate,
  type ReleaseDeployRecord,
  type ReleaseDeploySettlementRejection,
  type ReleaseStatus,
  type RunBudget,
  type SprintStatus,
  type StoryDetail,
  type StoryPriority,
  type StoryStatus,
  type StoryRunSummary,
} from "../shared/agile.js";
import type { ModelSelection, Run, RunState } from "../shared/types.js";
import { diffFilePaths } from "../shared/decision-brief.js";
import { releasesStoryBlocks } from "../shared/run-state.js";
import { newId, type Db } from "./db.js";
import { type ReleasePublishStory } from "./release-publish.js";

export class AgileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  project_key: string;
  description: string;
  created_at: string;
  updated_at: string;
};

type SprintRow = {
  id: string;
  project_id: string;
  owner_id: string;
  name: string;
  goal: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type StoryRow = {
  id: string;
  project_id: string;
  owner_id: string;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  priority: string;
  estimate: number | null;
  definition_of_done_json: string;
  developer_model_json: string | null;
  reviewer_model_json: string | null;
  budget_json: string | null;
  max_parallel: number | null;
  sprint_id: string | null;
  workspace_id: string | null;
  status: string;
  blocked_reason: string | null;
  blocked_at: string | null;
  blocked_by: string | null;
  status_before_block: string | null;
  created_at: string;
  updated_at: string;
};

type ReleaseRow = {
  id: string;
  project_id: string;
  owner_id: string;
  name: string;
  version: string;
  notes: string;
  status: string;
  story_ids_json: string;
  released_at: string | null;
  released_by: string | null;
  deploy_json: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateRow = {
  id: string;
  owner_id: string;
  name: string;
  developer_model_json: string;
  reviewer_model_json: string;
  budget_json: string | null;
  max_parallel: number | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toProject(row: ProjectRow, counts?: { stories: number; sprints: number; releases: number }): AgileProject {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    key: row.project_key,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(counts ? { counts } : {}),
  };
}

function toSprint(row: SprintRow): AgileSprint {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    name: row.name,
    goal: row.goal,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status as SprintStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStory(row: StoryRow): AgileStory {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria_json, []),
    priority: row.priority as StoryPriority,
    estimate: row.estimate === null || row.estimate === undefined ? null : Number(row.estimate),
    definitionOfDone: parseJson<string[]>(row.definition_of_done_json, []),
    developerModel: parseJson<ModelSelection | null>(row.developer_model_json, null),
    reviewerModel: parseJson<ModelSelection | null>(row.reviewer_model_json, null),
    budget: parseJson<RunBudget | null>(row.budget_json, null),
    maxParallel: row.max_parallel === null || row.max_parallel === undefined ? null : Number(row.max_parallel),
    status: row.status as StoryStatus,
    sprintId: row.sprint_id,
    workspaceId: row.workspace_id,
    blockedReason: row.blocked_reason ?? null,
    blockedAt: row.blocked_at ?? null,
    blockedBy: row.blocked_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRelease(row: ReleaseRow): AgileRelease {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    name: row.name,
    version: row.version,
    notes: row.notes,
    status: row.status as ReleaseStatus,
    storyIds: parseJson<string[]>(row.story_ids_json, []),
    releasedAt: row.released_at ?? null,
    releasedBy: row.released_by ?? null,
    deploy: parseJson<ReleaseDeployRecord | null>(row.deploy_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTemplate(row: TemplateRow): ModelTemplate {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    developerModel: parseJson<ModelSelection>(row.developer_model_json, { provider: "", model: "" }),
    reviewerModel: parseJson<ModelSelection>(row.reviewer_model_json, { provider: "", model: "" }),
    budget: parseJson<RunBudget | null>(row.budget_json, null),
    maxParallel: row.max_parallel === null || row.max_parallel === undefined ? null : Number(row.max_parallel),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProjectInput {
  name: string;
  key: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
}

export interface CreateStoryInput {
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: StoryPriority;
  estimate?: number | null;
  definitionOfDone?: string[];
  developerModel?: ModelSelection | null;
  reviewerModel?: ModelSelection | null;
  budget?: RunBudget | null;
  maxParallel?: number | null;
  sprintId?: string | null;
  workspaceId?: string | null;
  status?: StoryStatus;
}

export type UpdateStoryInput = Partial<Omit<CreateStoryInput, "projectId">>;

export interface CreateSprintInput {
  projectId: string;
  name: string;
  goal?: string;
  startDate?: string | null;
  endDate?: string | null;
  status?: SprintStatus;
}

export type UpdateSprintInput = Partial<Omit<CreateSprintInput, "projectId">>;

export interface CreateReleaseInput {
  projectId: string;
  name: string;
  version: string;
  notes?: string;
  status?: ReleaseStatus;
  storyIds?: string[];
}

export type UpdateReleaseInput = Partial<Omit<CreateReleaseInput, "projectId">>;

export interface CreateTemplateInput {
  name: string;
  developerModel: ModelSelection;
  reviewerModel: ModelSelection;
  budget?: RunBudget | null;
  maxParallel?: number | null;
}

/**
 * Owner-scoped store for the agile planning model. Every read/write is scoped to
 * the caller's owner keys (admins may read any row, matching the workspace
 * routes); the `Run` records themselves stay owned by the existing run store.
 */
export class AgileService {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  // ------------------------------------------------------------------ projects

  async listProjects(ownerKeys: string[]): Promise<AgileProject[]> {
    if (ownerKeys.length === 0) return [];
    const rows = (await this.db.query(
      `SELECT * FROM agile_projects WHERE owner_id IN (${placeholders(ownerKeys, 1)}) ORDER BY updated_at DESC`,
      ownerKeys,
    )).rows as unknown as ProjectRow[];
    if (rows.length === 0) return [];
    // 子对象计数单独查（三张表各一次分组），在 JS 里合并。相关子查询在 pg-mem（测试库）里
    // 不被支持，而这种写法在 pg-mem 与真 PostgreSQL 上行为一致。
    const counts = await this.countProjectChildren(rows.map((row) => row.id));
    return rows.map((row) => toProject(row, counts.get(row.id)));
  }

  /** `project_id → {stories, sprints, releases}`；只查给定的项目集合。 */
  private async countProjectChildren(ids: string[]): Promise<Map<string, { stories: number; sprints: number; releases: number }>> {
    const list = placeholders(ids, 1);
    const [stories, sprints, releases] = await Promise.all([
      this.db.query(`SELECT project_id, COUNT(*)::int AS count FROM agile_stories WHERE project_id IN (${list}) GROUP BY project_id`, ids),
      this.db.query(`SELECT project_id, COUNT(*)::int AS count FROM agile_sprints WHERE project_id IN (${list}) GROUP BY project_id`, ids),
      this.db.query(`SELECT project_id, COUNT(*)::int AS count FROM agile_releases WHERE project_id IN (${list}) GROUP BY project_id`, ids),
    ]);
    const map = new Map<string, { stories: number; sprints: number; releases: number }>();
    const apply = (rows: Array<{ project_id: string; count: number }> | unknown[], key: "stories" | "sprints" | "releases") => {
      for (const row of rows as Array<{ project_id: string; count: number }>) {
        const entry = map.get(row.project_id) ?? { stories: 0, sprints: 0, releases: 0 };
        entry[key] = Number(row.count) || 0;
        map.set(row.project_id, entry);
      }
    };
    apply(stories.rows, "stories");
    apply(sprints.rows, "sprints");
    apply(releases.rows, "releases");
    for (const id of ids) if (!map.has(id)) map.set(id, { stories: 0, sprints: 0, releases: 0 });
    return map;
  }

  async getProject(ownerKeys: string[], id: string, isAdmin = false): Promise<AgileProject> {
    return toProject(await this.requireProject(ownerKeys, id, isAdmin));
  }

  async createProject(ownerId: string, input: CreateProjectInput): Promise<AgileProject> {
    const key = input.key.trim().toUpperCase();
    const now = this.now();
    const existing = await this.db.query("SELECT id FROM agile_projects WHERE owner_id = $1 AND project_key = $2", [ownerId, key]);
    if (existing.rows.length > 0) throw new AgileError("PROJECT_KEY_TAKEN", `项目前缀 ${key} 已存在`, 409);
    const id = newId("proj");
    await this.db.query(
      `INSERT INTO agile_projects (id, owner_id, name, project_key, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ownerId, input.name.trim(), key, input.description?.trim() ?? "", now, now],
    );
    return this.getProject([ownerId], id, true);
  }

  async updateProject(ownerKeys: string[], id: string, patch: UpdateProjectInput, isAdmin = false): Promise<AgileProject> {
    await this.requireProject(ownerKeys, id, isAdmin);
    if (patch.name !== undefined) await this.db.query("UPDATE agile_projects SET name = $1 WHERE id = $2", [patch.name.trim(), id]);
    if (patch.description !== undefined) await this.db.query("UPDATE agile_projects SET description = $1 WHERE id = $2", [patch.description.trim(), id]);
    await this.db.query("UPDATE agile_projects SET updated_at = $1 WHERE id = $2", [this.now(), id]);
    return this.getProject(ownerKeys, id, isAdmin);
  }

  /** Cascades to the project's stories/sprints/releases and their run links. */
  async deleteProject(ownerKeys: string[], id: string, isAdmin = false): Promise<void> {
    await this.requireProject(ownerKeys, id, isAdmin);
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM story_runs WHERE story_id IN (SELECT id FROM agile_stories WHERE project_id = $1)", [id]);
      await tx.query("DELETE FROM agile_stories WHERE project_id = $1", [id]);
      await tx.query("DELETE FROM agile_sprints WHERE project_id = $1", [id]);
      await tx.query("DELETE FROM agile_releases WHERE project_id = $1", [id]);
      await tx.query("DELETE FROM agile_projects WHERE id = $1", [id]);
    });
  }

  private async requireProject(ownerKeys: string[], id: string, isAdmin = false): Promise<ProjectRow> {
    const row = (isAdmin || ownerKeys.length === 0
      ? (await this.db.query("SELECT * FROM agile_projects WHERE id = $1", [id])).rows[0]
      : (await this.db.query(
        `SELECT * FROM agile_projects WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys, 2)})`,
        [id, ...ownerKeys],
      )).rows[0]) as unknown as ProjectRow | undefined;
    if (!row) throw new AgileError("PROJECT_NOT_FOUND", "项目不存在", 404);
    return row;
  }

  // ------------------------------------------------------------------- stories

  async listStories(
    ownerKeys: string[],
    filter: { projectId?: string; sprintId?: string | null; status?: StoryStatus } = {},
  ): Promise<AgileStory[]> {
    if (ownerKeys.length === 0) return [];
    const params: unknown[] = [...ownerKeys];
    const clauses = [`owner_id IN (${placeholders(ownerKeys, 1)})`];
    if (filter.projectId) {
      params.push(filter.projectId);
      clauses.push(`project_id = $${params.length}`);
    }
    if (filter.sprintId !== undefined) {
      if (filter.sprintId === null) clauses.push("sprint_id IS NULL");
      else {
        params.push(filter.sprintId);
        clauses.push(`sprint_id = $${params.length}`);
      }
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const rows = (await this.db.query(
      `SELECT * FROM agile_stories WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`,
      params,
    )).rows as unknown as StoryRow[];
    return Promise.all(rows.map((row) => this.withEffectiveBlockReason(toStory(row))));
  }

  /** Reads the story, reconciling its status from its latest linked run first. */
  async getStory(ownerKeys: string[], id: string, isAdmin = false): Promise<StoryDetail> {
    await this.requireStory(ownerKeys, id, isAdmin);
    await this.reconcileStory(id);
    const row = (await this.db.query("SELECT * FROM agile_stories WHERE id = $1", [id])).rows[0] as unknown as StoryRow;
    const story = await this.withEffectiveBlockReason(toStory(row));
    return { ...story, runs: await this.listStoryRuns(id) };
  }

  /**
   * Effective block reason shown on the board/detail: a manual block keeps its
   * stored reason, a run-derived block (needs_human/failed/cancelled) falls back
   * to the latest run's summary. The stored `blocked_reason` column always stays
   * manual-only — this only decorates the read model.
   */
  private async withEffectiveBlockReason(story: AgileStory): Promise<AgileStory> {
    if (story.status !== "blocked" || story.blockedReason) return story;
    const latest = latestLinkedRun(await this.listStoryRunsDetailed(story.id));
    const derived = deriveStoryStatus(latest?.run);
    return derived?.reason ? { ...story, blockedReason: derived.reason } : story;
  }

  async createStory(ownerId: string, input: CreateStoryInput): Promise<AgileStory> {
    const project = await this.requireProject([ownerId], input.projectId, true);
    await this.requireSprintOfProject(input.sprintId ?? null, project.id);
    const now = this.now();
    const id = newId("story");
    await this.db.query(
      `INSERT INTO agile_stories (
         id, project_id, owner_id, title, description, acceptance_criteria_json, priority, estimate,
         definition_of_done_json, developer_model_json, reviewer_model_json, budget_json, max_parallel,
         sprint_id, workspace_id, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id, project.id, ownerId, input.title.trim(), input.description?.trim() ?? "",
        JSON.stringify(input.acceptanceCriteria ?? []), input.priority ?? "should", input.estimate ?? null,
        JSON.stringify(input.definitionOfDone ?? []),
        input.developerModel ? JSON.stringify(input.developerModel) : null,
        input.reviewerModel ? JSON.stringify(input.reviewerModel) : null,
        input.budget ? JSON.stringify(input.budget) : null,
        input.maxParallel ?? null,
        input.sprintId ?? null, input.workspaceId ?? null, input.status ?? "backlog", now, now,
      ],
    );
    return toStory((await this.db.query("SELECT * FROM agile_stories WHERE id = $1", [id])).rows[0] as unknown as StoryRow);
  }

  async updateStory(ownerKeys: string[], id: string, patch: UpdateStoryInput, isAdmin = false): Promise<AgileStory> {
    const existing = await this.requireStory(ownerKeys, id, isAdmin);
    if (patch.sprintId !== undefined) await this.requireSprintOfProject(patch.sprintId, existing.project_id);
    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.title !== undefined) set("title", patch.title.trim());
    if (patch.description !== undefined) set("description", patch.description.trim());
    if (patch.acceptanceCriteria !== undefined) set("acceptance_criteria_json", JSON.stringify(patch.acceptanceCriteria));
    if (patch.priority !== undefined) set("priority", patch.priority);
    if (patch.estimate !== undefined) set("estimate", patch.estimate);
    if (patch.definitionOfDone !== undefined) set("definition_of_done_json", JSON.stringify(patch.definitionOfDone));
    if (patch.developerModel !== undefined) set("developer_model_json", patch.developerModel ? JSON.stringify(patch.developerModel) : null);
    if (patch.reviewerModel !== undefined) set("reviewer_model_json", patch.reviewerModel ? JSON.stringify(patch.reviewerModel) : null);
    if (patch.budget !== undefined) set("budget_json", patch.budget ? JSON.stringify(patch.budget) : null);
    if (patch.maxParallel !== undefined) set("max_parallel", patch.maxParallel);
    if (patch.sprintId !== undefined) set("sprint_id", patch.sprintId);
    if (patch.workspaceId !== undefined) set("workspace_id", patch.workspaceId);
    if (patch.status !== undefined) set("status", patch.status);
    set("updated_at", this.now());
    params.push(id);
    await this.db.query(`UPDATE agile_stories SET ${assignments.join(", ")} WHERE id = $${params.length}`, params);
    return toStory((await this.db.query("SELECT * FROM agile_stories WHERE id = $1", [id])).rows[0] as unknown as StoryRow);
  }

  async deleteStory(ownerKeys: string[], id: string, isAdmin = false): Promise<void> {
    await this.requireStory(ownerKeys, id, isAdmin);
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM story_runs WHERE story_id = $1", [id]);
      await tx.query("DELETE FROM agile_stories WHERE id = $1", [id]);
    });
  }

  private async requireStory(ownerKeys: string[], id: string, isAdmin = false): Promise<StoryRow> {
    const row = (isAdmin || ownerKeys.length === 0
      ? (await this.db.query("SELECT * FROM agile_stories WHERE id = $1", [id])).rows[0]
      : (await this.db.query(
        `SELECT * FROM agile_stories WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys, 2)})`,
        [id, ...ownerKeys],
      )).rows[0]) as unknown as StoryRow | undefined;
    if (!row) throw new AgileError("STORY_NOT_FOUND", "用户故事不存在", 404);
    return row;
  }

  private async requireSprintOfProject(sprintId: string | null, projectId: string): Promise<void> {
    if (!sprintId) return;
    const row = (await this.db.query("SELECT project_id FROM agile_sprints WHERE id = $1", [sprintId])).rows[0] as { project_id: string } | undefined;
    if (!row || row.project_id !== projectId) throw new AgileError("SPRINT_NOT_FOUND", "冲刺不存在或不属于该项目", 422);
  }

  // -------------------------------------------------------------- story ↔ runs

  async linkRun(storyId: string, runId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO story_runs (story_id, run_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (story_id, run_id) DO NOTHING`,
      [storyId, runId, this.now()],
    );
  }

  async listStoryRuns(storyId: string): Promise<StoryRunSummary[]> {
    const rows = (await this.db.query(
      `SELECT sr.created_at AS linked_at, r.document_json
       FROM story_runs sr JOIN runs r ON r.id = sr.run_id
       WHERE sr.story_id = $1
       ORDER BY sr.created_at DESC`,
      [storyId],
    )).rows as unknown as Array<{ linked_at: string; document_json: string }>;
    return rows.map((row) => summarizeStoryRun(JSON.parse(row.document_json) as Run, row.linked_at));
  }

  async listStoryRunsDetailed(storyId: string): Promise<Array<{ run: Run; linkedAt: string }>> {
    const rows = (await this.db.query(
      `SELECT sr.created_at AS linked_at, r.document_json
       FROM story_runs sr JOIN runs r ON r.id = sr.run_id
       WHERE sr.story_id = $1`,
      [storyId],
    )).rows as unknown as Array<{ linked_at: string; document_json: string }>;
    return rows.map((row) => ({ run: JSON.parse(row.document_json) as Run, linkedAt: row.linked_at }));
  }

  /**
   * Write-back used by the story read path: derive the status from the latest
   * linked run and persist it when it changed. Pure derivation lives in
   * `shared/agile.ts`; this method is only the persistence side effect.
   */
  async reconcileStory(storyId: string): Promise<{ status: StoryStatus; changed: boolean } | undefined> {
    const row = (await this.db.query("SELECT status, blocked_reason FROM agile_stories WHERE id = $1", [storyId])).rows[0] as { status: string; blocked_reason: string | null } | undefined;
    if (!row) return undefined;
    const latest = latestLinkedRun(await this.listStoryRunsDetailed(storyId));
    const derived = deriveStoryStatus(latest?.run, { blockedReason: row.blocked_reason });
    if (!derived) return { status: row.status as StoryStatus, changed: false };
    const changed = derived.status !== row.status;
    if (changed) {
      await this.db.query("UPDATE agile_stories SET status = $1, updated_at = $2 WHERE id = $3", [derived.status, this.now(), storyId]);
    }
    return { status: derived.status, changed };
  }

  /**
   * Write-back invoked from the run update paths. A run may be linked to several
   * stories; each derived status is persisted (never an owner-scoped read here —
   * the caller already authorized the run mutation).
   */
  async reconcileRun(runId: string): Promise<StoryStatus[]> {
    const rows = (await this.db.query("SELECT story_id FROM story_runs WHERE run_id = $1", [runId])).rows as Array<{ story_id: string }>;
    const statuses: StoryStatus[] = [];
    for (const row of rows) {
      const result = await this.reconcileStory(row.story_id);
      if (result) statuses.push(result.status);
    }
    return statuses;
  }

  /** Marks a story in progress right after a run was linked to it. */
  async markStoryInProgress(storyId: string): Promise<void> {
    await this.db.query("UPDATE agile_stories SET status = 'in_progress', updated_at = $1 WHERE id = $2", [this.now(), storyId]);
  }

  // -------------------------------------------------------- manual blocking

  /**
   * Manual Kanban block. Overrides the derived in-progress/review status until
   * unblocked; a delivered (`done`) story cannot be blocked. The pre-block
   * planning status is remembered so unblocking restores it when no run exists.
   */
  async blockStory(ownerKeys: string[], id: string, reason: string, blockedBy: string, isAdmin = false): Promise<StoryDetail> {
    const existing = await this.requireStory(ownerKeys, id, isAdmin);
    if (existing.status === "done") throw new AgileError("STORY_DONE", "已完成的故事不能标记阻塞", 409);
    const now = this.now();
    const baseline = existing.status !== "blocked" ? existing.status : existing.status_before_block;
    await this.db.query(
      `UPDATE agile_stories SET blocked_reason = $1, blocked_at = $2, blocked_by = $3, status_before_block = $4, status = 'blocked', updated_at = $5
       WHERE id = $6`,
      [reason.trim(), now, blockedBy, baseline, now, id],
    );
    return this.getStory(ownerKeys, id, isAdmin);
  }

  /**
   * Clears a manual block. Refuses while the linked run still *holds* the block
   * (`needs_human`) — those must be resolved on the run, so the caller gets 409
   * `BLOCKED_BY_RUN` naming the run. A terminal run (completed/failed/cancelled)
   * never holds a block, so the unblock succeeds and the status is re-derived
   * from the run, falling back to the remembered pre-block status.
   */
  async unblockStory(ownerKeys: string[], id: string, isAdmin = false): Promise<StoryDetail> {
    const existing = await this.requireStory(ownerKeys, id, isAdmin);
    const latest = latestLinkedRun(await this.listStoryRunsDetailed(id));
    // Defense-in-depth: a terminal run is final, so it can no longer hold the
    // block — release instead of 409 even if the story row still says blocked.
    if (latest && !releasesStoryBlocks(latest.run.state)) {
      const blocker = deriveStoryStatus(latest.run);
      if (blocker?.status === "blocked") {
        throw new AgileError(
          "BLOCKED_BY_RUN",
          `该故事仍被运行 ${latest.run.id} 阻塞（${blocker.reason ?? "需要人工处理"}）；请先处理该运行`,
          409,
        );
      }
    }
    if (!existing.blocked_reason && existing.status !== "blocked") return this.getStory(ownerKeys, id, isAdmin);
    const derived = deriveStoryStatus(latest?.run);
    const restored = derived?.status ?? (existing.status_before_block as StoryStatus | null) ?? "backlog";
    await this.db.query(
      `UPDATE agile_stories SET blocked_reason = NULL, blocked_at = NULL, blocked_by = NULL, status_before_block = NULL, status = $1, updated_at = $2
       WHERE id = $3`,
      [restored, this.now(), id],
    );
    return this.getStory(ownerKeys, id, isAdmin);
  }

  /**
   * Explicit operator reopen (Kanban): a story whose latest linked run is a
   * terminal `failed`/`cancelled` run goes back to `ready` so it can be
   * submitted again, and the caller records an audit event with the returned
   * `runId` (see `POST /api/stories/:id/reopen`, docs/19).
   *
   * Refusals, each 409 with an explicit code:
   * - a manual block (`blocked_reason`) is a human decision and is never
   *   reopened silently → `BLOCKED_BY_MANUAL`;
   * - a run still holding the story (live, or `needs_human` → derived blocked)
   *   → `BLOCKED_BY_RUN` naming the run id;
   * - a `completed` run already delivered → `STORY_NOT_REOPENABLE`.
   *
   * `deriveStoryStatus` already returns `ready` for a terminal failed/cancelled
   * run, so this is idempotent and never clobbers run history; the explicit
   * action exists for auditability and for the guard messages above.
   */
  async reopenStory(
    ownerKeys: string[],
    id: string,
    isAdmin = false,
  ): Promise<{ story: StoryDetail; runId: string | null; previousStatus: StoryStatus }> {
    const existing = await this.requireStory(ownerKeys, id, isAdmin);
    const previousStatus = existing.status as StoryStatus;
    const latest = latestLinkedRun(await this.listStoryRunsDetailed(id));
    if (existing.blocked_reason) {
      throw new AgileError(
        "BLOCKED_BY_MANUAL",
        `该故事处于人工阻塞（${existing.blocked_reason}），请先解除阻塞再重新打开`,
        409,
      );
    }
    if (latest) {
      const blocker = deriveStoryStatus(latest.run);
      if (blocker?.status === "blocked") {
        throw new AgileError(
          "BLOCKED_BY_RUN",
          `该故事仍被运行 ${latest.run.id} 阻塞（${blocker.reason ?? "需要人工处理"}）；请先处理该运行`,
          409,
        );
      }
      if (!releasesStoryBlocks(latest.run.state)) {
        throw new AgileError("BLOCKED_BY_RUN", `该故事的最新运行 ${latest.run.id} 仍在执行中，请先等待或取消该运行`, 409);
      }
      if (latest.run.state === "completed") {
        throw new AgileError("STORY_NOT_REOPENABLE", `该故事的最新运行 ${latest.run.id} 已完成，请先验收或退回，而不是重新打开`, 409);
      }
    }
    await this.db.query("UPDATE agile_stories SET status = 'ready', updated_at = $1 WHERE id = $2", [this.now(), id]);
    return { story: await this.getStory(ownerKeys, id, isAdmin), runId: latest?.run.id ?? null, previousStatus };
  }

  /**
   * Automatic release of the run-level story blocks held by a run that just
   * reached a terminal state (completed/failed/cancelled). Only stories for which
   * this run is the *latest* linked run and that carry no manual reason
   * (`blocked_reason`) are released: a manual block is a human decision and is
   * left untouched. Restores the pre-block status (derived from the run, else the
   * stored `status_before_block`), clears the block fields and returns the
   * released story ids so the caller can record why the block was lifted.
   *
   * Pure derivation makes `deriveStoryStatus` non-blocking for these states, so
   * the read-path `reconcileStory` heals an already-stuck story too; this method
   * additionally yields the ids and runs before reconcile in the mutation paths.
   */
  async releaseStoryBlocksForTerminalRun(runId: string, state: RunState): Promise<string[]> {
    if (!releasesStoryBlocks(state)) return [];
    const links = (await this.db.query("SELECT story_id FROM story_runs WHERE run_id = $1", [runId])).rows as Array<{ story_id: string }>;
    const released: string[] = [];
    for (const link of links) {
      const row = (await this.db.query(
        "SELECT status, blocked_reason, status_before_block FROM agile_stories WHERE id = $1",
        [link.story_id],
      )).rows[0] as { status: string; blocked_reason: string | null; status_before_block: string | null } | undefined;
      // Manual blocks stay; only a run-level block (status blocked, no manual reason) is released.
      if (!row || row.status !== "blocked" || row.blocked_reason) continue;
      const latest = latestLinkedRun(await this.listStoryRunsDetailed(link.story_id));
      // A different, still-blocking run may be the story's actual blocker.
      if (!latest || latest.run.id !== runId) continue;
      const restored = deriveStoryStatus(latest.run)?.status ?? (row.status_before_block as StoryStatus | null) ?? "backlog";
      await this.db.query(
        `UPDATE agile_stories SET blocked_reason = NULL, blocked_at = NULL, blocked_by = NULL, status_before_block = NULL, status = $1, updated_at = $2
         WHERE id = $3`,
        [restored, this.now(), link.story_id],
      );
      released.push(link.story_id);
    }
    return released;
  }

  // ------------------------------------------------------------------- sprints

  async listSprints(ownerKeys: string[], projectId?: string): Promise<AgileSprint[]> {
    if (ownerKeys.length === 0) return [];
    const params: unknown[] = [...ownerKeys];
    let clause = `owner_id IN (${placeholders(ownerKeys, 1)})`;
    if (projectId) {
      params.push(projectId);
      clause += ` AND project_id = $${params.length}`;
    }
    const rows = (await this.db.query(
      `SELECT * FROM agile_sprints WHERE ${clause} ORDER BY updated_at DESC`,
      params,
    )).rows as unknown as SprintRow[];
    return rows.map(toSprint);
  }

  async createSprint(ownerId: string, input: CreateSprintInput): Promise<AgileSprint> {
    const project = await this.requireProject([ownerId], input.projectId, true);
    const now = this.now();
    const id = newId("sprint");
    await this.db.query(
      `INSERT INTO agile_sprints (id, project_id, owner_id, name, goal, start_date, end_date, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, project.id, ownerId, input.name.trim(), input.goal?.trim() ?? "", input.startDate ?? null, input.endDate ?? null, input.status ?? "planned", now, now],
    );
    return toSprint((await this.db.query("SELECT * FROM agile_sprints WHERE id = $1", [id])).rows[0] as unknown as SprintRow);
  }

  async updateSprint(ownerKeys: string[], id: string, patch: UpdateSprintInput, isAdmin = false): Promise<AgileSprint> {
    await this.requireSprint(ownerKeys, id, isAdmin);
    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) set("name", patch.name.trim());
    if (patch.goal !== undefined) set("goal", patch.goal.trim());
    if (patch.startDate !== undefined) set("start_date", patch.startDate);
    if (patch.endDate !== undefined) set("end_date", patch.endDate);
    if (patch.status !== undefined) set("status", patch.status);
    set("updated_at", this.now());
    params.push(id);
    await this.db.query(`UPDATE agile_sprints SET ${assignments.join(", ")} WHERE id = $${params.length}`, params);
    return toSprint((await this.db.query("SELECT * FROM agile_sprints WHERE id = $1", [id])).rows[0] as unknown as SprintRow);
  }

  /** Deleting a sprint returns its stories to the backlog instead of deleting them. */
  async deleteSprint(ownerKeys: string[], id: string, isAdmin = false): Promise<void> {
    await this.requireSprint(ownerKeys, id, isAdmin);
    await this.db.withTransaction(async (tx) => {
      await tx.query("UPDATE agile_stories SET sprint_id = NULL WHERE sprint_id = $1", [id]);
      await tx.query("DELETE FROM agile_sprints WHERE id = $1", [id]);
    });
  }

  private async requireSprint(ownerKeys: string[], id: string, isAdmin = false): Promise<SprintRow> {
    const row = (isAdmin || ownerKeys.length === 0
      ? (await this.db.query("SELECT * FROM agile_sprints WHERE id = $1", [id])).rows[0]
      : (await this.db.query(
        `SELECT * FROM agile_sprints WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys, 2)})`,
        [id, ...ownerKeys],
      )).rows[0]) as unknown as SprintRow | undefined;
    if (!row) throw new AgileError("SPRINT_NOT_FOUND", "冲刺不存在", 404);
    return row;
  }

  // ------------------------------------------------------------------ releases

  async listReleases(ownerKeys: string[], projectId?: string): Promise<AgileRelease[]> {
    if (ownerKeys.length === 0) return [];
    const params: unknown[] = [...ownerKeys];
    let clause = `owner_id IN (${placeholders(ownerKeys, 1)})`;
    if (projectId) {
      params.push(projectId);
      clause += ` AND project_id = $${params.length}`;
    }
    const rows = (await this.db.query(
      `SELECT * FROM agile_releases WHERE ${clause} ORDER BY updated_at DESC`,
      params,
    )).rows as unknown as ReleaseRow[];
    return rows.map(toRelease);
  }

  async createRelease(ownerId: string, input: CreateReleaseInput): Promise<AgileRelease> {
    const project = await this.requireProject([ownerId], input.projectId, true);
    const now = this.now();
    const id = newId("release");
    await this.db.query(
      `INSERT INTO agile_releases (id, project_id, owner_id, name, version, notes, status, story_ids_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, project.id, ownerId, input.name.trim(), input.version.trim(), input.notes?.trim() ?? "", input.status ?? "planned", JSON.stringify(input.storyIds ?? []), now, now],
    );
    return toRelease((await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [id])).rows[0] as unknown as ReleaseRow);
  }

  async updateRelease(ownerKeys: string[], id: string, patch: UpdateReleaseInput, isAdmin = false): Promise<AgileRelease> {
    const existing = await this.requireRelease(ownerKeys, id, isAdmin);
    if (existing.status === "released") throw new AgileError("RELEASE_RELEASED", "已发布的版本不可再编辑", 409);
    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) set("name", patch.name.trim());
    if (patch.version !== undefined) set("version", patch.version.trim());
    if (patch.notes !== undefined) set("notes", patch.notes.trim());
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.storyIds !== undefined) set("story_ids_json", JSON.stringify(patch.storyIds));
    set("updated_at", this.now());
    params.push(id);
    await this.db.query(`UPDATE agile_releases SET ${assignments.join(", ")} WHERE id = $${params.length}`, params);
    return toRelease((await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [id])).rows[0] as unknown as ReleaseRow);
  }

  async deleteRelease(ownerKeys: string[], id: string, isAdmin = false): Promise<void> {
    await this.requireRelease(ownerKeys, id, isAdmin);
    await this.db.query("DELETE FROM agile_releases WHERE id = $1", [id]);
  }

  /** Owner-scoped release read used by the publish route (404 when not visible). */
  async getRelease(ownerKeys: string[], id: string, isAdmin = false): Promise<AgileRelease> {
    return toRelease(await this.requireRelease(ownerKeys, id, isAdmin));
  }

  /**
   * Resolves the release's story ids against the caller's stories, reconciling
   * each to its derived status/reason and carrying the latest linked run's
   * release-readiness data (state, check verdict, findings, merged commit) so
   * `planReleasePublish` can enforce the full precondition set without a second
   * query pass. Foreign/unknown ids are skipped, so a stale id can never pull in
   * another owner's story. An empty result is the `RELEASE_EMPTY` condition the
   * publish guard reports.
   */
  async collectReleaseStories(ownerKeys: string[], release: AgileRelease, isAdmin = false): Promise<ReleasePublishStory[]> {
    const stories: ReleasePublishStory[] = [];
    for (const storyId of [...new Set(release.storyIds)]) {
      let story: StoryDetail;
      try {
        story = await this.getStory(ownerKeys, storyId, isAdmin);
      } catch {
        continue;
      }
      const latest = latestLinkedRun(await this.listStoryRunsDetailed(storyId));
      const run = latest?.run ?? null;
      const criteria = [...story.acceptanceCriteria, ...story.definitionOfDone].map((item) => item.trim()).filter(Boolean);
      stories.push({
        storyId: story.id,
        title: story.title,
        status: story.status,
        ...(story.status === "blocked" && story.blockedReason ? { reason: story.blockedReason } : {}),
        runState: run?.state ?? null,
        runId: run?.id ?? null,
        checkPassed: run?.checkPassed ?? null,
        checks: run?.checks ?? null,
        findings: run?.findings ?? null,
        criteria,
        diffFiles: run ? diffFilePaths(run.diff) : null,
        mergedCommit: run?.merge?.commit ?? null,
      });
    }
    return stories;
  }

  /**
   * Atomically starts one deploy attempt: the UNIQUE idempotency record
   * (`<deliveryId>#<attempt>`) is inserted and the release is written to
   * `released` with the attempt's deploy record in ONE transaction, so
   *   - exactly one of two simultaneous confirms can claim the attempt (the
   *     loser gets `claimed: false` and must not invoke the hook), and
   *   - there is no window where a claim exists without the matching deploy
   *     record (which would otherwise wedge the release).
   *
   * The attempt number comes from the caller's observed state
   * (`planReleaseDeployAttempt`), never from a counter, so concurrent callers
   * compute the same key. A retry uses the next attempt while reusing
   * `deliveryId`, letting the deploy receiver de-duplicate a repeated delivery.
   */
  async startReleaseDeploy(input: {
    releaseId: string;
    deliveryId: string;
    attempt: number;
    releasedBy: string;
    releasedAt: string;
    note?: string;
    deploy: ReleaseDeployRecord;
    stories: ReleasePublishStory[];
  }): Promise<{ claimed: boolean; attempt: number; release: AgileRelease }> {
    const now = this.now();
    const existing = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow | undefined;
    if (!existing) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    const claimed = await this.db.withTransaction(async (tx) => {
      const claimId = newId("reldeploy");
      // pg-mem returns the conflicting row from `DO NOTHING … RETURNING` (real
      // PostgreSQL returns zero rows), so the winner is identified by comparing
      // the stored row id with the id this caller generated.
      await tx.query(
        `INSERT INTO agile_release_deploy_claims (id, release_id, attempt, idempotency_key, delivery_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [claimId, input.releaseId, input.attempt, `${input.deliveryId}#${input.attempt}`, input.deliveryId, now],
      );
      const stored = (await tx.query(
        "SELECT id FROM agile_release_deploy_claims WHERE idempotency_key = $1",
        [`${input.deliveryId}#${input.attempt}`],
      )).rows[0] as { id: string } | undefined;
      if (!stored || stored.id !== claimId) return false;
      await tx.query(
        `UPDATE agile_releases SET status = 'released', released_at = $1, released_by = $2, deploy_json = $3, updated_at = $4 WHERE id = $5`,
        [input.releasedAt, input.releasedBy, JSON.stringify(input.deploy), now, input.releaseId],
      );
      await tx.query(
        `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("relaudit"), input.releaseId, existing.owner_id, "release.published", input.releasedBy, input.note?.trim() || null, "released", JSON.stringify(input.deploy), now],
      );
      return true;
    });
    const release = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow;
    return { claimed, attempt: input.attempt, release: toRelease(release) };
  }

  /**
   * Settles the in-flight deploy of one attempt with the result actually
   * observed (synchronous outcome or asynchronous callback). The match is
   * *exact*: the write only applies when the stored record is still `pending`
   * and its `deliveryId` **and** `attempt` equal the ones carried by the settle
   * input. A wildcard (missing identity) is refused rather than accepted, so a
   * late callback from a previous attempt can never settle a newer one.
   *
   * The write itself is a compare-and-swap on the stored `deploy_json`; a late
   * duplicate writer therefore cannot overwrite a callback that already recorded
   * the final status — it returns `applied: false` with the authoritative release.
   */
  async settleReleaseDeployResult(input: {
    releaseId: string;
    deploy: ReleaseDeployRecord;
    action: "release.deploy_result" | "release.deploy_succeeded" | "release.deploy_failed";
    actorId: string;
    now?: string;
  }): Promise<{ applied: boolean; release: AgileRelease; rejected?: ReleaseDeploySettlementRejection }> {
    const now = input.now ?? this.now();
    const releaseRow = (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow | undefined;
    if (!releaseRow) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    const current = parseJson<ReleaseDeployRecord | null>(releaseRow.deploy_json, null);
    const identityMatches = Boolean(current)
      && input.deploy.deliveryId !== undefined
      && input.deploy.attempt !== undefined
      && current!.deliveryId === input.deploy.deliveryId
      && current!.attempt === input.deploy.attempt;
    if (!identityMatches) {
      return { applied: false, release: toRelease(releaseRow), rejected: "stale_attempt" };
    }
    if (current!.status !== "pending") {
      return { applied: false, release: toRelease(releaseRow), rejected: "not_pending" };
    }
    const applied = await this.db.withTransaction(async (tx) => {
      const row = (await tx.query(
        `UPDATE agile_releases SET deploy_json = $1, updated_at = $2
         WHERE id = $3 AND deploy_json = $4 RETURNING id`,
        [JSON.stringify(input.deploy), now, input.releaseId, releaseRow.deploy_json],
      )).rows[0];
      if (!row) return false;
      await tx.query(
        `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("relaudit"), input.releaseId, releaseRow.owner_id, input.action, input.actorId, null, input.deploy.status, JSON.stringify(input.deploy), now],
      );
      return true;
    });
    const release = toRelease((await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as unknown as ReleaseRow);
    if (applied) return { applied, release };
    // The CAS lost a race. Distinguish "another writer settled this same attempt"
    // (not_pending → idempotent for the caller) from "the attempt changed under
    // us" (stale_attempt → a newer attempt must never be overwritten).
    const stored = release.deploy ?? null;
    const sameIdentity = Boolean(stored) && stored!.deliveryId === input.deploy.deliveryId && stored!.attempt === input.deploy.attempt;
    return { applied, release, rejected: sameIdentity ? "not_pending" : "stale_attempt" };
  }

  /**
   * Append-only audit for a callback that was *rejected* and therefore changed no
   * state (stale/unsolicited attempt). Keeping this separate from
   * `settleReleaseDeployResult` makes the "rejected callbacks are audited but
   * never mutate" property explicit.
   */
  async recordReleaseDeployRejection(input: {
    releaseId: string;
    actorId: string;
    detail: string;
    deploy: ReleaseDeployRecord;
    now?: string;
    action?: string;
  }): Promise<void> {
    const now = input.now ?? this.now();
    const releaseRow = (await this.db.query("SELECT owner_id FROM agile_releases WHERE id = $1", [input.releaseId])).rows[0] as { owner_id: string } | undefined;
    if (!releaseRow) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    await this.db.query(
      `INSERT INTO agile_release_audit (id, release_id, owner_id, action, actor_id, note, status, deploy_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId("relaudit"), input.releaseId, releaseRow.owner_id, input.action ?? "release.deploy_rejected", input.actorId, input.detail, input.deploy.status, JSON.stringify(input.deploy), now],
    );
  }

  /**
   * Bounded verification for asynchronous deploys: a `pending` attempt whose
   * start is older than `timeoutMs` is marked `failed` with the timeout recorded
   * (and an audit row), so it can be explicitly retried instead of hanging
   * forever. Returns the ids of the releases that were expired.
   */
  async expireStaleReleaseDeploys(input: { now?: string; timeoutMs: number }): Promise<string[]> {
    const now = input.now ?? this.now();
    const rows = (await this.db.query("SELECT id, deploy_json FROM agile_releases WHERE deploy_json IS NOT NULL")).rows as unknown as Array<{ id: string; deploy_json: string | null }>;
    const expired: string[] = [];
    for (const row of rows) {
      const deploy = parseJson<ReleaseDeployRecord | null>(row.deploy_json, null);
      if (!deploy || deploy.status !== "pending") continue;
      const startedAt = deploy.startedAt ?? deploy.at;
      const age = Date.parse(now) - Date.parse(startedAt);
      if (!Number.isFinite(age) || age < input.timeoutMs) continue;
      const result = await this.settleReleaseDeployResult({
        releaseId: row.id,
        actorId: "system",
        now,
        action: "release.deploy_failed",
        deploy: {
          ...deploy,
          status: "failed",
          detail: `等待部署系统回调超时（超过 ${Math.round(input.timeoutMs / 60_000)} 分钟未收到结果）`,
          at: now,
          finishedAt: now,
        },
      });
      if (result.applied) expired.push(row.id);
    }
    return expired;
  }

  private async requireRelease(ownerKeys: string[], id: string, isAdmin = false): Promise<ReleaseRow> {
    const row = (isAdmin || ownerKeys.length === 0
      ? (await this.db.query("SELECT * FROM agile_releases WHERE id = $1", [id])).rows[0]
      : (await this.db.query(
        `SELECT * FROM agile_releases WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys, 2)})`,
        [id, ...ownerKeys],
      )).rows[0]) as unknown as ReleaseRow | undefined;
    if (!row) throw new AgileError("RELEASE_NOT_FOUND", "发布不存在", 404);
    return row;
  }

  // ---------------------------------------------------------------- templates

  async listTemplates(ownerKeys: string[]): Promise<ModelTemplate[]> {
    if (ownerKeys.length === 0) return [];
    const rows = (await this.db.query(
      `SELECT * FROM model_templates WHERE owner_id IN (${placeholders(ownerKeys, 1)}) ORDER BY updated_at DESC`,
      ownerKeys,
    )).rows as unknown as TemplateRow[];
    return rows.map(toTemplate);
  }

  /** Owner-scoped create; a duplicate name for the same owner is a 409. */
  async createTemplate(ownerId: string, input: CreateTemplateInput): Promise<ModelTemplate> {
    const name = input.name.trim();
    const existing = await this.db.query("SELECT id FROM model_templates WHERE owner_id = $1 AND name = $2", [ownerId, name]);
    if (existing.rows.length > 0) throw new AgileError("TEMPLATE_NAME_TAKEN", `模板名称 ${name} 已存在`, 409);
    const now = this.now();
    const id = newId("tmpl");
    try {
      await this.db.query(
        `INSERT INTO model_templates (id, owner_id, name, developer_model_json, reviewer_model_json, budget_json, max_parallel, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ownerId, name, JSON.stringify(input.developerModel), JSON.stringify(input.reviewerModel), input.budget ? JSON.stringify(input.budget) : null, input.maxParallel ?? null, now, now],
      );
    } catch (error) {
      // A concurrent create can still hit the unique index; surface it as 409.
      if ((error as { code?: string }).code === "23505") throw new AgileError("TEMPLATE_NAME_TAKEN", `模板名称 ${name} 已存在`, 409);
      throw error;
    }
    return toTemplate((await this.db.query("SELECT * FROM model_templates WHERE id = $1", [id])).rows[0] as unknown as TemplateRow);
  }

  async deleteTemplate(ownerKeys: string[], id: string, isAdmin = false): Promise<void> {
    const row = (isAdmin || ownerKeys.length === 0
      ? (await this.db.query("SELECT id FROM model_templates WHERE id = $1", [id])).rows[0]
      : (await this.db.query(
        `SELECT id FROM model_templates WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys, 2)})`,
        [id, ...ownerKeys],
      )).rows[0]) as { id: string } | undefined;
    if (!row) throw new AgileError("TEMPLATE_NOT_FOUND", "模板不存在", 404);
    await this.db.query("DELETE FROM model_templates WHERE id = $1", [id]);
  }
}

function placeholders(keys: string[], startIndex: number): string {
  return keys.map((_, index) => `$${index + startIndex}`).join(", ");
}
