import { describe, expect, it } from "vitest";
import type { Finding, RoundSummary } from "../shared/types";
import type { RoundStatus } from "../shared/round-status";
import {
  resolveReworkRounds,
  roundStatusKey,
  roundStatusLabel,
  roundStatusTooltipText,
  resolveRoundStatuses,
  reworkBranchDetailsFromSummaries,
  reworkRoundsFromSummaries,
  roundStatusesFromSummaries,
  roundStatusFromSummary,
} from "./rounds-view";

const summary = (overrides: Partial<RoundSummary> = {}): RoundSummary => ({
  round: 1,
  verdict: "none",
  checks: { passed: 0, failed: 0 },
  findings: { total: 0, resolved: 0 },
  interrupted: false,
  ...overrides,
});

const eventStatus = (overrides: Partial<RoundStatus> = {}): RoundStatus => ({
  round: 1,
  status: "developing",
  checks: { passed: 0, failed: 0 },
  findings: { total: 0, resolved: 0 },
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "f1",
  severity: "high",
  file: "src/a.ts",
  line: 1,
  title: "问题",
  evidence: "e",
  requiredChange: "fix",
  resolved: false,
  ...overrides,
});

describe("round status catalog mapping", () => {
  it("maps every workflow status to a locale-neutral key", () => {
    expect(roundStatusKey("approved")).toBe("roundStatus.approved");
    expect(roundStatusKey("changes_requested")).toBe("roundStatus.changes_requested");
    expect(roundStatusKey("planned")).toBe("roundStatus.planned");
    expect(roundStatusLabel("approved")).toBe("审核通过");
    expect(roundStatusLabel("approved", "en")).toBe("Review passed");
  });

  it("localizes the check/finding tooltip", () => {
    const status = eventStatus({ checks: { passed: 3, failed: 1 }, findings: { total: 2, resolved: 1 } });
    expect(roundStatusTooltipText(status)).toBe("检查 通过 3/失败 1 · 发现 2 项（已解决 1）");
    expect(roundStatusTooltipText(status, "en")).toContain("passed 3/failed 1");
  });
});

describe("roundStatusFromSummary", () => {
  it("maps the verdict, counts and timestamps from the summary", () => {
    const status = roundStatusFromSummary(summary({
      round: 4,
      verdict: "changes_requested",
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:05:00.000Z",
      checks: { passed: 3, failed: 1 },
      findings: { total: 2, resolved: 1 },
    }));

    expect(status).toEqual({
      round: 4,
      status: "changes_requested",
      checks: { passed: 3, failed: 1 },
      findings: { total: 2, resolved: 1 },
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:05:00.000Z",
    });
  });

  it("marks an approved summary as approved and an interruption as interrupted", () => {
    expect(roundStatusFromSummary(summary({ verdict: "approved" })).status).toBe("approved");
    expect(roundStatusFromSummary(summary({ verdict: "none", interrupted: true })).status).toBe("interrupted");
  });

  it("reuses the live event stage for a round with no verdict yet", () => {
    expect(roundStatusFromSummary(summary({ round: 2 }), eventStatus({ round: 2, status: "reviewing" })).status).toBe("reviewing");
    // A stale event-derived terminal verdict never overrides the server's `none`.
    expect(roundStatusFromSummary(summary({ round: 2 }), eventStatus({ round: 2, status: "approved" })).status).toBe("planned");
    expect(roundStatusFromSummary(summary({ round: 2 })).status).toBe("planned");
  });
});

describe("roundStatusesFromSummaries", () => {
  it("renders every summary round even when the event window only holds the latest", () => {
    const statuses = roundStatusesFromSummaries(
      [
        summary({ round: 1, verdict: "changes_requested" }),
        summary({ round: 2, verdict: "changes_requested" }),
        summary({ round: 3, verdict: "changes_requested" }),
        summary({ round: 10, verdict: "changes_requested" }),
      ],
      [eventStatus({ round: 10, status: "changes_requested" })],
    );

    expect(statuses.map((status) => status.round)).toEqual([1, 2, 3, 10]);
    expect(statuses.map((status) => status.status)).toEqual(["changes_requested", "changes_requested", "changes_requested", "changes_requested"]);
  });

  it("keeps the summary authoritative for a round and appends event-only newer rounds", () => {
    const statuses = roundStatusesFromSummaries(
      [summary({ round: 1, verdict: "changes_requested", checks: { passed: 2, failed: 0 } })],
      [eventStatus({ round: 1, status: "developing" }), eventStatus({ round: 2, status: "checking" })],
    );

    expect(statuses.map((status) => status.round)).toEqual([1, 2]);
    expect(statuses[0].status).toBe("changes_requested");
    expect(statuses[0].checks).toEqual({ passed: 2, failed: 0 });
    expect(statuses[1].status).toBe("checking");
  });
});

describe("reworkRoundsFromSummaries", () => {
  it("returns the rounds whose summary carries a changes_requested verdict", () => {
    const rounds = reworkRoundsFromSummaries([
      summary({ round: 1, verdict: "changes_requested" }),
      summary({ round: 2, verdict: "approved" }),
      summary({ round: 3, verdict: "changes_requested" }),
      summary({ round: 10, verdict: "changes_requested" }),
    ]);

    expect(rounds).toEqual([1, 3, 10]);
  });

  it("unions a return round that only the live event window knows about", () => {
    expect(reworkRoundsFromSummaries([summary({ round: 1, verdict: "changes_requested" })], [2])).toEqual([1, 2]);
  });
});

describe("event fallback", () => {
  const events = [eventStatus({ round: 1, status: "changes_requested" })];
  const returns = [1];

  it("uses the event-derived model when the summary endpoint is unavailable", () => {
    expect(resolveRoundStatuses(undefined, events)).toBe(events);
    expect(resolveReworkRounds(undefined, returns)).toBe(returns);
  });

  it("uses the summary model when it is present", () => {
    const summaries = [summary({ round: 1, verdict: "changes_requested" })];
    expect(resolveRoundStatuses(summaries, events)[0].status).toBe("changes_requested");
    expect(resolveReworkRounds(summaries, returns)).toEqual([1]);
  });
});

describe("reworkBranchDetailsFromSummaries", () => {
  it("prefers the summary reason when the original event is outside the window", () => {
    const details = reworkBranchDetailsFromSummaries(
      [summary({ round: 1, verdict: "changes_requested", reason: "第 1 轮退回（来自服务端）", finishedAt: "2026-10-01T00:05:00.000Z" })],
      [finding({ id: "a", firstSeenRound: 1 })],
      [],
    );

    expect(details).toHaveLength(1);
    expect(details[0].round).toBe(1);
    expect(details[0].reason).toBe("第 1 轮退回（来自服务端）");
    expect(details[0].at).toBe("2026-10-01T00:05:00.000Z");
    expect(details[0].findings.map((item) => item.id)).toEqual(["a"]);
  });

  it("falls back to the event detail reason when the summary has none", () => {
    const details = reworkBranchDetailsFromSummaries(
      [summary({ round: 2, verdict: "changes_requested" })],
      [],
      [{ round: 2, reason: "事件里的退回原因", at: "2026-10-02T00:00:00.000Z", findings: [], summary: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, top: [] } }],
    );

    expect(details[0].reason).toBe("事件里的退回原因");
    expect(details[0].at).toBe("2026-10-02T00:00:00.000Z");
  });

  it("localizes the missing-reason fallback", () => {
    const zh = reworkBranchDetailsFromSummaries([summary({ round: 3, verdict: "changes_requested" })]);
    const en = reworkBranchDetailsFromSummaries([summary({ round: 3, verdict: "changes_requested" })], [], [], "en");
    expect(zh[0].reason).toBe("（未记录退回原因）");
    expect(en[0].reason).toBe("(no return reason recorded)");
  });

  it("keeps a return round the summary does not cover", () => {
    const details = reworkBranchDetailsFromSummaries(
      [summary({ round: 1, verdict: "changes_requested", reason: "r1" })],
      [],
      [{ round: 5, reason: "r5", findings: [], summary: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, top: [] } }],
    );

    expect(details.map((detail) => detail.round)).toEqual([1, 5]);
    expect(details[1].reason).toBe("r5");
  });
});
