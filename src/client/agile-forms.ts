import { RELEASE_STATUSES, type ReleaseStatus, type RunBudget } from "../shared/agile";
import type { ModelSelection } from "../shared/types";

/**
 * Sprint 4 follow-up: pure builders for the 「模板管理」/「发布管理」 forms.
 *
 * The server already validates every payload with the zod contracts in
 * `server/agile-schemas.ts`; these helpers only catch the obvious mistakes on
 * the client (empty required fields, non-numeric budgets, out-of-range
 * parallelism) so a typo never costs a round-trip. They return data exactly as
 * the `/api/templates` and `/api/releases` routes expect it, which keeps the
 * JSX thin and lets the rules be unit-tested without a DOM.
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
export function buildTemplateInput(values: TemplateFormValues): TemplateInputResult {
  const name = values.name.trim();
  if (!name) return { ok: false, message: "请填写模板名称" };
  if (name.length > 120) return { ok: false, message: "模板名称最多 120 个字符" };
  const developerModel = parseModelSelection(values.developerModel);
  const reviewerModel = parseModelSelection(values.reviewerModel);
  if (!developerModel) return { ok: false, message: "请选择开发模型" };
  if (!reviewerModel) return { ok: false, message: "请选择审核模型" };

  const fields = [
    { label: "预算 Token", key: "maxTokens" as const, raw: values.budgetTokens },
    { label: "预算成本（$）", key: "maxCostUsd" as const, raw: values.budgetCostUsd },
    { label: "模型调用", key: "maxModelCalls" as const, raw: values.budgetModelCalls },
    { label: "时长（秒）", key: "maxDurationSeconds" as const, raw: values.budgetDurationSeconds },
  ];
  const budget: RunBudget = { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 };
  let budgetGiven = false;
  for (const field of fields) {
    const parsed = parseBudgetField(field.raw);
    if (parsed === null) return { ok: false, message: `${field.label} 必须是非负数字` };
    if (parsed !== undefined) {
      budgetGiven = true;
      budget[field.key] = parsed;
    }
  }

  let maxParallel: number | null = null;
  if (values.maxParallel.trim() !== "") {
    const parsed = Number(values.maxParallel);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) return { ok: false, message: "最大并行需为 1–32 的整数" };
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
export function buildReleaseInput(values: ReleaseFormValues): ReleaseInputResult {
  const name = values.name.trim();
  const version = values.version.trim();
  if (!name) return { ok: false, message: "请填写发布名称" };
  if (name.length > 120) return { ok: false, message: "发布名称最多 120 个字符" };
  if (!version) return { ok: false, message: "请填写版本号" };
  if (version.length > 80) return { ok: false, message: "版本号最多 80 个字符" };
  if (values.notes.length > 4_000) return { ok: false, message: "备注最多 4000 个字符" };
  if (!RELEASE_STATUSES.includes(values.status)) return { ok: false, message: "发布状态无效" };
  if (values.storyIds.length > 200) return { ok: false, message: "单个发布最多关联 200 个故事" };
  return {
    ok: true,
    input: { name, version, notes: values.notes.trim(), status: values.status, storyIds: values.storyIds },
  };
}

/**
 * Map an API failure to Chinese copy. The server's own message is preferred; the
 * known agile codes only supply a fallback when the body carried none. In
 * particular a 409 `TEMPLATE_NAME_TAKEN` becomes an actionable hint.
 */
export function agileFormErrorMessage(cause: unknown, fallback: string): string {
  const error = cause as { code?: string; message?: string } | undefined;
  switch (error?.code) {
    case "TEMPLATE_NAME_TAKEN":
      return error.message || "模板名称已存在，请换一个名称";
    case "TEMPLATE_NOT_FOUND":
      return "模板不存在或已被删除";
    case "RELEASE_NOT_FOUND":
      return "发布不存在或已被删除";
    case "PROJECT_NOT_FOUND":
      return "项目不存在或已被删除";
    default:
      return error?.message || fallback;
  }
}
