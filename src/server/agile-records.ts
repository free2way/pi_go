import type {
  AgileProject,
  AgileRelease,
  AgileSprint,
  AgileStory,
  ModelTemplate,
  ReleaseDeployRecord,
  ReleaseStatus,
  RunBudget,
  SprintStatus,
  StoryPriority,
  StoryStatus,
} from "../shared/agile.js";
import type { ModelSelection } from "../shared/types.js";

export class AgileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  project_key: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type SprintRow = {
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

export type StoryRow = {
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

export type ReleaseRow = {
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

export type TemplateRow = {
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

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toProject(row: ProjectRow, counts?: { stories: number; sprints: number; releases: number }): AgileProject {
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

export function toSprint(row: SprintRow): AgileSprint {
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

export function toStory(row: StoryRow): AgileStory {
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

export function toRelease(row: ReleaseRow): AgileRelease {
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

export function toTemplate(row: TemplateRow): ModelTemplate {
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
