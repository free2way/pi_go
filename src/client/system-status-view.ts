/**
 * SYS-01 display mapping for the 「系统状态」 dashboard. Pure helpers only, so
 * unknown/unavailable values are decided in one place and covered by tests.
 * Every label comes from the shared catalog; an optional `locale` parameter
 * (default 中文) keeps the helpers usable from non-React tests.
 */
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";
import type { SystemStatusResponse } from "./api";

export const SYSTEM_UNKNOWN = t("zh", "system.unknown");
export const SYSTEM_UNAVAILABLE = t("zh", "system.unavailable");

const FAILURE_CATEGORIES = ["storage", "budget", "provider", "failure_artifact", "other"] as const;
const JOB_STATES = ["queued", "claimed", "done", "failed", "cancelled"] as const;

/** Formats a millisecond age. `null`/non-finite means genuinely unknown. */
export function formatAge(ms: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return t(locale, "system.unknown");
  const value = Math.max(0, ms);
  if (value < 60_000) return t(locale, "system.age.seconds", { count: Math.round(value / 1000) });
  if (value < 3_600_000) return t(locale, "system.age.minutes", { count: Math.floor(value / 60_000) });
  if (value < 86_400_000) {
    return t(locale, "system.age.hours", {
      hours: Math.floor(value / 3_600_000),
      minutes: Math.floor((value % 3_600_000) / 60_000),
    });
  }
  return t(locale, "system.age.days", {
    days: Math.floor(value / 86_400_000),
    hours: Math.floor((value % 86_400_000) / 3_600_000),
  });
}

/** Compact number for token counts; unknown stays explicit. */
export function formatCompactNumber(value: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t(locale, "system.unknown");
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Estimated cost in USD; unknown stays explicit instead of a fake $0.000. */
export function formatCost(value: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return t(locale, "system.unknown");
  return `$${value.toFixed(3)}`;
}

/** Version text: an empty/missing version is 未知. */
export function formatVersion(value: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  return typeof value === "string" && value.trim() ? value.trim() : t(locale, "system.unknown");
}

export function databaseLabel(status: SystemStatusResponse["infrastructure"]["database"] | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!status) return t(locale, "system.unknown");
  if (status.status === "ok") return t(locale, "system.db.ok");
  return t(locale, "system.unavailable");
}

export function workerLabel(worker: SystemStatusResponse["infrastructure"]["worker"] | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!worker) return t(locale, "system.unknown");
  if (worker.status === "ok") return t(locale, "system.worker.ok");
  if (worker.status === "unreachable") return t(locale, "system.worker.unreachable");
  return t(locale, "system.unknown");
}

export function storageLabel(storage: SystemStatusResponse["infrastructure"]["worker"]["storage"] | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (storage === "ok") return t(locale, "system.storage.ok");
  if (storage === "low") return t(locale, "system.storage.low");
  if (storage === "critical") return t(locale, "system.storage.critical");
  return t(locale, "system.unknown");
}

/** e.g. `活跃 10（排队 2 · 准备 1 · 开发 4 · 检查 1 · 审核 2）` */
export function activeRunsSummary(active: SystemStatusResponse["runs"]["active"] | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!active) return t(locale, "system.unknown");
  return t(locale, "system.activeRuns", {
    total: active.total,
    queued: active.queued,
    preparing: active.preparing,
    developing: active.developing,
    checking: active.checking,
    reviewing: active.reviewing,
  });
}

function failureCategoryKey(category: string): MessageKey | undefined {
  return (FAILURE_CATEGORIES as readonly string[]).includes(category)
    ? (`system.failure.${category}` as MessageKey)
    : undefined;
}

export function failureCategoryLabel(category: string, locale: Locale = DEFAULT_LOCALE): string {
  const key = failureCategoryKey(category);
  return key ? t(locale, key) : category;
}

/** Ordered category rows for display, including categories at zero. */
export function failureCategoryRows(byCategory: Record<string, number> | undefined, locale: Locale = DEFAULT_LOCALE) {
  return FAILURE_CATEGORIES.map((key) => ({
    key,
    label: failureCategoryLabel(key, locale),
    count: byCategory?.[key] ?? 0,
  }));
}

/** Ordered job-state rows for display. */
export function jobStateRows(byState: Record<string, number> | undefined, locale: Locale = DEFAULT_LOCALE) {
  return JOB_STATES.map((key) => ({
    key,
    label: t(locale, `system.job.${key}` as MessageKey),
    count: byState?.[key] ?? 0,
  }));
}
