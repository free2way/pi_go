import { describe, expect, it } from "vitest";
import {
  FAILURE_SCAN_LIMIT,
  SYSTEM_STATUS_SCHEMA_VERSION,
  USAGE_RUN_SCAN_LIMIT,
  ageMs,
  buildSystemStatus,
  failureCategory,
  sanitizeFailureSummary,
  utcDay,
  utcDayStart,
  type DeploymentInfo,
  type SystemStatusInput,
} from "./system-status.js";

const NOW = "2026-10-04T12:00:00.000Z";

function baseInput(overrides: Partial<SystemStatusInput> = {}): SystemStatusInput {
  return {
    now: NOW,
    versions: { web: "0.22.0", worker: "0.22.0" },
    infrastructure: { database: { status: "ok" }, worker: { status: "ok", activeJobs: 2 } },
    jobStates: [],
    runStates: [],
    todayRuns: [],
    failures: [],
    deployments: null,
    ...overrides,
  };
}

const deployment: DeploymentInfo = {
  web: { version: "0.22.0" },
  worker: { version: "0.22.0" },
  rollbackTags: ["v0.21.9"],
  records: [],
  log: { available: false },
  at: NOW,
};

describe("system-status: envelope and unknown states", () => {
  it("stamps the schema version and keeps unreadable sections explicitly unavailable", () => {
    const status = buildSystemStatus({
      now: NOW,
      versions: { web: null, worker: null },
      infrastructure: { database: { status: "unavailable" }, worker: { status: "unreachable" } },
      jobStates: null,
      runStates: null,
      todayRuns: null,
      failures: null,
      deployments: null,
    });
    expect(status.schemaVersion).toBe(SYSTEM_STATUS_SCHEMA_VERSION);
    expect(status.at).toBe(NOW);
    expect(status.versions).toEqual({ web: null, worker: null });
    expect(status.queue.status).toBe("unavailable");
    expect(status.runs.status).toBe("unavailable");
    expect(status.usage.status).toBe("unavailable");
    expect(status.usage.modelCalls).toBeNull();
    expect(status.failures.status).toBe("unavailable");
    expect(status.deployments).toBeNull();
    // Unknown states are zero-filled so the client never renders `undefined`.
    expect(Object.keys(status.runs.byState)).toHaveLength(9);
    expect(status.runs.byState.completed).toBe(0);
  });

  it("treats a malformed `now` as use-now rather than crashing", () => {
    const status = buildSystemStatus(baseInput({ now: "not-a-date" }));
    expect(Number.isFinite(Date.parse(status.at))).toBe(true);
  });

  it("passes deployment data through unchanged", () => {
    expect(buildSystemStatus(baseInput({ deployments: deployment })).deployments).toEqual(deployment);
  });
});

describe("system-status: queue and runs", () => {
  it("counts jobs by state and derives the oldest queued age", () => {
    const status = buildSystemStatus(baseInput({
      jobStates: [
        { state: "queued", count: "3", oldestAt: "2026-10-04T11:00:00.000Z" },
        { state: "claimed", count: 1 },
        { state: "done", count: 12 },
      ],
    }));
    expect(status.queue.status).toBe("ok");
    expect(status.queue.byState.queued).toBe(3);
    expect(status.queue.byState.claimed).toBe(1);
    expect(status.queue.byState.failed).toBe(0);
    expect(status.queue.total).toBe(16);
    expect(status.queue.active).toBe(4);
    expect(status.queue.oldestQueuedAgeMs).toBe(60 * 60_000);
  });

  it("splits active runs by state and keeps preparing out of the queue age", () => {
    const status = buildSystemStatus(baseInput({
      runStates: [
        { state: "queued", count: 2, oldestAt: "2026-10-04T11:30:00.000Z" },
        { state: "preparing", count: 1 },
        { state: "developing", count: 4 },
        { state: "checking", count: 1 },
        { state: "reviewing", count: 2 },
        { state: "completed", count: 9 },
        { state: "failed", count: 1 },
      ],
    }));
    expect(status.runs.total).toBe(20);
    expect(status.runs.active).toEqual({ queued: 2, preparing: 1, developing: 4, checking: 1, reviewing: 2, total: 10 });
    expect(status.runs.oldestQueuedAgeMs).toBe(30 * 60_000);
  });

  it("keeps age unknown when the oldest timestamp is unreadable", () => {
    const status = buildSystemStatus(baseInput({ jobStates: [{ state: "queued", count: 1, oldestAt: "garbage" }] }));
    // An unparseable timestamp is genuinely unknown, never echoed as a fake value.
    expect(status.queue.oldestQueuedAt).toBeNull();
    expect(status.queue.oldestQueuedAgeMs).toBeNull();
    expect(ageMs("garbage", Date.parse(NOW))).toBeNull();
    expect(ageMs("2026-10-04T13:00:00.000Z", Date.parse(NOW))).toBe(0);
  });
});

describe("system-status: usage", () => {
  it("sums today's run usage and reads model calls from usageRoles when absent", () => {
    const status = buildSystemStatus(baseInput({
      todayRuns: [
        { documentJson: JSON.stringify({ usage: { inputTokens: 100, outputTokens: 40, estimatedCost: 0.12 }, modelCalls: 3 }) },
        { documentJson: JSON.stringify({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCost: 0.01 }, usageRoles: [{ calls: 2 }, { calls: 4 }] }) },
      ],
    }));
    expect(status.usage.status).toBe("ok");
    expect(status.usage.date).toBe("2026-10-04");
    expect(status.usage.scannedRuns).toBe(2);
    expect(status.usage.inputTokens).toBe(110);
    expect(status.usage.outputTokens).toBe(45);
    expect(status.usage.totalTokens).toBe(155);
    expect(status.usage.estimatedCost).toBeCloseTo(0.13);
    expect(status.usage.modelCalls).toBe(9);
  });

  it("reports modelCalls unknown when no run exposes a call count", () => {
    const status = buildSystemStatus(baseInput({ todayRuns: [{ documentJson: JSON.stringify({ usage: { inputTokens: 5, outputTokens: 5 } }) }] }));
    expect(status.usage.modelCalls).toBeNull();
    expect(status.usage.inputTokens).toBe(5);
  });

  it("skips malformed documents without throwing and flags truncation", () => {
    const todayRuns = [{ documentJson: "not json" }, { documentJson: undefined }, null];
    while (todayRuns.length < USAGE_RUN_SCAN_LIMIT) todayRuns.push(null as never);
    const status = buildSystemStatus(baseInput({ todayRuns }));
    expect(status.usage.scannedRuns).toBe(0);
    expect(status.usage.truncated).toBe(true);
    expect(status.failures.status).toBe("ok");
  });

  it("computes UTC day bounds", () => {
    expect(utcDay("2026-10-04T23:59:00.000Z")).toBe("2026-10-04");
    expect(utcDayStart("2026-10-04T12:00:00.000Z")).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("system-status: failures", () => {
  it("categorises event types by prefix and keeps only the newest summaries", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      at: `2026-10-04T00:0${index}:00.000Z`,
      type: index % 2 === 0 ? "run.storage_error" : "run.budget_exhausted",
      message: `第 ${index} 次失败`,
    }));
    rows.push({ at: "2026-10-04T03:30:00.000Z", type: "review.provider_error", message: "provider timeout" });
    rows.push({ at: "2026-10-04T03:40:00.000Z", type: "subagent.failure_artifact", message: "artifact capture failed" });
    const status = buildSystemStatus(baseInput({ failures: rows }));
    expect(status.failures.status).toBe("ok");
    expect(status.failures.byCategory.storage).toBe(4);
    expect(status.failures.byCategory.budget).toBe(4);
    expect(status.failures.byCategory.provider).toBe(1);
    expect(status.failures.byCategory.failure_artifact).toBe(1);
    expect(status.failures.total).toBe(10);
    expect(status.failures.recent).toHaveLength(5);
    expect(status.failures.recent[0].type).toBe("subagent.failure_artifact");
    expect(status.failures.recent[0].category).toBe("failure_artifact");
  });

  it("classifies unknown event types as other and includes every category key", () => {
    const status = buildSystemStatus(baseInput({ failures: [{ at: NOW, type: "run.something_else", message: "" }] }));
    expect(status.failures.byCategory.other).toBe(1);
    expect(Object.keys(status.failures.byCategory).sort()).toEqual(["budget", "failure_artifact", "other", "provider", "storage"]);
    expect(status.failures.recent[0].summary).toBe("无摘要");
  });

  it("flags the scan as truncated at the query limit", () => {
    const rows = Array.from({ length: FAILURE_SCAN_LIMIT }, () => ({ at: NOW, type: "run.storage_error", message: "boom" }));
    expect(buildSystemStatus(baseInput({ failures: rows })).failures.truncated).toBe(true);
  });

  it("maps each category prefix correctly", () => {
    expect(failureCategory("run.storage_error")).toBe("storage");
    expect(failureCategory("RUN.BUDGET_EXHAUSTED")).toBe("budget");
    expect(failureCategory("subagent.failure_artifact_failed")).toBe("failure_artifact");
    expect(failureCategory("review.provider_error")).toBe("provider");
    expect(failureCategory(undefined)).toBe("other");
  });

  it("strips absolute paths and URLs from summaries", () => {
    expect(sanitizeFailureSummary("读取 /app/pi-agent/runs/abc/worktree 失败")).toBe("读取 [path] 失败");
    expect(sanitizeFailureSummary("POST https://api.example.com/v1/chat 超时")).toBe("POST [url] 超时");
    const long = sanitizeFailureSummary("x".repeat(300));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });
});
