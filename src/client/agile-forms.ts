import {
  RELEASE_STATUSES,
  SPRINT_STATUSES,
  STORY_PRIORITIES,
  type AgileSprint,
  type AgileStory,
  type ReleaseStatus,
  type RunBudget,
  type SprintStatus,
  type StoryPriority,
} from "../shared/agile";
import type { ModelSelection } from "../shared/types";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";

/**
 * Sprint 4 follow-up: pure builders for the 「模板管理」/「发布管理」 forms.
 *
 * The server already validates every payload with the zod contracts in
 * `server/agile-schemas.ts`; these helpers only catch the obvious mistakes on
 * the client (empty required fields, non-numeric budgets, out-of-range
 * parallelism) so a typo never costs a round-trip. They return data exactly as
 * the `/api/templates` and `/api/releases` routes expect it, which keeps the
 * JSX thin and lets the rules be unit-tested without a DOM.
 *
 * Every message comes from the shared catalog; the optional `locale` parameter
 * (default 中文) keeps the existing tests and call sites meaningful.
 */

/** Parse a `provider::model` picker value, mirroring the run/story forms. */
export function parseModelSelection(value: string): ModelSelection | undefined {
  const [provider, model] = value.split("::");
  return provider && model ? { provider, model } : undefined;
}

export interface TemplateFormValues {
  name: string;
  developerModel: string;
  reviewerModel: string;
  budgetTokens: string;
  budgetCostUsd: string;
  budgetModelCalls: string;
  budgetDurationSeconds: string;
  maxParallel: string;
}

export interface TemplateCreateInput {
  name: string;
  developerModel: ModelSelection;
  reviewerModel: ModelSelection;
  budget?: RunBudget;
  maxParallel?: number | null;
}

export type TemplateInputResult =
  | { ok: true; input: TemplateCreateInput }
  | { ok: false; message: string };

/** Parse an optional budget field: `undefined` = unset, `null` = invalid. */
function parseBudgetField(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Shape the 「新建模板」 form into a `POST /api/templates` body. Budget is sent
 * only when at least one of its four fields is filled, and unset members default
 * to 0 (the schema requires all four numbers together); `maxParallel` is always
 * sent (null = 默认) so editing can clear it.
 */
export function buildTemplateInput(values: TemplateFormValues, locale: Locale = DEFAULT_LOCALE): TemplateInputResult {
  const name = values.name.trim();
  if (!name) return { ok: false, message: t(locale, "agile.error.formTemplateName") };
  if (name.length > 120) return { ok: false, message: t(locale, "agile.error.formTemplateNameLength") };
  const developerModel = parseModelSelection(values.developerModel);
  const reviewerModel = parseModelSelection(values.reviewerModel);
  if (!developerModel) return { ok: false, message: t(locale, "agile.error.formDeveloperModel") };
  if (!reviewerModel) return { ok: false, message: t(locale, "agile.error.formReviewerModel") };

  const fields: Array<{ labelKey: MessageKey; key: keyof RunBudget; raw: string }> = [
    { labelKey: "agile.error.budgetTokens", key: "maxTokens", raw: values.budgetTokens },
    { labelKey: "agile.error.budgetCost", key: "maxCostUsd", raw: values.budgetCostUsd },
    { labelKey: "agile.error.budgetCalls", key: "maxModelCalls", raw: values.budgetModelCalls },
    { labelKey: "agile.error.budgetSeconds", key: "maxDurationSeconds", raw: values.budgetDurationSeconds },
  ];
  const budget: RunBudget = { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 };
  let budgetGiven = false;
  for (const field of fields) {
    const parsed = parseBudgetField(field.raw);
    if (parsed === null) {
      return { ok: false, message: t(locale, "agile.error.formBudgetNumber", { field: t(locale, field.labelKey) }) };
    }
    if (parsed !== undefined) {
      budgetGiven = true;
      budget[field.key] = parsed;
    }
  }

  let maxParallel: number | null = null;
  if (values.maxParallel.trim() !== "") {
    const parsed = Number(values.maxParallel);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) return { ok: false, message: t(locale, "agile.error.formMaxParallel") };
    maxParallel = parsed;
  }

  return { ok: true, input: { name, developerModel, reviewerModel, ...(budgetGiven ? { budget } : {}), maxParallel } };
}

export interface ReleaseFormValues {
  name: string;
  version: string;
  notes: string;
  status: ReleaseStatus;
  storyIds: string[];
}

export interface ReleaseInput {
  name: string;
  version: string;
  notes: string;
  status: ReleaseStatus;
  storyIds: string[];
}

export type ReleaseInputResult =
  | { ok: true; input: ReleaseInput }
  | { ok: false; message: string };

/** Normalize the create/edit body shared by `POST` and `PATCH /api/releases`. */
export function buildReleaseInput(values: ReleaseFormValues, locale: Locale = DEFAULT_LOCALE): ReleaseInputResult {
  const name = values.name.trim();
  const version = values.version.trim();
  if (!name) return { ok: false, message: t(locale, "agile.error.formReleaseName") };
  if (name.length > 120) return { ok: false, message: t(locale, "agile.error.formReleaseNameLength") };
  if (!version) return { ok: false, message: t(locale, "agile.error.formReleaseVersion") };
  if (version.length > 80) return { ok: false, message: t(locale, "agile.error.formReleaseVersionLength") };
  if (values.notes.length > 4_000) return { ok: false, message: t(locale, "agile.error.formReleaseNotesLength") };
  if (!RELEASE_STATUSES.includes(values.status)) return { ok: false, message: t(locale, "agile.error.formReleaseStatus") };
  if (values.storyIds.length > 200) return { ok: false, message: t(locale, "agile.error.formReleaseStories") };
  return {
    ok: true,
    input: { name, version, notes: values.notes.trim(), status: values.status, storyIds: values.storyIds },
  };
}

export interface SprintFormValues {
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  status: SprintStatus;
}

export interface SprintInput {
  name: string;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  status: SprintStatus;
}

export type SprintInputResult =
  | { ok: true; input: SprintInput }
  | { ok: false; message: string };

/**
 * Shape the 「新建冲刺/编辑冲刺」 form into the body shared by `POST /api/sprints`
 * and `PATCH /api/sprints/:id`.
 *
 * The body is always complete (never partial): the form is the source of truth,
 * and the service treats an omitted field as "keep" while `null`/`""` means
 * "clear" (`updateSprint`: goal → `""`, dates → `NULL`). That is what makes
 * clearing a goal or a date in the edit form actually stick.
 *
 * Server-side the contract is only `max(40)` for the dates — no format check —
 * so the client also refuses an end date earlier than the start date.
 */
export function buildSprintInput(values: SprintFormValues, locale: Locale = DEFAULT_LOCALE): SprintInputResult {
  const name = values.name.trim();
  if (!name) return { ok: false, message: t(locale, "agile.error.formSprintName") };
  if (name.length > 120) return { ok: false, message: t(locale, "agile.error.formSprintNameLength") };
  if (values.goal.length > 4_000) return { ok: false, message: t(locale, "agile.error.formSprintGoalLength") };
  const startDate = values.startDate.trim() || null;
  const endDate = values.endDate.trim() || null;
  // `YYYY-MM-DD` compares correctly as a string; anything else is left to the server.
  if (startDate && endDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate < startDate) {
    return { ok: false, message: t(locale, "agile.error.formSprintDates") };
  }
  if (!SPRINT_STATUSES.includes(values.status)) return { ok: false, message: t(locale, "agile.error.formSprintStatus") };
  return { ok: true, input: { name, goal: values.goal.trim(), startDate, endDate, status: values.status } };
}

/** Fill the sprint form from an existing sprint (edit mode). */
export function sprintToFormValues(sprint: AgileSprint): SprintFormValues {
  return {
    name: sprint.name,
    goal: sprint.goal,
    startDate: sprint.startDate ?? "",
    endDate: sprint.endDate ?? "",
    status: sprint.status,
  };
}

/** Estimation points the story form offers — mirrors the zod union in the server contract. */
export const STORY_ESTIMATES = [1, 2, 3, 5, 8, 13] as const;
export type StoryEstimate = (typeof STORY_ESTIMATES)[number];

export interface StoryFormValues {
  title: string;
  description: string;
  /** Raw textarea, one criterion per line. */
  acceptanceCriteria: string;
  /** Raw textarea, one item per line. */
  definitionOfDone: string;
  priority: StoryPriority;
  /** `""` = 未估算. */
  estimate: string;
  /** `""` = 留在待办. */
  sprintId: string;
  /** `""` = 未指定工作区. */
  workspaceId: string;
  /** `provider::model` picker value; `""` = 默认. */
  developerModel: string;
  reviewerModel: string;
  maxParallel: string;
  budgetTokens: string;
  budgetCostUsd: string;
  budgetModelCalls: string;
  budgetDurationSeconds: string;
}

export interface StoryInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  definitionOfDone: string[];
  priority: StoryPriority;
  estimate: StoryEstimate | null;
  sprintId: string | null;
  workspaceId: string | null;
  developerModel: ModelSelection | null;
  reviewerModel: ModelSelection | null;
  maxParallel: number | null;
  budget: RunBudget | null;
}

export type StoryInputResult =
  | { ok: true; input: StoryInput }
  | { ok: false; message: string };

/** Split a textarea into trimmed, non-empty list items (`textList` in the contract). */
function textList(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Shape the 「新建故事/编辑故事」 form into the body shared by `POST /api/stories`
 * and `PATCH /api/stories/:id`.
 *
 * Same "the form is the source of truth" rule as `buildSprintInput`: every field
 * is sent, so emptying one clears it server-side (`description: ""`,
 * `acceptanceCriteria: []`, and `null` for estimate/models/budget/maxParallel/
 * sprintId/workspaceId). `status` is deliberately **not** part of this body — it
 * is driven by the board actions, and a PATCH that carried a stale status could
 * fight the run-derived status the server reconciles on read.
 */
export function buildStoryInput(values: StoryFormValues, locale: Locale = DEFAULT_LOCALE): StoryInputResult {
  const title = values.title.trim();
  if (title.length < 2) return { ok: false, message: t(locale, "agile.error.formStoryTitle") };
  if (title.length > 200) return { ok: false, message: t(locale, "agile.error.formStoryTitleLength") };
  if (values.description.length > 4_000) return { ok: false, message: t(locale, "agile.error.formStoryDescriptionLength") };

  const acceptanceCriteria = textList(values.acceptanceCriteria);
  const definitionOfDone = textList(values.definitionOfDone);
  for (const item of [...acceptanceCriteria, ...definitionOfDone]) {
    if (item.length > 500) return { ok: false, message: t(locale, "agile.error.formStoryListItem") };
  }
  if (acceptanceCriteria.length > 30) return { ok: false, message: t(locale, "agile.error.formStoryCriteria") };
  if (definitionOfDone.length > 30) return { ok: false, message: t(locale, "agile.error.formStoryDod") };
  if (!STORY_PRIORITIES.includes(values.priority)) return { ok: false, message: t(locale, "agile.error.formStoryPriority") };

  let estimate: StoryEstimate | null = null;
  if (values.estimate.trim() !== "") {
    const parsed = Number(values.estimate);
    if (!(STORY_ESTIMATES as readonly number[]).includes(parsed)) return { ok: false, message: t(locale, "agile.error.formStoryEstimate") };
    estimate = parsed as StoryEstimate;
  }

  let maxParallel: number | null = null;
  if (values.maxParallel.trim() !== "") {
    const parsed = Number(values.maxParallel);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) return { ok: false, message: t(locale, "agile.error.formMaxParallel") };
    maxParallel = parsed;
  }

  const budgetFields: Array<{ key: keyof RunBudget; raw: string; integer: boolean }> = [
    { key: "maxTokens", raw: values.budgetTokens, integer: true },
    { key: "maxCostUsd", raw: values.budgetCostUsd, integer: false },
    { key: "maxModelCalls", raw: values.budgetModelCalls, integer: true },
    { key: "maxDurationSeconds", raw: values.budgetDurationSeconds, integer: true },
  ];
  let budget: RunBudget | null = null;
  if (budgetFields.some((field) => field.raw.trim() !== "")) {
    const built: RunBudget = { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 };
    for (const field of budgetFields) {
      const parsed = parseBudgetField(field.raw);
      if (parsed === null || (parsed !== undefined && field.integer && !Number.isInteger(parsed))) {
        return { ok: false, message: t(locale, "agile.error.formBudgetNumber", { field: t(locale, budgetLabelKey(field.key)) }) };
      }
      built[field.key] = parsed ?? 0;
    }
    budget = built;
  }

  return {
    ok: true,
    input: {
      title,
      description: values.description.trim(),
      acceptanceCriteria,
      definitionOfDone,
      priority: values.priority,
      estimate,
      sprintId: values.sprintId.trim() || null,
      workspaceId: values.workspaceId.trim() || null,
      developerModel: parseModelSelection(values.developerModel) ?? null,
      reviewerModel: parseModelSelection(values.reviewerModel) ?? null,
      maxParallel,
      budget,
    },
  };
}

const BUDGET_LABEL_KEYS: Record<keyof RunBudget, MessageKey> = {
  maxTokens: "agile.error.budgetTokens",
  maxCostUsd: "agile.error.budgetCost",
  maxModelCalls: "agile.error.budgetCalls",
  maxDurationSeconds: "agile.error.budgetSeconds",
};

function budgetLabelKey(key: keyof RunBudget): MessageKey {
  return BUDGET_LABEL_KEYS[key];
}

/** Fill the story form from an existing story (edit mode). */
export function storyToFormValues(story: AgileStory): StoryFormValues {
  return {
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria.join("\n"),
    definitionOfDone: story.definitionOfDone.join("\n"),
    priority: story.priority,
    estimate: story.estimate === null ? "" : String(story.estimate),
    sprintId: story.sprintId ?? "",
    workspaceId: story.workspaceId ?? "",
    developerModel: story.developerModel ? `${story.developerModel.provider}::${story.developerModel.model}` : "",
    reviewerModel: story.reviewerModel ? `${story.reviewerModel.provider}::${story.reviewerModel.model}` : "",
    maxParallel: story.maxParallel === null ? "" : String(story.maxParallel),
    budgetTokens: story.budget ? String(story.budget.maxTokens) : "",
    budgetCostUsd: story.budget ? String(story.budget.maxCostUsd) : "",
    budgetModelCalls: story.budget ? String(story.budget.maxModelCalls) : "",
    budgetDurationSeconds: story.budget ? String(story.budget.maxDurationSeconds) : "",
  };
}

/** Codes this helper renders itself; everything else defers to `localizeError`. */
const FORM_ERROR_KEYS: Record<string, MessageKey> = {
  TEMPLATE_NAME_TAKEN: "agile.error.TEMPLATE_NAME_TAKEN",
  TEMPLATE_NOT_FOUND: "agile.error.TEMPLATE_NOT_FOUND",
  RELEASE_NOT_FOUND: "agile.error.RELEASE_NOT_FOUND",
  PROJECT_NOT_FOUND: "agile.error.PROJECT_NOT_FOUND",
};

/**
 * Map an API failure to localized copy. The server's own message is preferred
 * when it carried one (it may name the offending value); the known agile codes
 * only supply a fallback. In particular a 409 `TEMPLATE_NAME_TAKEN` becomes an
 * actionable hint.
 */
export function agileFormErrorMessage(cause: unknown, fallback: string, locale: Locale = DEFAULT_LOCALE): string {
  const error = cause as { code?: string; message?: string } | undefined;
  const key = error?.code ? FORM_ERROR_KEYS[error.code] : undefined;
  if (key) return error?.message || t(locale, key);
  return error?.message || fallback;
}
