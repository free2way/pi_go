import { describe, expect, it } from "vitest";
import { MAX_BATCH_RUN_IDS, batchItemFailure, batchItemSuccess, parseBatchRunIds, summarizeBatch } from "./batch-runs.js";

describe("parseBatchRunIds (B3)", () => {
  it("trims, filters and de-duplicates while preserving order", () => {
    expect(parseBatchRunIds([" run_a ", "run_b", "run_a", "", 3])).toEqual({ ok: true, ids: ["run_a", "run_b"] });
  });

  it("rejects a non-array, an empty list, and an oversized list", () => {
    expect(parseBatchRunIds("run_a").ok).toBe(false);
    expect(parseBatchRunIds([]).ok).toBe(false);
    expect(parseBatchRunIds(Array.from({ length: MAX_BATCH_RUN_IDS + 1 }, (_, index) => `run_${index}`)).ok).toBe(false);
  });

  it("accepts exactly the maximum", () => {
    const ids = Array.from({ length: MAX_BATCH_RUN_IDS }, (_, index) => `run_${index}`);
    expect(parseBatchRunIds(ids)).toEqual({ ok: true, ids });
  });
});

describe("batch cleanup storage outcomes (B6)", () => {
  it("carries the on-disk outcome on success and failure", () => {
    expect(batchItemSuccess("run_a", "completed", "removed")).toEqual({ runId: "run_a", ok: true, state: "completed", storage: "removed" });
    expect(batchItemSuccess("run_b", "failed", "kept")).toEqual({ runId: "run_b", ok: true, state: "failed", storage: "kept" });
    // Non-cleanup actions must not invent a storage label.
    expect(batchItemSuccess("run_c", "completed")).toEqual({ runId: "run_c", ok: true, state: "completed" });
    expect(batchItemFailure("run_d", 500, undefined, "boom", "kept")).toMatchObject({ ok: false, error: "boom", storage: "kept" });
  });

  it("preserves per-run storage through summarizeBatch", () => {
    const summary = summarizeBatch("cleanup", [
      batchItemSuccess("run_a", "completed", "removed"),
      batchItemSuccess("run_b", "cancelled", "kept"),
      batchItemFailure("run_c", 409, "RUN_ACTIVE", "无法清理状态为 developing 的任务"),
    ]);
    expect(summary.results.map((result) => result.storage)).toEqual(["removed", "kept", undefined]);
  });
});

describe("summarizeBatch (B3)", () => {
  it("reports partial failures individually with their codes", () => {
    const summary = summarizeBatch("accept", [
      batchItemSuccess("run_a", "completed"),
      batchItemFailure("run_b", 409, "OPEN_FINDINGS", "还有 1 条未解决意见"),
      batchItemFailure("run_c", 404, undefined, "Run not found"),
    ]);
    expect(summary).toMatchObject({ action: "accept", total: 3, succeeded: 1, failed: 2 });
    expect(summary.results[1]).toEqual({ runId: "run_b", ok: false, code: "OPEN_FINDINGS", error: "还有 1 条未解决意见" });
    expect(summary.results[2]).toEqual({ runId: "run_c", ok: false, error: "Run not found" });
  });

  it("is empty-safe", () => {
    expect(summarizeBatch("cleanup", [])).toEqual({ action: "cleanup", total: 0, succeeded: 0, failed: 0, results: [] });
  });
});
