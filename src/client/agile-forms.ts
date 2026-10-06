import { RELEASE_STATUSES, type ReleaseStatus, type RunBudget } from "../shared/agile";
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
