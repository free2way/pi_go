import { describe, expect, it } from "vitest";
import type { Run } from "./types.js";
import type { AcceptanceSnapshot } from "./types.js";
import { median, p90, shapeMetrics, shapeReleaseRetrospective, shapeReleaseSummary, type MetricEvent, type MetricRun, type MetricStory, type ReleaseIdentity } from "./agile-metrics.js";

function run(id: string, state: Run["state"], extra: Partial<Run> = {}): Run {
  return {
    id,
    ownerId: "user_a",
    title: "run title",
    task: "a sufficiently long task",
    repository: "/srv/repo",
    branch: `pigo/${id}`,
    mode: "real",
    state,
    round: 1,
    maxRounds: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    developer: { provider: "p", model: "m" },
    reviewer: { provider: "p", model: "m" },
    checks: [],
    findings: [],
    diff: "",
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
    ...extra,
  };
}

function acceptance(acceptedAt: string): AcceptanceSnapshot {
  return {
    acceptedAt,
    acceptedBy: "user_a",
    note: null,
    acknowledgedOpenFindings: false,
    findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } },
    diff: { artifactId: null, sha256: null, bytes: null },
    checks: { total: 0, passed: 0, failed: 0 },
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 },
  };
}

function story(overrides: Partial<MetricStory> = {}): MetricStory {
  return { id: "story_1", title: "故事", projectId: "proj_1", sprintId: "sprint_1", status: "backlog", ...overrides };
}

describe("median", () => {
  it("returns null for an empty sample and handles odd/even/unsorted input", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("p90", () => {
  it("uses the nearest-rank definition and is deterministic", () => {
    expect(p90([])).toBeNull();
    expect(p90([7])).toBe(7);
    // n=10 → ceil(9) = 9th value (index 8).
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    // n=5 → ceil(4.5) = 5th value.
    expect(p90([10, 1, 5, 3, 2])).toBe(10);
    expect(p90([2, 2, 2])).toBe(2);
  });
});

describe("shapeMetrics", () => {
  it("renders explicit zeros for an empty scope", () => {
    const metrics = shapeMetrics([], [], []);
    expect(metrics.stories).toEqual({ total: 0, completed: 0, byStatus: expect.objectContaining({ backlog: 0, done: 0, in_review: 0 }) });
    expect(metrics.cycleTime).toEqual({ samples: 0, medianSeconds: 0, p90Seconds: 0, items: [] });
    expect(metrics.rework).toEqual({ completed: 0, reworked: 0, rate: 0 });
    expect(metrics.usage).toEqual({ cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 0 });
    expect(metrics.costPerCompletedStory).toBe(0);
    expect(metrics.reviewFindings).toEqual({ total: 0, resolved: 0, notConverging: 0 });
    expect(metrics.runOutcomes).toEqual({ completed: 0, needs_human: 0, cancelled: 0, failed: 0 });
  });

  it("derives the story status from the latest linked run (reviewing → in_review)", () => {
    const metrics = shapeMetrics(
      [story({ id: "s1" }), story({ id: "s2", status: "ready" })],
      [
        { storyId: "s1", run: run("r1", "reviewing"), linkedAt: "2026-01-02T00:00:00.000Z" },
        { storyId: "s2", run: run("r2", "developing"), linkedAt: "2026-01-02T00:00:00.000Z" },
      ],
      [],
    );
    expect(metrics.stories.byStatus.in_review).toBe(1);
    expect(metrics.stories.byStatus.in_progress).toBe(1);
    expect(metrics.stories.byStatus.ready).toBe(0);
  });

  it("computes cycle times for completed stories plus median and p90", () => {
    const metrics = shapeMetrics(
      [story({ id: "s1" }), story({ id: "s2" })],
      [
        // s1: 2 days from first run to acceptance.
        { storyId: "s1", run: run("r1", "developing", { createdAt: "2026-01-01T00:00:00.000Z" }), linkedAt: "2026-01-01T00:00:00.000Z" },
        { storyId: "s1", run: run("r1b", "completed", { createdAt: "2026-01-01T06:00:00.000Z", acceptance: acceptance("2026-01-03T00:00:00.000Z") }), linkedAt: "2026-01-02T00:00:00.000Z" },
        // s2: 1 day.
        { storyId: "s2", run: run("r2", "completed", { createdAt: "2026-01-01T00:00:00.000Z", acceptance: acceptance("2026-01-02T00:00:00.000Z") }), linkedAt: "2026-01-02T00:00:00.000Z" },
      ],
      [],
    );
    expect(metrics.stories.completed).toBe(2);
    expect(metrics.cycleTime.samples).toBe(2);
    expect(metrics.cycleTime.items.map((item) => item.seconds).sort((a, b) => a - b)).toEqual([86_400, 172_800]);
    expect(metrics.cycleTime.medianSeconds).toBe(129_600);
    expect(metrics.cycleTime.p90Seconds).toBe(172_800);
  });

  it("computes rework rate, usage totals, cost per story and run outcome mix", () => {
    const metrics = shapeMetrics(
      [story({ id: "s1" })],
      [
        {
          storyId: "s1",
          run: run("r1", "completed", {
            usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, estimatedCost: 0.25 },
            modelCalls: 3,
            findings: [
              { id: "f1", severity: "high", file: null, line: null, title: "a", evidence: "", requiredChange: "x", resolved: true },
              { id: "f2", severity: "low", file: null, line: null, title: "b", evidence: "", requiredChange: "x", resolved: false },
            ],
            acceptance: acceptance("2026-01-02T00:00:00.000Z"),
          }),
          linkedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        { runId: "r1", type: "review.changes_requested" },
        { runId: "r1", type: "review.not_converging" },
      ],
    );
    expect(metrics.rework).toEqual({ completed: 1, reworked: 1, rate: 1 });
    expect(metrics.usage).toEqual({ cost: 0.25, inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, modelCalls: 3, runs: 1 });
    expect(metrics.costPerCompletedStory).toBe(0.25);
    expect(metrics.reviewFindings).toEqual({ total: 2, resolved: 1, notConverging: 1 });
    expect(metrics.runOutcomes).toEqual({ completed: 1, needs_human: 0, cancelled: 0, failed: 0 });
  });

  it("counts the terminal run outcome mix and never throws on sparse run documents", () => {
    const sparse = { id: "r_bad", state: "failed" } as Run;
    const metrics = shapeMetrics(
      [story({ id: "s1" }), story({ id: "s2" })],
      [
        { storyId: "s1", run: run("r1", "needs_human"), linkedAt: "2026-01-01T00:00:00.000Z" },
        { storyId: "s1", run: run("r2", "cancelled"), linkedAt: "2026-01-02T00:00:00.000Z" },
        { storyId: "s2", run: sparse, linkedAt: "2026-01-01T00:00:00.000Z" },
      ],
      [] as MetricEvent[],
    );
    expect(metrics.runOutcomes).toEqual({ completed: 0, needs_human: 1, cancelled: 1, failed: 1 });
    expect(metrics.runOutcomeUnknown).toBe(0);
    expect(metrics.costPerCompletedStory).toBe(0);
  });

  it("ignores runs that belong to stories outside the shaped scope", () => {
    const metrics = shapeMetrics(
      [story({ id: "s1" })],
      [
        { storyId: "s1", run: run("r1", "developing"), linkedAt: "2026-01-01T00:00:00.000Z" },
        { storyId: "other", run: run("r2", "completed", { usage: { inputTokens: 9, outputTokens: 9, estimatedCost: 9 } }), linkedAt: "2026-01-01T00:00:00.000Z" } as MetricRun,
      ],
      [],
    );
    expect(metrics.usage.cost).toBe(0);
    expect(metrics.runOutcomes.completed).toBe(0);
  });
});

function release(overrides: Partial<ReleaseIdentity> = {}): ReleaseIdentity {
  return { id: "rel_1", projectId: "proj_1", name: "结账发布", version: "v1.0.0", status: "in_progress", ...overrides };
}

describe("shapeReleaseSummary", () => {
  it("renders explicit zeros and empty lists for an empty release", () => {
    const summary = shapeReleaseSummary({ release: release(), generatedAt: "2026-02-01T00:00:00.000Z", stories: [], runs: [], events: [] });
    expect(summary.stories).toEqual([]);
    expect(summary.totals).toEqual({ stories: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0, runs: 0 });
    expect(summary.usage).toEqual({ cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 0 });
    expect(summary.modelCombinations).toEqual([]);
    expect(summary.merges).toEqual([]);
    expect(summary.deployments).toEqual([]);
  });

  it("shapes per-story outcomes, totals and cost/tokens", () => {
    const summary = shapeReleaseSummary({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s_done", title: "已验收" }), story({ id: "s_blocked", title: "被阻塞" }), story({ id: "s_dev", title: "开发中" })],
      runs: [
        {
          storyId: "s_done",
          run: run("r_done", "completed", {
            createdAt: "2026-01-01T00:00:00.000Z",
            usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, estimatedCost: 0.5 },
            modelCalls: 3,
            findings: [{ id: "f1", severity: "high", file: null, line: null, title: "a", evidence: "", requiredChange: "x", resolved: true }],
            acceptance: acceptance("2026-01-02T00:00:00.000Z"),
          }),
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
        { storyId: "s_blocked", run: run("r_blocked", "needs_human", { summary: "缺少模型凭据" }), linkedAt: "2026-01-02T00:00:00.000Z" },
        { storyId: "s_dev", run: run("r_dev", "developing"), linkedAt: "2026-01-03T00:00:00.000Z" },
      ],
      events: [
        { runId: "r_done", type: "review.changes_requested" },
        { runId: "r_done", type: "review.changes_requested" },
        { runId: "r_blocked", type: "review.not_converging" },
      ],
    });

    expect(summary.totals).toEqual({ stories: 3, done: 1, inProgress: 1, blocked: 1, notStarted: 0, runs: 3 });
    expect(summary.usage).toMatchObject({ cost: 0.5, inputTokens: 100, outputTokens: 40, modelCalls: 3, runs: 3 });
    const done = summary.stories.find((entry) => entry.storyId === "s_done")!;
    expect(done.status).toBe("done");
    expect(done.acceptance).toMatchObject({ acceptedAt: "2026-01-02T00:00:00.000Z", resolvedFindings: 0, remainingFindings: 0 });
    expect(done.findings).toEqual({ total: 1, resolved: 1 });
    expect(done.changesRequested).toBe(2);
    expect(done.latest).toMatchObject({ runId: "r_done", state: "completed", round: 1, maxRounds: 3 });
    const blocked = summary.stories.find((entry) => entry.storyId === "s_blocked")!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("缺少模型凭据");
    expect(blocked.notConverging).toBe(1);
  });

  it("aggregates developer/reviewer model pairs by run and story", () => {
    const comboA = { provider: "anthropic", model: "claude" };
    const comboB = { provider: "openai", model: "gpt" };
    const summary = shapeReleaseSummary({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s1" }), story({ id: "s2" })],
      runs: [
        { storyId: "s1", run: run("r1", "developing", { developer: comboA, reviewer: comboB }), linkedAt: "2026-01-01T00:00:00.000Z" },
        { storyId: "s1", run: run("r2", "reviewing", { developer: comboA, reviewer: comboB }), linkedAt: "2026-01-02T00:00:00.000Z" },
        { storyId: "s2", run: run("r3", "developing", { developer: comboB, reviewer: comboA }), linkedAt: "2026-01-03T00:00:00.000Z" },
      ],
      events: [],
    });
    expect(summary.modelCombinations).toEqual([
      { developer: comboA, reviewer: comboB, runs: 2, stories: 1 },
      { developer: comboB, reviewer: comboA, runs: 1, stories: 1 },
    ]);
  });

  it("reads merge and post-merge deployment records defensively", () => {
    const summary = shapeReleaseSummary({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s1" })],
      runs: [
        {
          storyId: "s1",
          run: run("r1", "completed", {
            acceptance: acceptance("2026-01-03T00:00:00.000Z"),
            merge: { commit: "abc123", strategy: "merge-commit", targetBranch: "main", mergedAt: "2026-01-03T00:00:00.000Z", mergedBy: "user_a" },
            release: { deliveryId: "d1", status: "succeeded", environment: "prod", commit: "abc123", targetBranch: "main", requestedAt: "2026-01-03T01:00:00.000Z", requestedBy: "user_a", startedAt: "2026-01-03T01:00:01.000Z", finishedAt: "2026-01-03T01:00:05.000Z", attempt: 1, kind: "webhook", url: "https://deploy.example/1" },
          }),
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      events: [],
    });
    expect(summary.merges).toEqual([
      { storyId: "s1", runId: "r1", commit: "abc123", strategy: "merge-commit", targetBranch: "main", mergedAt: "2026-01-03T00:00:00.000Z", mergedBy: "user_a" },
    ]);
    expect(summary.deployments).toEqual([
      { storyId: "s1", runId: "r1", status: "succeeded", environment: "prod", commit: "abc123", kind: "webhook", requestedAt: "2026-01-03T01:00:00.000Z", requestedBy: "user_a", finishedAt: "2026-01-03T01:00:05.000Z", url: "https://deploy.example/1" },
    ]);
  });

  it("never throws on a sparse run document or missing usage fields", () => {
    const sparse = { id: "r_sparse", state: "failed" } as Run;
    const summary = shapeReleaseSummary({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s1" })],
      runs: [{ storyId: "s1", run: sparse, linkedAt: "2026-01-01T00:00:00.000Z" }],
      events: [],
    });
    expect(summary.totals.blocked).toBe(1);
    expect(summary.usage).toEqual({ cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 1 });
    expect(summary.stories[0].cost).toBe(0);
    expect(summary.modelCombinations).toEqual([]);
    expect(summary.merges).toEqual([]);
    expect(summary.deployments).toEqual([]);
  });
});

describe("shapeReleaseRetrospective", () => {
  it("reuses the metrics core for cycle time, rework and cost per completed story", () => {
    const retro = shapeReleaseRetrospective({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s1", title: "完成的故事" })],
      runs: [
        {
          storyId: "s1",
          run: run("r1", "completed", { createdAt: "2026-01-01T00:00:00.000Z", usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0.5 }, acceptance: acceptance("2026-01-02T00:00:00.000Z") }),
          linkedAt: "2026-01-01T00:00:00.000Z",
        } as MetricRun,
      ],
      events: [{ runId: "r1", type: "review.changes_requested" }],
    });
    expect(retro.cycleTime.items.map((item) => item.seconds)).toEqual([86_400]);
    expect(retro.cycleTime.medianSeconds).toBe(86_400);
    expect(retro.rework).toEqual({ completed: 1, reworked: 1, rate: 1 });
    expect(retro.reviewFindings).toEqual({ total: 0, resolved: 0, notConverging: 0 });
    expect(retro.notConvergingRuns).toBe(0);
    expect(retro.totals).toMatchObject({ stories: 1, done: 1, runs: 1 });
    // Usage on the retro echoes the summary: 0.5 cost; 1 completed story → 0.5/story.
    expect(retro.costPerCompletedStory).toBe(0.5);
  });

  it("counts not-converging runs and lists blocked stories with reasons, ordered by first run", () => {
    const retro = shapeReleaseRetrospective({
      release: release(),
      generatedAt: "2026-02-01T00:00:00.000Z",
      stories: [story({ id: "s_late", title: "后开始" }), story({ id: "s_early", title: "先开始" })],
      runs: [
        { storyId: "s_late", run: run("r_late", "needs_human", { createdAt: "2026-01-05T00:00:00.000Z", summary: "审核未收敛" }), linkedAt: "2026-01-05T00:00:00.000Z" },
        { storyId: "s_early", run: run("r_early1", "reviewing", { createdAt: "2026-01-01T00:00:00.000Z" }), linkedAt: "2026-01-01T00:00:00.000Z" },
        { storyId: "s_early", run: run("r_early2", "developing", { createdAt: "2026-01-02T00:00:00.000Z" }), linkedAt: "2026-01-02T00:00:00.000Z" },
      ],
      events: [
        { runId: "r_early1", type: "review.not_converging" },
        { runId: "r_early1", type: "review.not_converging" },
        { runId: "r_early2", type: "review.not_converging" },
      ],
    });
    expect(retro.notConvergingRuns).toBe(2);
    expect(retro.reviewFindings.notConverging).toBe(3);
    expect(retro.blockedStories).toEqual([{ storyId: "s_late", title: "后开始", reason: "审核未收敛", state: "needs_human" }]);
    // Review trend follows the first linked run (earliest first), not story id.
    expect(retro.reviewTrend.map((point) => point.storyId)).toEqual(["s_early", "s_late"]);
    expect(retro.reviewTrend[0]).toMatchObject({ storyId: "s_early", notConverging: 3 });
  });

  it("renders explicit zeros for an empty release", () => {
    const retro = shapeReleaseRetrospective({ release: release(), generatedAt: "2026-02-01T00:00:00.000Z", stories: [], runs: [], events: [] });
    expect(retro.cycleTime).toEqual({ samples: 0, medianSeconds: 0, p90Seconds: 0, items: [] });
    expect(retro.rework).toEqual({ completed: 0, reworked: 0, rate: 0 });
    expect(retro.notConvergingRuns).toBe(0);
    expect(retro.costPerCompletedStory).toBe(0);
    expect(retro.blockedStories).toEqual([]);
    expect(retro.reviewTrend).toEqual([]);
  });
});
