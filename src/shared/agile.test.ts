import { describe, expect, it } from "vitest";
import type { Run } from "./types.js";
import {
  BOARD_COLUMNS,
  boardColumnFor,
  buildStoryRunInput,
  composeStoryTask,
  deriveStoryStatus,
  latestLinkedRun,
  summarizeStoryRun,
  type AgileStory,
} from "./agile.js";

function run(state: Run["state"], extra: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ownerId: "owner_a",
    title: "t",
    task: "a sufficiently long task",
    repository: "repo",
    branch: "b",
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

function story(overrides: Partial<AgileStory> = {}): AgileStory {
  return {
    id: "story_1",
    projectId: "proj_1",
    ownerId: "owner_a",
    title: "实现登录限流",
    description: "在 session 服务中加入限流。",
    acceptanceCriteria: ["超过阈值返回 429", "并发请求只触发一次刷新"],
    priority: "must",
    estimate: 5,
    definitionOfDone: ["单元测试通过", "无新增 lint 问题"],
    developerModel: null,
    reviewerModel: null,
    budget: null,
    maxParallel: null,
    status: "ready",
    sprintId: null,
    workspaceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveStoryStatus", () => {
  it("returns undefined when no run is linked, preserving manual planning state", () => {
    expect(deriveStoryStatus(undefined)).toBeUndefined();
    expect(deriveStoryStatus(null)).toBeUndefined();
  });

  it.each(["queued", "preparing", "developing", "checking", "reviewing"] as const)(
    "maps an active run (%s) to in_progress",
    (state) => {
      expect(deriveStoryStatus(run(state))).toEqual({ status: "in_progress" });
    },
  );

  it("maps a completed run to awaiting_acceptance", () => {
    expect(deriveStoryStatus(run("completed"))).toEqual({ status: "awaiting_acceptance" });
  });

  it("maps an accepted run to done", () => {
    const accepted = run("completed", { acceptance: { acceptedAt: "2026-01-02T00:00:00.000Z", acceptedBy: "u", note: null, acknowledgedOpenFindings: false, findings: { resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } }, diff: { artifactId: null, sha256: null, bytes: null }, checks: { total: 0, passed: 0, failed: 0 }, usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 } } });
    expect(deriveStoryStatus(accepted)).toEqual({ status: "done" });
  });

  it("blocks a run that needs a human and carries the run summary as the reason", () => {
    expect(deriveStoryStatus(run("needs_human", { summary: "预算超限，等待人工确认" }))).toEqual({
      status: "blocked",
      reason: "预算超限，等待人工确认",
    });
  });

  it("blocks failed and cancelled runs with a fallback reason", () => {
    expect(deriveStoryStatus(run("failed"))).toEqual({ status: "blocked", reason: "运行失败" });
    expect(deriveStoryStatus(run("cancelled", { summary: "已由用户取消" }))).toEqual({ status: "blocked", reason: "已由用户取消" });
  });

  it("prefers blocked over an old acceptance snapshot (reopened run)", () => {
    const reopened = run("needs_human", { acceptance: {} as Run["acceptance"], summary: "重新打开" });
    expect(deriveStoryStatus(reopened)).toEqual({ status: "blocked", reason: "重新打开" });
  });
});

describe("story board mapping", () => {
  it("exposes the six requested columns in order", () => {
    expect(BOARD_COLUMNS.map((column) => column.label)).toEqual(["待办", "开发中", "审核中", "待验收", "完成", "阻塞"]);
  });

  it("folds backlog and ready into 待办 and maps every status to a column", () => {
    expect(boardColumnFor("backlog")).toBe("todo");
    expect(boardColumnFor("ready")).toBe("todo");
    expect(boardColumnFor("in_progress")).toBe("in_progress");
    expect(boardColumnFor("in_review")).toBe("in_review");
    expect(boardColumnFor("awaiting_acceptance")).toBe("awaiting_acceptance");
    expect(boardColumnFor("done")).toBe("done");
    expect(boardColumnFor("blocked")).toBe("blocked");
    for (const column of BOARD_COLUMNS) expect(column.statuses.length).toBeGreaterThan(0);
  });
});

describe("buildStoryRunInput", () => {
  it("composes the task from description, acceptance criteria and definition of done", () => {
    const input = buildStoryRunInput(story());
    expect(input.task).toContain("在 session 服务中加入限流。");
    expect(input.task).toContain("## 验收标准");
    expect(input.task).toContain("1. 超过阈值返回 429");
    expect(input.task).toContain("## 完成定义");
    expect(input.task).toContain("- 单元测试通过");
    expect(input.acceptanceCriteria).toBe("超过阈值返回 429\n并发请求只触发一次刷新");
  });

  it("passes through workspace/model/budget/parallel when set", () => {
    const input = buildStoryRunInput(
      story({
        workspaceId: "ws_1",
        developerModel: { provider: "deepseek", model: "flash" },
        reviewerModel: { provider: "openai-proxy", model: "gpt" },
        budget: { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 },
        maxParallel: 3,
      }),
      { checks: ["npm test"] },
    );
    expect(input.workspaceId).toBe("ws_1");
    expect(input.checks).toEqual(["npm test"]);
    expect(input.developerModel).toEqual({ provider: "deepseek", model: "flash" });
    expect(input.budget).toEqual({ maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 });
    expect(input.maxParallel).toBe(3);
  });

  it("prefers an explicit workspace override and falls back to the title for an empty task", () => {
    const input = buildStoryRunInput(story({ description: "", acceptanceCriteria: [], definitionOfDone: [], workspaceId: "ws_1" }), { workspaceId: "ws_2" });
    expect(input.workspaceId).toBe("ws_2");
    expect(input.task).toBe("实现登录限流");
    expect(input.acceptanceCriteria).toBeUndefined();
  });

  it("composeStoryTask trims blank list items", () => {
    expect(composeStoryTask(story({ acceptanceCriteria: ["  ", "有效标准"], definitionOfDone: [] }))).toContain("1. 有效标准");
  });
});

describe("latestLinkedRun", () => {
  it("prefers the most recently linked run and breaks ties on run.updatedAt", () => {
    const older = { run: run("developing", { id: "run_old", updatedAt: "2026-01-01T00:00:00.000Z" }), linkedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { run: run("completed", { id: "run_new", updatedAt: "2026-01-03T00:00:00.000Z" }), linkedAt: "2026-01-02T00:00:00.000Z" };
    expect(latestLinkedRun([older, newer])?.run.id).toBe("run_new");
    const tieA = { run: run("developing", { id: "run_a", updatedAt: "2026-01-01T00:00:00.000Z" }), linkedAt: "2026-01-02T00:00:00.000Z" };
    const tieB = { run: run("completed", { id: "run_b", updatedAt: "2026-01-05T00:00:00.000Z" }), linkedAt: "2026-01-02T00:00:00.000Z" };
    expect(latestLinkedRun([tieA, tieB])?.run.id).toBe("run_b");
  });
});

describe("summarizeStoryRun", () => {
  it("counts findings, checks and cost", () => {
    const summarized = summarizeStoryRun(
      run("reviewing", {
        round: 2,
        summary: "第 2 轮",
        findings: [
          { id: "f1", severity: "high", file: null, line: null, title: "a", requiredChange: "x", evidence: "", resolved: true },
          { id: "f2", severity: "low", file: null, line: null, title: "b", requiredChange: "x", evidence: "", resolved: false },
        ],
        checks: [
          { id: "c1", name: "lint", command: "npm run lint", status: "passed" },
          { id: "c2", name: "test", command: "npm test", status: "failed" },
          { id: "c3", name: "type", command: "tsc", status: "pending" },
        ],
        usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.42 },
      }),
      "2026-01-02T00:00:00.000Z",
    );
    expect(summarized).toMatchObject({
      runId: "run_1",
      state: "reviewing",
      round: 2,
      findings: { resolved: 1, total: 2 },
      checks: { passed: 1, failed: 1 },
      cost: 0.42,
      linkedAt: "2026-01-02T00:00:00.000Z",
    });
  });
});
