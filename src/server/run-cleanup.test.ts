import { describe, expect, it, vi } from "vitest";
import { cleanupRunDirectory, keptRunStorageOutcome, type RunDirectoryCleaner } from "./run-cleanup.js";

const run = { id: "run_0123456789abcdef0123", ownerId: "a".repeat(64) };

describe("cleanupRunDirectory", () => {
  it("shapes a removed outcome with paths and bytes", async () => {
    const cleaner: RunDirectoryCleaner = vi.fn(async () => ({ removed: true, paths: ["a/b/run_1", "a/b/run_1.state"], bytes: 42 }));
    const outcome = await cleanupRunDirectory(run, { dryRun: false, cleaner });

    expect(outcome).toEqual({ runId: run.id, outcome: "removed", dryRun: false, paths: ["a/b/run_1", "a/b/run_1.state"], bytes: 42 });
    expect(cleaner).toHaveBeenCalledWith({ runId: run.id, ownerId: run.ownerId, dryRun: false });
  });

  it("treats a missing directory as a successful removal", async () => {
    const cleaner: RunDirectoryCleaner = async () => ({ removed: false });
    const outcome = await cleanupRunDirectory(run, { dryRun: false, cleaner });
    expect(outcome).toMatchObject({ outcome: "removed", paths: [], bytes: 0 });
  });

  it("marks the run kept instead of throwing when the worker is unreachable", async () => {
    const cleaner: RunDirectoryCleaner = async () => { throw new Error("fetch failed"); };
    const outcome = await cleanupRunDirectory(run, { dryRun: false, cleaner });
    expect(outcome).toEqual({ runId: run.id, outcome: "kept", reason: "fetch failed", dryRun: false, paths: [], bytes: 0 });
  });

  it("marks the run kept when the worker refuses the path", async () => {
    const cleaner: RunDirectoryCleaner = async () => { throw new Error("Invalid run id"); };
    const outcome = await cleanupRunDirectory(run, { dryRun: false, cleaner });
    expect(outcome.outcome).toBe("kept");
    expect(outcome.reason).toBe("Invalid run id");
  });

  it("forwards dry-run to the worker and labels the outcome", async () => {
    const cleaner = vi.fn<RunDirectoryCleaner>(async () => ({ removed: true, paths: ["a/b/run_1"], bytes: 10 }));
    const outcome = await cleanupRunDirectory(run, { dryRun: true, cleaner });
    expect(cleaner).toHaveBeenCalledWith({ runId: run.id, ownerId: run.ownerId, dryRun: true });
    expect(outcome).toMatchObject({ outcome: "removed", dryRun: true, paths: ["a/b/run_1"], bytes: 10 });
  });

  it("ignores malformed worker payload fields", async () => {
    const cleaner = async () => ({ paths: [1, "ok"] as unknown as string[], bytes: Number.NaN });
    const outcome = await cleanupRunDirectory(run, { dryRun: false, cleaner });
    expect(outcome.paths).toEqual(["ok"]);
    expect(outcome.bytes).toBe(0);
  });

  it("shapes a kept outcome for a run whose database deletion failed", () => {
    expect(keptRunStorageOutcome("run_1", "database deletion failed: boom")).toEqual({
      runId: "run_1",
      outcome: "kept",
      reason: "database deletion failed: boom",
      dryRun: false,
      paths: [],
      bytes: 0,
    });
  });
});
