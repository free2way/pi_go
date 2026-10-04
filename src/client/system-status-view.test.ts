import { describe, expect, it } from "vitest";
import {
  SYSTEM_UNKNOWN,
  activeRunsSummary,
  databaseLabel,
  failureCategoryLabel,
  failureCategoryRows,
  formatAge,
  formatCompactNumber,
  formatCost,
  formatVersion,
  jobStateRows,
  storageLabel,
  workerLabel,
} from "./system-status-view";

describe("system-status-view: unknown handling", () => {
  it("renders unknown for unreadable values", () => {
    expect(formatAge(null)).toBe(SYSTEM_UNKNOWN);
    expect(formatAge(Number.NaN)).toBe(SYSTEM_UNKNOWN);
    expect(formatCost(null)).toBe(SYSTEM_UNKNOWN);
    expect(formatCompactNumber(undefined)).toBe(SYSTEM_UNKNOWN);
    expect(formatVersion(null)).toBe(SYSTEM_UNKNOWN);
    expect(formatVersion("  ")).toBe(SYSTEM_UNKNOWN);
    expect(databaseLabel(undefined)).toBe(SYSTEM_UNKNOWN);
    expect(workerLabel(undefined)).toBe(SYSTEM_UNKNOWN);
    expect(activeRunsSummary(undefined)).toBe(SYSTEM_UNKNOWN);
  });

  it("formats ages across units", () => {
    expect(formatAge(0)).toBe("0 秒");
    expect(formatAge(45_000)).toBe("45 秒");
    expect(formatAge(5 * 60_000)).toBe("5 分钟");
    expect(formatAge(3 * 3_600_000 + 12 * 60_000)).toBe("3 小时 12 分");
    expect(formatAge(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 天 3 小时");
  });

  it("formats numbers and cost", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(12_300)).toBe("12.3k");
    expect(formatCompactNumber(2_500_000)).toBe("2.5M");
    expect(formatCost(0.1234)).toBe("$0.123");
    expect(formatCost(0)).toBe("$0.000");
  });
});

describe("system-status-view: labels and rows", () => {
  it("labels database, worker and storage states", () => {
    expect(databaseLabel({ status: "ok" })).toBe("正常");
    expect(databaseLabel({ status: "unavailable" })).toBe("不可用");
    expect(workerLabel({ status: "ok" })).toBe("在线");
    expect(workerLabel({ status: "unreachable" })).toBe("不可达");
    expect(workerLabel({ status: "unknown" })).toBe(SYSTEM_UNKNOWN);
    expect(storageLabel("ok")).toBe("充足");
    expect(storageLabel("low")).toBe("偏低");
    expect(storageLabel("critical")).toBe("严重不足");
    expect(storageLabel(undefined)).toBe(SYSTEM_UNKNOWN);
  });

  it("summarises active runs", () => {
    expect(activeRunsSummary({ queued: 2, preparing: 1, developing: 4, checking: 1, reviewing: 2, total: 10 }))
      .toBe("活跃 10（排队 2 · 准备 1 · 开发 4 · 检查 1 · 审核 2）");
  });

  it("keeps zero-valued categories and unknown categories visible", () => {
    const rows = failureCategoryRows({ storage: 3, other: 1 });
    expect(rows.map((row) => row.key)).toEqual(["storage", "budget", "provider", "failure_artifact", "other"]);
    expect(rows.find((row) => row.key === "budget")?.count).toBe(0);
    expect(rows.find((row) => row.key === "other")?.count).toBe(1);
    expect(failureCategoryLabel("storage")).toBe("存储错误");
    expect(failureCategoryLabel("mystery")).toBe("mystery");
  });

  it("orders job-state rows and defaults missing states to zero", () => {
    const rows = jobStateRows({ queued: 3, claimed: 1 });
    expect(rows.map((row) => row.key)).toEqual(["queued", "claimed", "done", "failed", "cancelled"]);
    expect(rows.map((row) => row.count)).toEqual([3, 1, 0, 0, 0]);
  });
});
