import { describe, expect, it } from "vitest";
import type { Finding, Run, RunEvent } from "./types";
import { branchStatus, currentRoundStatus, roundStatuses, roundStatusTooltip } from "./round-status";

const baseEvent = (overrides: Partial<RunEvent>): RunEvent => ({
  seq: 1,
  runId: "run_test",
  round: 1,
  source: "system",
  type: "round.started",
  message: "started",
  at: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "f1",
  severity: "high",
  file: "src/auth/session.ts",
  line: 46,
  title: "失败请求可能污染并发锁",
  evidence: "evidence",
  requiredChange: "用 finally 清理锁",
  resolved: false,
  ...overrides,
});

const minimalRun = (overrides: Partial<Run> = {}): Run => ({
  id: "run_test",
  ownerId: "owner",
  title: "t",
  task: "task",
  repository: "demo/repo",
  branch: "ai-run/x",
  mode: "demo",
  state: "developing",
  round: 1,
  maxRounds: 3,
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
  developer: { provider: "deepseek", model: "deepseek-flash" },
  reviewer: { provider: "openai-proxy", model: "gpt-5.6-sol" },
  checks: [],
  findings: [],
  diff: "",
  summary: "",
  usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  durationMs: 0,
  lastSeq: 0,
  ...overrides,
});

describe("roundStatuses status precedence", () => {
  it("ranks approved above every other signal in the round", () => {
    const events = [
      baseEvent({ seq: 1, round: 2, type: "round.started" }),
      baseEvent({ seq: 2, round: 2, source: "checks", type: "checks.started" }),
      baseEvent({ seq: 3, round: 2, source: "checks", type: "checks.passed", meta: { checks: [{ status: "passed" }] } }),
      baseEvent({ seq: 4, round: 2, source: "reviewer", type: "review.started" }),
      baseEvent({ seq: 5, round: 2, source: "reviewer", type: "review.approved" }),
    ];

    expect(roundStatuses(events)).toEqual([
      expect.objectContaining({ round: 2, status: "approved" }),
    ]);
  });

  it("ranks changes_requested above reviewing/checking/developing", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "checks", type: "checks.started" }),
      baseEvent({ seq: 3, round: 1, source: "reviewer", type: "review.started" }),
      baseEvent({ seq: 4, round: 1, source: "reviewer", type: "review.changes_requested" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("changes_requested");
  });

  it("ranks reviewing above checking and developing", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "checks", type: "checks.started" }),
      baseEvent({ seq: 3, round: 1, source: "reviewer", type: "review.started" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("reviewing");
  });

  it("treats a reviewer hand-off chat message as reviewing when no verdict exists yet", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "reviewer", type: "chat.message", meta: { chat: { channel: "handoff", from: "reviewer", to: "developer", role: "feedback", content: "再看一次" } } }),
    ];

    expect(roundStatuses(events)[0].status).toBe("reviewing");
  });

  it("ranks checking above developing", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "developer", type: "developer.started" }),
      baseEvent({ seq: 2, round: 1, source: "checks", type: "checks.started" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("checking");
  });

  it("reports developing for developer, plan and subagent activity", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "developer", type: "agent.repair_started" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("developing");
  });

  it("reports planned for a round with no stage signal", () => {
    expect(roundStatuses([baseEvent({ round: 3, type: "unknown.event" })])[0].status).toBe("planned");
  });

  it("tracks each round independently and sorts ascending", () => {
    const events = [
      baseEvent({ seq: 1, round: 2, source: "reviewer", type: "review.approved" }),
      baseEvent({ seq: 2, round: 1, source: "reviewer", type: "review.changes_requested" }),
    ];

    const statuses = roundStatuses(events);
    expect(statuses.map((status) => status.round)).toEqual([1, 2]);
    expect(statuses.map((status) => status.status)).toEqual(["changes_requested", "approved"]);
  });
});

describe("roundStatuses aggregation", () => {
  it("counts the latest check snapshot's passed/failed results", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "checks", type: "checks.started", meta: { checks: [{ status: "running" }, { status: "running" }] } }),
      baseEvent({ seq: 2, round: 1, source: "checks", type: "checks.passed", meta: { checks: [{ status: "passed" }, { status: "passed" }, { status: "passed" }] } }),
    ];

    expect(roundStatuses(events)[0].checks).toEqual({ passed: 3, failed: 0 });
  });

  it("counts failures from checks.returned and degrades when the array is omitted", () => {
    const withArray = [
      baseEvent({ seq: 1, round: 1, source: "checks", type: "checks.returned", meta: { checkPassed: false, checks: [{ status: "passed" }, { status: "failed" }] } }),
    ];
    expect(roundStatuses(withArray)[0].checks).toEqual({ passed: 1, failed: 1 });

    const withoutArray = [
      baseEvent({ seq: 1, round: 1, source: "checks", type: "checks.returned", meta: { checkPassed: false } }),
    ];
    expect(roundStatuses(withoutArray)[0].checks).toEqual({ passed: 0, failed: 1 });
  });

  it("aggregates findings from event meta and marks resolved ones", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested", meta: { findings: [finding({ id: "a" }), finding({ id: "b", resolved: true })] } }),
    ];

    const status = roundStatuses(events)[0];
    expect(status.findings).toEqual({ total: 2, resolved: 1 });
  });

  it("dedupes the same finding carried by both the review event and the run snapshot", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested", meta: { findings: [finding({ id: "a", firstSeenRound: 1 })] } }),
    ];
    const run = minimalRun({ findings: [finding({ id: "a", firstSeenRound: 1, resolved: true })] });

    const status = roundStatuses(events, run)[0];
    expect(status.findings).toEqual({ total: 1, resolved: 1 });
  });

  it("records startedAt and the terminal finishedAt", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, at: "2026-10-04T10:00:00.000Z", type: "round.started" }),
      baseEvent({ seq: 2, round: 1, at: "2026-10-04T10:05:00.000Z", source: "reviewer", type: "review.changes_requested" }),
    ];

    const status = roundStatuses(events)[0];
    expect(status.startedAt).toBe("2026-10-04T10:00:00.000Z");
    expect(status.finishedAt).toBe("2026-10-04T10:05:00.000Z");
  });
});

describe("roundStatuses interrupted handling", () => {
  it("reports interrupted for a deadline without a terminal review event", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "system", type: "run.deadline_exceeded" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("interrupted");
  });

  it("reports interrupted for recovery events without a terminal review event", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, type: "round.started" }),
      baseEvent({ seq: 2, round: 1, source: "system", type: "run.recovery_blocked" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("interrupted");
  });

  it("lets a terminal review verdict override an interruption in the same round", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "system", type: "run.deadline_exceeded" }),
      baseEvent({ seq: 2, round: 1, source: "reviewer", type: "review.approved" }),
    ];

    expect(roundStatuses(events)[0].status).toBe("approved");
  });
});

describe("roundStatuses graceful degradation", () => {
  it("returns an empty list for empty input", () => {
    expect(roundStatuses([])).toEqual([]);
  });

  it("renders the run's current round as planned when it has no events yet", () => {
    const statuses = roundStatuses([], minimalRun({ round: 2 }));

    expect(statuses).toEqual([
      { round: 2, status: "planned", checks: { passed: 0, failed: 0 }, findings: { total: 0, resolved: 0 } },
    ]);
  });

  it("never throws on malformed meta and treats unknown findings as empty", () => {
    const events = [
      baseEvent({ round: 1, source: "reviewer", type: "review.changes_requested", meta: { findings: "not-an-array", checks: null } }),
    ];

    expect(() => roundStatuses(events)).not.toThrow();
    expect(roundStatuses(events)[0].findings).toEqual({ total: 0, resolved: 0 });
  });
});

describe("currentRoundStatus", () => {
  it("returns the highest round so later rounds override earlier ones", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 2, type: "round.started" }),
      baseEvent({ seq: 3, round: 2, source: "reviewer", type: "review.started" }),
    ];

    const statuses = roundStatuses(events);
    expect(currentRoundStatus(statuses)?.round).toBe(2);
  });

  it("returns undefined when there are no rounds", () => {
    expect(currentRoundStatus([])).toBeUndefined();
  });
});

describe("roundStatusTooltip", () => {
  it("formats the check and finding counts", () => {
    const events = [
      baseEvent({ seq: 1, round: 1, source: "checks", type: "checks.passed", meta: { checks: [{ status: "passed" }, { status: "passed" }] } }),
      baseEvent({ seq: 2, round: 1, source: "reviewer", type: "review.changes_requested", meta: { findings: [finding()] } }),
    ];

    expect(roundStatusTooltip(roundStatuses(events)[0])).toBe("检查 通过 2/失败 0 · 发现 1 项（已解决 0）");
  });
});

describe("branchStatus", () => {
  it("maps a rework branch to the next round's live status, not the returned round's", () => {
    const statuses = roundStatuses([
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 2, type: "round.started" }),
      baseEvent({ seq: 3, round: 2, source: "developer", type: "agent.repair_started" }),
    ]);

    const branch = branchStatus(statuses, 1);

    expect(branch.status?.round).toBe(2);
    expect(branch.status?.status).toBe("developing");
  });

  it("picks the nearest greater round when rounds are sparse", () => {
    const statuses = roundStatuses([
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 3, source: "reviewer", type: "review.started" }),
    ]);

    expect(branchStatus(statuses, 1).status?.round).toBe(3);
    expect(branchStatus(statuses, 1).status?.status).toBe("reviewing");
  });

  it("does not jump past an intermediate round to the latest one", () => {
    const statuses = roundStatuses([
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 2, source: "checks", type: "checks.started" }),
      baseEvent({ seq: 3, round: 3, source: "reviewer", type: "review.approved" }),
    ]);

    expect(branchStatus(statuses, 1).status?.round).toBe(2);
  });

  it("falls back to the latest current status when no later round exists yet", () => {
    const statuses = roundStatuses([
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 2, source: "checks", type: "checks.started" }),
    ]);

    const branch = branchStatus(statuses, 2);

    expect(branch.status?.round).toBe(2);
    expect(branch.status?.status).toBe("checking");
  });

  it("returns the tooltip of the round whose status is shown", () => {
    const statuses = roundStatuses([
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested", meta: { findings: [finding()] } }),
      baseEvent({ seq: 2, round: 2, source: "checks", type: "checks.passed", meta: { checks: [{ status: "passed" }, { status: "failed" }] } }),
    ]);

    const branch = branchStatus(statuses, 1);

    expect(branch.tooltip).toBe("检查 通过 1/失败 1 · 发现 0 项（已解决 0）");
    expect(branch.tooltip).toBe(roundStatusTooltip(statuses[1]));
  });

  it("returns an empty payload for empty input", () => {
    expect(branchStatus([], 1)).toEqual({});
    expect(branchStatus([], 1).status).toBeUndefined();
  });
});
