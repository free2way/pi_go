import {
  shapeMetrics,
  shapeReleaseRetrospective,
  shapeReleaseSummary,
  type AgileMetricsResponse,
  type MetricEvent,
  type MetricRun,
  type MetricStory,
  type ProjectMetrics,
  type ReleaseIdentity,
  type ReleaseRetrospective,
  type ReleaseSummary,
  type SprintMetrics,
} from "../shared/agile-metrics.js";
import type { Run, RunState } from "../shared/types.js";
import type { ReleaseStatus, StoryStatus } from "../shared/agile.js";
import type { Db } from "./db.js";

/**
 * Read-only projection of the agile board into the Sprint 4 metric payload.
 *
 * Aggregation is deliberately split: the bounded rows (owner's stories, the runs
 * linked to them, and only the two review event types) are fetched in SQL, then
 * every statistic is computed by the pure `shapeMetrics` helper. No endpoint
 * scans all events, and empty scopes return zeros instead of throwing.
 */

export interface MetricsFilter {
  projectId?: string;
  sprintId?: string;
}

type StoryRow = { id: string; title: string; project_id: string; sprint_id: string | null; status: string };
type LinkedRunRow = {
  story_id: string;
  linked_at: string;
  run_id: string;
  state: string | null;
  created_at: string | null;
  updated_at: string | null;
  document_json: string;
};
type EventRow = { run_id: string; type: string; count: number | string };
type SprintRow = { id: string; project_id: string; name: string; status: string };
type ProjectRow = { id: string; name: string; project_key: string };

function placeholders(count: number, startIndex: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + startIndex}`).join(", ");
}

/** Story-scoped WHERE clauses shared by the story/run/event queries. */
function storyScope(ownerKeys: string[], filter: MetricsFilter): { clauses: string[]; params: unknown[] } {
  const params: unknown[] = [...ownerKeys];
  const clauses = [`s.owner_id IN (${placeholders(ownerKeys.length, 1)})`];
  if (filter.projectId) {
    params.push(filter.projectId);
    clauses.push(`s.project_id = $${params.length}`);
  }
  if (filter.sprintId) {
    params.push(filter.sprintId);
    clauses.push(`s.sprint_id = $${params.length}`);
  }
  return { clauses, params };
}

function safeParseRun(row: LinkedRunRow): Run | undefined {
  let parsed: Partial<Run> | undefined;
  try {
    parsed = JSON.parse(row.document_json) as Partial<Run>;
  } catch {
    parsed = undefined;
  }
  if (!parsed && !row.state) return undefined;
  const run: Run = {
    ...(parsed ?? {}),
    id: row.run_id,
    state: ((row.state ?? parsed?.state) as RunState) ?? "queued",
    createdAt: parsed?.createdAt ?? row.created_at ?? new Date(0).toISOString(),
    updatedAt: parsed?.updatedAt ?? row.updated_at ?? new Date(0).toISOString(),
    usage: parsed?.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    findings: parsed?.findings ?? [],
  } as Run;
  return run;
}

export async function readAgileMetrics(
  db: Db,
  ownerKeys: string[],
  filter: MetricsFilter = {},
  now: () => string = () => new Date().toISOString(),
): Promise<AgileMetricsResponse> {
  const generatedAt = now();
  if (ownerKeys.length === 0) return { generatedAt, sprints: [], projects: [] };

  const scope = storyScope(ownerKeys, filter);
  const storyRows = (await db.query(
    `SELECT s.id, s.title, s.project_id, s.sprint_id, s.status FROM agile_stories s
     WHERE ${scope.clauses.join(" AND ")} ORDER BY s.updated_at DESC`,
    scope.params,
  )).rows as unknown as StoryRow[];

  const stories: MetricStory[] = storyRows.map((row) => ({
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    sprintId: row.sprint_id,
    status: row.status as StoryStatus,
  }));
  const storyIds = new Set(stories.map((story) => story.id));

  const runs: MetricRun[] = [];
  if (stories.length > 0) {
    const runRows = (await db.query(
      `SELECT sr.story_id, sr.created_at AS linked_at, r.id AS run_id, r.state,
              r.created_at, r.updated_at, r.document_json
       FROM story_runs sr
       JOIN runs r ON r.id = sr.run_id
       JOIN agile_stories s ON s.id = sr.story_id
       WHERE ${scope.clauses.join(" AND ")}`,
      scope.params,
    )).rows as unknown as LinkedRunRow[];
    for (const row of runRows) {
      if (!storyIds.has(row.story_id)) continue;
      const run = safeParseRun(row);
      if (run) runs.push({ storyId: row.story_id, run, linkedAt: row.linked_at });
    }
  }

  // Only the two review event types metrics consume are read; the outer scope is
  // the owner's linked runs, so this never becomes a full event-table scan.
  const events: MetricEvent[] = [];
  if (stories.length > 0) {
    const eventRows = (await db.query(
      `SELECT e.run_id, e.type, COUNT(*)::int AS count
       FROM run_events e
       JOIN story_runs sr ON sr.run_id = e.run_id
       JOIN agile_stories s ON s.id = sr.story_id
       WHERE e.type IN ('review.changes_requested', 'review.not_converging')
         AND ${scope.clauses.join(" AND ")}
       GROUP BY e.run_id, e.type`,
      scope.params,
    )).rows as unknown as EventRow[];
    for (const row of eventRows) {
      const count = Number(row.count) || 0;
      for (let index = 0; index < count; index += 1) events.push({ runId: row.run_id, type: row.type });
    }
  }

  const sprintParams: unknown[] = [...ownerKeys];
  const sprintClauses = [`owner_id IN (${placeholders(ownerKeys.length, 1)})`];
  if (filter.projectId) {
    sprintParams.push(filter.projectId);
    sprintClauses.push(`project_id = $${sprintParams.length}`);
  }
  if (filter.sprintId) {
    sprintParams.push(filter.sprintId);
    sprintClauses.push(`id = $${sprintParams.length}`);
  }
  const sprintRows = (await db.query(
    `SELECT id, project_id, name, status FROM agile_sprints WHERE ${sprintClauses.join(" AND ")} ORDER BY updated_at DESC`,
    sprintParams,
  )).rows as unknown as SprintRow[];

  const projectParams: unknown[] = [...ownerKeys];
  const projectClauses = [`owner_id IN (${placeholders(ownerKeys.length, 1)})`];
  if (filter.projectId) {
    projectParams.push(filter.projectId);
    projectClauses.push(`id = $${projectParams.length}`);
  }
  const projectRows = (await db.query(
    `SELECT id, name, project_key FROM agile_projects WHERE ${projectClauses.join(" AND ")} ORDER BY updated_at DESC`,
    projectParams,
  )).rows as unknown as ProjectRow[];

  const sprints: SprintMetrics[] = sprintRows.map((row) => ({
    sprintId: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status,
    ...shapeMetrics(
      stories.filter((story) => story.sprintId === row.id),
      runs,
      events,
    ),
  }));

  const projects: ProjectMetrics[] = projectRows.map((row) => ({
    projectId: row.id,
    name: row.name,
    key: row.project_key,
    ...shapeMetrics(
      stories.filter((story) => story.projectId === row.id),
      runs,
      events,
    ),
  }));

  return { generatedAt, sprints, projects };
}

// ---------------------------------------------------------------------------
// Sprint 4 core — release summary / retrospective readers.
//
// Same bounded-row strategy as `readAgileMetrics`, but scoped by release id:
// the release's `story_ids_json` is resolved against the owner's stories, then
// only those stories' linked runs and the two review event types are read. An
// unknown or foreign release resolves to `undefined` so the route can answer a
// 404 without a leak; an empty release still shapes explicit zeros.

type ReleaseRow = {
  id: string;
  project_id: string;
  name: string;
  version: string;
  status: string;
  story_ids_json: string;
};

export interface ReleaseDataset {
  release: ReleaseIdentity;
  stories: MetricStory[];
  runs: MetricRun[];
  events: MetricEvent[];
}

function parseStoryIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export async function readReleaseDataset(db: Db, ownerKeys: string[], releaseId: string): Promise<ReleaseDataset | undefined> {
  if (ownerKeys.length === 0) return undefined;
  const releaseRow = (await db.query(
    `SELECT id, project_id, name, version, status, story_ids_json FROM agile_releases
     WHERE id = $1 AND owner_id IN (${placeholders(ownerKeys.length, 2)})`,
    [releaseId, ...ownerKeys],
  )).rows[0] as unknown as ReleaseRow | undefined;
  if (!releaseRow) return undefined;

  const release: ReleaseIdentity = {
    id: releaseRow.id,
    projectId: releaseRow.project_id,
    name: releaseRow.name,
    version: releaseRow.version,
    status: releaseRow.status as ReleaseStatus,
  };

  // Only story ids that actually belong to the caller are kept, so a stale or
  // forged `story_ids_json` entry can never pull in a foreign story's runs.
  const storyIds = [...new Set(parseStoryIds(releaseRow.story_ids_json))];
  const stories: MetricStory[] = [];
  const runs: MetricRun[] = [];
  const events: MetricEvent[] = [];
  if (storyIds.length === 0) return { release, stories, runs, events };

  const storyRows = (await db.query(
    `SELECT id, title, project_id, sprint_id, status FROM agile_stories
     WHERE id IN (${placeholders(storyIds.length, 1)}) AND owner_id IN (${placeholders(ownerKeys.length, storyIds.length + 1)})`,
    [...storyIds, ...ownerKeys],
  )).rows as unknown as StoryRow[];
  for (const row of storyRows) {
    stories.push({
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      sprintId: row.sprint_id,
      status: row.status as StoryStatus,
    });
  }
  const ownedStoryIds = stories.map((story) => story.id);
  if (ownedStoryIds.length === 0) return { release, stories, runs, events };

  const runRows = (await db.query(
    `SELECT sr.story_id, sr.created_at AS linked_at, r.id AS run_id, r.state,
            r.created_at, r.updated_at, r.document_json
     FROM story_runs sr
     JOIN runs r ON r.id = sr.run_id
     WHERE sr.story_id IN (${placeholders(ownedStoryIds.length, 1)})`,
    ownedStoryIds,
  )).rows as unknown as LinkedRunRow[];
  const ownedStorySet = new Set(ownedStoryIds);
  const runIds: string[] = [];
  for (const row of runRows) {
    if (!ownedStorySet.has(row.story_id)) continue;
    const run = safeParseRun(row);
    if (!run) continue;
    runs.push({ storyId: row.story_id, run, linkedAt: row.linked_at });
    runIds.push(row.run_id);
  }
  if (runIds.length > 0) {
    const eventRows = (await db.query(
      `SELECT e.run_id, e.type, COUNT(*)::int AS count
       FROM run_events e
       WHERE e.run_id IN (${placeholders(runIds.length, 1)})
         AND e.type IN ('review.changes_requested', 'review.not_converging')
       GROUP BY e.run_id, e.type`,
      runIds,
    )).rows as unknown as EventRow[];
    for (const row of eventRows) {
      const count = Number(row.count) || 0;
      for (let index = 0; index < count; index += 1) events.push({ runId: row.run_id, type: row.type });
    }
  }

  return { release, stories, runs, events };
}

/** Owner-scoped release summary, or `undefined` when the release does not exist for the caller. */
export async function readReleaseSummary(
  db: Db,
  ownerKeys: string[],
  releaseId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ReleaseSummary | undefined> {
  const dataset = await readReleaseDataset(db, ownerKeys, releaseId);
  if (!dataset) return undefined;
  return shapeReleaseSummary({ ...dataset, generatedAt: now() });
}

/** Owner-scoped release retrospective, or `undefined` when the release is not visible. */
export async function readReleaseRetrospective(
  db: Db,
  ownerKeys: string[],
  releaseId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ReleaseRetrospective | undefined> {
  const dataset = await readReleaseDataset(db, ownerKeys, releaseId);
  if (!dataset) return undefined;
  return shapeReleaseRetrospective({ ...dataset, generatedAt: now() });
}
