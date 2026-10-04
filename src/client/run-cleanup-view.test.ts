import { describe, expect, it } from "vitest";
import {
  batchCleanupConfirmMessage,
  cleanupFinishedConfirmMessage,
  cleanupStorageDetailLines,
  cleanupStorageLabel,
  summarizeCleanupStorage,
} from "./run-cleanup-view";

describe("batch cleanup confirmation (B6)", () => {
  it("states that the run directory/worktree is deleted when the intent is true", () => {
    const message = batchCleanupConfirmMessage({ count: 3, deleteRunDirectory: true });
    expect(message).toContain("清理选中的 3 个已结束任务");
    expect(message).toContain("运行记录与制品");
    expect(message).toContain("同时删除服务器上的运行目录/worktree");
    expect(message).not.toContain("保留");
  });

  it("states that the run directory is kept when the intent is false", () => {
    const message = batchCleanupConfirmMessage({ count: 1, deleteRunDirectory: false });
    expect(message).toContain("服务器上的运行目录/worktree 将保留");
    expect(message).not.toContain("同时删除");
  });

  it("uses the same explicit wording for the finished-runs cleanup", () => {
    expect(cleanupFinishedConfirmMessage({ olderThanDays: 7, deleteRunDirectory: true })).toContain("同时删除服务器上的运行目录/worktree");
    expect(cleanupFinishedConfirmMessage({ olderThanDays: 7, deleteRunDirectory: false })).toContain("将保留");
  });
});

describe("cleanup outcome labels (B6)", () => {
  it("labels per-run storage", () => {
    expect(cleanupStorageLabel("removed")).toBe("已删除运行目录");
    expect(cleanupStorageLabel("kept")).toBe("保留运行目录");
    expect(cleanupStorageLabel(undefined)).toBe("运行目录状态未知");
  });

  it("summarizes removed/kept counts", () => {
    expect(summarizeCleanupStorage([{ storage: "removed" }, { storage: "kept" }, { storage: "kept" }])).toBe("运行目录：已删除 1 个，保留 2 个");
  });

  it("lists bounded per-run detail lines", () => {
    const results = Array.from({ length: 12 }, (_, index) => ({ runId: `run_${index}`.padEnd(20, "0"), storage: (index % 2 === 0 ? "removed" : "kept") as "removed" | "kept" }));
    expect(cleanupStorageDetailLines(results)).toHaveLength(10);
    expect(cleanupStorageDetailLines(results)[0]).toContain("已删除运行目录");
  });
});
