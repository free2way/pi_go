import { describe, expect, it } from "vitest";
import { CheckpointTracker, memoryCheckpointClient, stages } from "./checkpoints.js";

describe("CheckpointTracker", () => {
  it("records stage progress with a stable idempotency key", async () => {
    const client = memoryCheckpointClient();
    const tracker = await new CheckpointTracker(client, "run_1").load();

    await tracker.start(stages.review(1));
    expect(tracker.isRunning(stages.review(1))).toBe(true);
    expect(tracker.isCompleted(stages.review(1))).toBe(false);

    await tracker.complete(stages.review(1), { verdict: "approved", summary: "ok", findings: [] });
    expect(tracker.isCompleted(stages.review(1))).toBe(true);

    const stored = await client.list("run_1");
    expect(stored).toHaveLength(1);
    expect(stored[0].idempotencyKey).toBe("run_1:review:1");
    expect(stored[0].payload).toEqual({ verdict: "approved", summary: "ok", findings: [] });
  });

  it("restores finished stages after a worker restart (AT-REL-002)", async () => {
    const client = memoryCheckpointClient();
    const firstRun = await new CheckpointTracker(client, "run_2").load();
    await firstRun.complete(stages.planning, { complexity: "small", rationale: "r", strategy: "single", tasks: [] });
    await firstRun.complete(stages.development(1), { round: 1 });
    await firstRun.complete(stages.task("api"), { status: "merged", summary: "done" });
    await firstRun.complete(stages.checks(1), { passed: true, results: [] });

    // A new process (restarted worker) reads the same durable checkpoints.
    const restarted = await new CheckpointTracker(client, "run_2").load();
    expect(restarted.isCompleted(stages.planning)).toBe(true);
    expect(restarted.isCompleted(stages.development(1))).toBe(true);
    expect(restarted.isCompleted(stages.task("api"))).toBe(true);
    expect(restarted.payload<{ passed: boolean }>(stages.checks(1))?.passed).toBe(true);
    expect(restarted.payload<{ status: string }>(stages.task("api"))?.status).toBe("merged");

    // Stages that never ran are still pending, so they execute normally.
    expect(restarted.isCompleted(stages.development(2))).toBe(false);
    expect(restarted.isCompleted(stages.review(1))).toBe(false);
  });

  it("keeps a verdict from being re-requested but retries an interrupted review (AT-REL-003)", async () => {
    const client = memoryCheckpointClient();
    const tracker = await new CheckpointTracker(client, "run_3").load();

    // Interrupted mid-call: only "running" was recorded, so the review re-runs.
    await tracker.start(stages.review(1));
    const restarted = await new CheckpointTracker(client, "run_3").load();
    expect(restarted.isCompleted(stages.review(1))).toBe(false);
    expect(restarted.isRunning(stages.review(1))).toBe(true);

    await restarted.complete(stages.review(1), { verdict: "changes_requested", summary: "fix", findings: [] });
    const afterVerdict = await new CheckpointTracker(client, "run_3").load();
    expect(afterVerdict.isCompleted(stages.review(1))).toBe(true);
    expect(afterVerdict.payload<{ verdict: string }>(stages.review(1))?.verdict).toBe("changes_requested");
  });

  it("keeps the last stage state when a stage fails", async () => {
    const tracker = await new CheckpointTracker(memoryCheckpointClient(), "run_4").load();
    await tracker.fail(stages.task("api"), "boom");
    expect(tracker.isCompleted(stages.task("api"))).toBe(false);
    expect(tracker.payload<{ error: string }>(stages.task("api"))?.error).toBe("boom");
  });
});
