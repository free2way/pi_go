/**
 * SYS-01 display mapping for the 「系统状态」 dashboard. Pure helpers only, so
 * unknown/unavailable values are decided in one place and covered by tests.
 */
import type { SystemStatusResponse } from "./api";

export const SYSTEM_UNKNOWN = "未知";
export const SYSTEM_UNAVAILABLE = "不可用";

/** Formats a millisecond age. `null`/non-finite means genuinely unknown. */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return SYSTEM_UNKNOWN;
  const value = Math.max(0, ms);
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)} 分钟`;
  if (value < 86_400_000) return `${Math.floor(value / 3_600_000)} 小时 ${Math.floor((value % 3_600_000) / 60_000)} 分`;
  return `${Math.floor(value / 86_400_000)} 天 ${Math.floor((value % 86_400_000) / 3_600_000)} 小时`;
}

/** Compact number for token counts; unknown stays explicit. */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return SYSTEM_UNKNOWN;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Estimated cost in USD; unknown stays explicit instead of a fake $0.000. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return SYSTEM_UNKNOWN;
  return `$${value.toFixed(3)}`;
}

/** Version text: an empty/missing version is 未知. */
export function formatVersion(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim() : SYSTEM_UNKNOWN;
}

export function databaseLabel(status: SystemStatusResponse["infrastructure"]["database"] | undefined): string {
  if (!status) return SYSTEM_UNKNOWN;
  if (status.status === "ok") return "正常";
  return "不可用";
}

export function workerLabel(worker: SystemStatusResponse["infrastructure"]["worker"] | undefined): string {
  if (!worker) return SYSTEM_UNKNOWN;
  if (worker.status === "ok") return "在线";
  if (worker.status === "unreachable") return "不可达";
  return SYSTEM_UNKNOWN;
}

export function storageLabel(storage: SystemStatusResponse["infrastructure"]["worker"]["storage"] | undefined): string {
  if (storage === "ok") return "充足";
  if (storage === "low") return "偏低";
  if (storage === "critical") return "严重不足";
  return SYSTEM_UNKNOWN;
}

/** e.g. `活跃 10（排队 2 · 准备 1 · 开发 4 · 检查 1 · 审核 2）` */
export function activeRunsSummary(active: SystemStatusResponse["runs"]["active"] | undefined): string {
  if (!active) return SYSTEM_UNKNOWN;
  return `活跃 ${active.total}（排队 ${active.queued} · 准备 ${active.preparing} · 开发 ${active.developing} · 检查 ${active.checking} · 审核 ${active.reviewing}）`;
}

const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  storage: "存储错误",
  budget: "预算耗尽",
  provider: "Provider 错误",
  failure_artifact: "制品采集失败",
  other: "其他",
};

export function failureCategoryLabel(category: string): string {
  return FAILURE_CATEGORY_LABELS[category] ?? category;
}

/** Ordered category rows for display, including categories at zero. */
export function failureCategoryRows(byCategory: Record<string, number> | undefined) {
  return Object.keys(FAILURE_CATEGORY_LABELS).map((key) => ({
    key,
    label: FAILURE_CATEGORY_LABELS[key],
    count: byCategory?.[key] ?? 0,
  }));
}

/** Ordered job-state rows for display. */
export function jobStateRows(byState: Record<string, number> | undefined) {
  return [
    { key: "queued", label: "排队" },
    { key: "claimed", label: "执行中" },
    { key: "done", label: "完成" },
    { key: "failed", label: "失败" },
    { key: "cancelled", label: "取消" },
  ].map(({ key, label }) => ({ key, label, count: byState?.[key] ?? 0 }));
}
