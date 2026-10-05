import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db.js";
import { buildRoundSummaries, readRunRounds, ROUNDS_SCHEMA_VERSION, type RoundCheckRow, type RoundEventAggregateRow } from "./run-rounds.js";

const eventRow = (overrides: Partial<RoundEventAggregateRow>): RoundEventAggregateRow => ({
  round: 1,
  started_at: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

describe("buildRoundSummaries (pure)", () => {
  it("exposes the response schema version", () => {
    expect(ROUNDS_SCHEMA_VERSION).toBe(1);
  });

  it("maps the aggregate row into a changes_requested summary with reason and times", () => {
    const summaries = buildRoundSummaries({
      eventRows: [eventRow({
        round: 1,
        started_at: "2026-10-04T10:00:00.000Z",
        changes_requested_at: "2026-10-04T10:05:00.000Z",
        has_changes_requested: 1,
      })],
      reasonRows: [{ round: 1, seq: 3, message: "审核发现 2 个问题，退回 Developer" }],
    });

    expect(summaries).toEqual([{
      round: 1,
      verdict: "changes_requested",
      startedAt: "2026-10-04T10:00:00.000Z",
      finishedAt: "2026-10-04T10:05:00.000Z",
      reason: "审核发现 2 个问题，退回 Developer",
      checks: { passed: 0, failed: 0 },
      findings: { total: 0, resolved: 0 },
      interrupted: false,
    }]);
  });

  it("ranks an approved verdict above a changes_requested one in the same round", () => {
    const summaries = buildRoundSummaries({
      eventRows: [eventRow({
        round: 2,
        approved_at: "2026-10-04T11:00:00.000Z",
        changes_requested_at: "2026-10-04T10:30:00.000Z",
        has_approved: true,
        has_changes_requested: true,
      })],
    });

    expect(summaries[0].verdict).toBe("approved");
    expect(summaries[0].finishedAt).toBe("2026-10-04T11:00:00.000Z");
  });

  it("reports interrupted only when a deadline/recovery row has no review verdict", () => {
    const interrupted = buildRoundSummaries({
      eventRows: [eventRow({ round: 3, has_interrupt: 1 })],
    });
    expect(interrupted[0].verdict).toBe("none");
    expect(interrupted[0].interrupted).toBe(true);

    const verdictWins = buildRoundSummaries({
      eventRows: [eventRow({ round: 3, has_interrupt: 1, has_approved: 1, approved_at: "2026-10-04T12:00:00.000Z" })],
    });
    expect(verdictWins[0].verdict).toBe("approved");
    expect(verdictWins[0].interrupted).toBe(false);
  });

  it("keeps sparse/out-of-order rounds sorted ascending and fills missing gaps without inventing them", () => {
    const summaries = buildRoundSummaries({
      eventRows: [
        eventRow({ round: 10, has_changes_requested: 1 }),
        eventRow({ round: 1, has_changes_requested: 1 }),
        eventRow({ round: 3, has_interrupt: 1 }),
      ],
    });

    expect(summaries.map((summary) => summary.round)).toEqual([1, 3, 10]);
  });

  it("ignores unknown event types (round exists, no known verdict/interrupt flags)", () => {
    const summaries = buildRoundSummaries({
      eventRows: [eventRow({ round: 4, started_at: "2026-10-04T09:00:00.000Z" })],
    });

    expect(summaries).toEqual([expect.objectContaining({
      round: 4,
      verdict: "none",
      interrupted: false,
      startedAt: "2026-10-04T09:00:00.000Z",
      checks: { passed: 0, failed: 0 },
      findings: { total: 0, resolved: 0 },
    })]);
  });

  it("takes the latest check snapshot in a round and the checkPassed fallback", () => {
    const checkRows: RoundCheckRow[] = [
      { round: 1, seq: 1, type: "checks.started", meta_json: JSON.stringify({ checks: [{ status: "running" }] }) },
      { round: 1, seq: 2, type: "checks.passed", meta_json: JSON.stringify({ checks: [{ status: "passed" }, { status: "passed" }, { status: "failed" }] }) },
      { round: 2, seq: 3, type: "checks.returned", meta_json: JSON.stringify({ checkPassed: false }) },
    ];

    const summaries = buildRoundSummaries({ eventRows: [eventRow({ round: 1 }), eventRow({ round: 2 })], checkRows });

    expect(summaries.find((summary) => summary.round === 1)?.checks).toEqual({ passed: 2, failed: 1 });
    expect(summaries.find((summary) => summary.round === 2)?.checks).toEqual({ passed: 0, failed: 1 });
  });

  it("aggregates findings and clamps malformed counts", () => {
    const summaries = buildRoundSummaries({
      eventRows: [eventRow({ round: 1 })],
      findingRows: [{ round: 1, total: "3", resolved: 1 }, { round: "bad", total: 9 }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].findings).toEqual({ total: 3, resolved: 1 });
  });

  it("adds the run's current round as a planned marker when it has no events yet", () => {
    const summaries = buildRoundSummaries({
      eventRows: [eventRow({ round: 1, has_changes_requested: 1 })],
      currentRound: 2,
    });

    expect(summaries.map((summary) => [summary.round, summary.verdict])).toEqual([[1, "changes_requested"], [2, "none"]]);
  });

  it("returns an empty list for an empty run", () => {
    expect(buildRoundSummaries({})).toEqual([]);
    expect(buildRoundSummaries({ eventRows: [], reasonRows: [], checkRows: [], findingRows: [] })).toEqual([]);
  });

  it("never throws on malformed rows", () => {
    expect(() => buildRoundSummaries({
      eventRows: [{ round: null }, { round: -1 }, { round: "x" }],
      checkRows: [{ round: 1, meta_json: "{not json" }],
      reasonRows: [{ round: 1, message: "" }],
      findingRows: [{ round: 1, total: "nope", resolved: null }],
    })).not.toThrow();
  });
});

describe("readRunRounds (pg-mem)", () => {
  it("aggregates all rounds from run_events + run_findings regardless of event volume", async () => {
    const db = await createTestDb();
    const runId = "run_rounds";
    const insertEvent = (seq: number, round: number, type: string, message: string, at: string, meta?: Record<string, unknown>) =>
      db.query(
        "INSERT INTO run_events (run_id, seq, at, round, source, type, message, meta_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [runId, seq, at, round, type === "review.changes_requested" ? "reviewer" : "system", type, message, meta ? JSON.stringify(meta) : null],
      );

    // Rounds 1, 2, 3 and 10 were all returned by the reviewer; fill with noise so
    // the test also proves the aggregation is not order/window dependent.
    await insertEvent(1, 1, "round.started", "round 1", "2026-10-01T00:00:00.000Z");
    await insertEvent(2, 1, "review.changes_requested", "第 1 轮退回", "2026-10-01T00:05:00.000Z");
    await insertEvent(3, 2, "review.changes_requested", "第 2 轮退回", "2026-10-01T00:10:00.000Z");
    await insertEvent(4, 2, "checks.passed", "checks", "2026-10-01T00:11:00.000Z", { checks: [{ status: "passed" }, { status: "passed" }] });
    await insertEvent(5, 3, "review.changes_requested", "第 3 轮退回", "2026-10-01T00:20:00.000Z");
    for (let seq = 6; seq < 400; seq += 1) {
      await insertEvent(seq, 3, "tool.output", `noise ${seq}`, "2026-10-01T00:20:01.000Z");
    }
    await insertEvent(400, 10, "review.changes_requested", "第 10 轮退回", "2026-10-01T01:00:00.000Z");
    await insertEvent(401, 10, "run.deadline_exceeded", "deadline", "2026-10-01T01:05:00.000Z");

    await db.query(
      "INSERT INTO run_findings (run_id, finding_id, severity, file, line, title, resolved, first_seen_round, last_seen_round) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [runId, "f1", "high", "src/a.ts", 1, "问题", 0, 1, 1],
    );
    await db.query(
      "INSERT INTO run_findings (run_id, finding_id, severity, file, line, title, resolved, first_seen_round, last_seen_round) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [runId, "f2", "low", "src/b.ts", 2, "问题2", 1, 3, 3],
    );

    const rounds = await readRunRounds(db, runId);

    expect(rounds.map((summary) => summary.round)).toEqual([1, 2, 3, 10]);
    for (const round of [1, 2, 3, 10]) {
      expect(rounds.find((summary) => summary.round === round)?.verdict).toBe("changes_requested");
    }
    expect(rounds.find((summary) => summary.round === 1)?.reason).toBe("第 1 轮退回");
    expect(rounds.find((summary) => summary.round === 3)?.reason).toBe("第 3 轮退回");
    expect(rounds.find((summary) => summary.round === 2)?.checks).toEqual({ passed: 2, failed: 0 });
    expect(rounds.find((summary) => summary.round === 1)?.findings).toEqual({ total: 1, resolved: 0 });
    expect(rounds.find((summary) => summary.round === 3)?.findings).toEqual({ total: 1, resolved: 1 });
    // A verdict outranks the deadline event recorded in the same round.
    expect(rounds.find((summary) => summary.round === 10)?.interrupted).toBe(false);
  });

  it("returns only the current round (planned) for a run with no events", async () => {
    const db = await createTestDb();
    expect(await readRunRounds(db, "run_empty")).toEqual([]);
    expect((await readRunRounds(db, "run_empty", 1)).map((summary) => [summary.round, summary.verdict])).toEqual([[1, "none"]]);
  });

  it("keeps a round interrupted when no verdict was recorded", async () => {
    const db = await createTestDb();
    await db.query(
      "INSERT INTO run_events (run_id, seq, at, round, source, type, message) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      ["run_interrupt", 1, "2026-10-01T00:00:00.000Z", 5, "system", "run.recovery_failed", "recovery failed"],
    );

    const rounds = await readRunRounds(db, "run_interrupt");

    expect(rounds).toEqual([expect.objectContaining({ round: 5, verdict: "none", interrupted: true })]);
  });
});
