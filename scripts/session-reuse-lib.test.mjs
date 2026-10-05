/**
 * Unit tests for the Sprint 2 session-reuse report helpers.
 *
 * Run with `node --test` (`npm run test:scripts`). Vitest only collects
 * `src/**`, so this lib is tested here instead of under src/.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_EVENT_TYPE,
  aggregateRows,
  buildRunReport,
  buildReports,
  describeDatabaseTarget,
  normalizeSessionEvent,
  parseReportConfig,
  renderReport,
  renderRunReport,
} from "./session-reuse-lib.mjs";

const metric = (over = {}) => ({
  round: over.round ?? 1,
  type: SESSION_EVENT_TYPE,
  meta: {
    sessionId: over.sessionId ?? "run-abc-developer",
    role: over.role ?? "developer",
    resumed: over.resumed ?? false,
    durationMs: over.durationMs ?? 1000,
    inputTokens: over.inputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    cacheReadTokens: over.cacheReadTokens ?? 0,
    cacheWriteTokens: over.cacheWriteTokens ?? 0,
    modelCalls: over.modelCalls ?? 1,
    ...(over.estimatedCost === undefined ? {} : { estimatedCost: over.estimatedCost }),
  },
});

test("parseReportConfig prefers the database and refuses without any source", () => {
  const db = parseReportConfig({ PI_DATABASE_URL: "postgres://user:secret@db:5432/pigo" });
  assert.equal(db.ok, true);
  assert.equal(db.mode, "db");
  assert.equal(db.databaseUrl, "postgres://user:secret@db:5432/pigo");

  const api = parseReportConfig({ PI_REPORT_BASE_URL: "http://127.0.0.1:3100" });
  assert.equal(api.mode, "api");
  assert.equal(api.email, "developer@localhost");
  assert.equal(parseReportConfig({ PI_REPORT_BASE_URL: "http://x", PI_REPORT_EMAIL: "ops@example.com" }).email, "ops@example.com");

  const missing = parseReportConfig({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /PI_DATABASE_URL/);
  assert.match(missing.error, /PI_REPORT_BASE_URL/);
});

test("describeDatabaseTarget never leaks credentials", () => {
  const target = describeDatabaseTarget("postgres://user:sup3r-secret@db.example.com:5432/pigo");
  assert.equal(target, "pigo @ db.example.com:5432");
  assert.ok(!target.includes("sup3r-secret"));
  assert.ok(!target.includes("user"));
  assert.equal(describeDatabaseTarget("not a url"), "(unparseable connection string)");
});

test("normalizeSessionEvent keeps well-formed metrics and ignores everything else", () => {
  const row = normalizeSessionEvent(metric({ round: 2, resumed: true, inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, estimatedCost: 0.02 }));
  assert.deepEqual(row, {
    round: 2,
    rounds: [2],
    role: "developer",
    sessionId: "run-abc-developer",
    resumed: true,
    durationMs: 1000,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    modelCalls: 1,
    cost: 0.02,
    source: "events",
  });
  assert.equal(normalizeSessionEvent({ type: "agent.activity", round: 1, meta: {} }), undefined);
  assert.equal(normalizeSessionEvent({ type: SESSION_EVENT_TYPE, round: 1, meta: {} }), undefined);
});

test("buildRunReport ignores single-round runs and runs without session metrics", () => {
  assert.equal(buildRunReport({ id: "r1", round: 1, events: [metric()] }), undefined);
  assert.equal(buildRunReport({ id: "r2", round: 3, sessions: [], events: [] }), undefined);
});

test("buildRunReport derives per-round rows and the round-1 vs later comparison", () => {
  const run = {
    id: "run_abc",
    round: 2,
    usage: { estimatedCost: 0.09 },
    events: [
      // Round 1: fresh developer session — 0 cache reads.
      metric({ round: 1, inputTokens: 1000, outputTokens: 200, estimatedCost: 0.03 }),
      // Round 2: the same session resumed — mostly cache reads.
      metric({ round: 2, resumed: true, inputTokens: 100, outputTokens: 200, cacheReadTokens: 900, estimatedCost: 0.01 }),
      // Reviewer is fresh every round.
      metric({ round: 2, sessionId: "run-abc-review-r2", role: "reviewer", inputTokens: 400, outputTokens: 100, estimatedCost: 0.02 }),
    ],
  };
  const report = buildRunReport(run);
  assert.equal(report.costBasis, "session-events");
  assert.equal(report.rows.length, 3);
  assert.deepEqual(report.rows.map((row) => row.round), [1, 2, 2]);

  // cacheRead share: round 1 = 0; later = 900 / (500 + 900 + ...) across both later rows.
  assert.equal(report.comparison.round1.cacheReadShare, 0);
  assert.ok(report.comparison.later.cacheReadShare > 0.4);
  assert.ok(report.comparison.later.cacheReadShare > report.comparison.round1.cacheReadShare);
  assert.equal(report.comparison.resumed.later.cacheReadShare, report.rows[1].cacheReadTokens / (100 + 200 + 900));
  // Round 1 has no resumed session by definition.
  assert.equal(report.comparison.resumed.round1.rows, 0);
  assert.equal(report.totals.cost, 0.06);
  assert.equal(report.totals.costPerRound, 0.03);
});

test("buildRunReport falls back to run.sessions and allocates the run total by tokens", () => {
  const run = {
    id: "run_sum",
    round: 3,
    usage: { estimatedCost: 0.3 },
    sessions: [
      {
        sessionId: "run-sum-developer",
        role: "developer",
        rounds: [1, 2, 3],
        calls: 3,
        resumed: true,
        durationMs: 3000,
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        modelCalls: 3,
      },
      {
        sessionId: "run-sum-review-r3",
        role: "reviewer",
        rounds: [3],
        calls: 1,
        resumed: false,
        durationMs: 1000,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelCalls: 1,
      },
    ],
  };
  const report = buildRunReport(run);
  assert.equal(report.source, "sessions");
  assert.equal(report.costBasis, "run-total");
  assert.equal(report.rows.length, 2);
  assert.equal(report.totals.cost, 0.3);
  // The developer session holds all 1000 tokens → all of the allocated cost.
  const developer = report.rows.find((row) => row.sessionId === "run-sum-developer");
  assert.equal(developer.cost, 0.3);
  assert.equal(developer.rounds.length, 3);
  // No per-round events, so the round-1 vs later comparison is honestly n/a.
  assert.equal(report.comparison, null);
  const rendered = renderRunReport(report);
  assert.ok(rendered.includes("allocate the run total"));
  assert.ok(rendered.includes("round-1 vs later: n/a"));
});

test("buildRunReport marks a partially-costed run and counts missing cost as zero", () => {
  const report = buildRunReport({
    id: "run_partial",
    round: 2,
    events: [
      metric({ round: 1, inputTokens: 10, estimatedCost: 0.05 }),
      metric({ round: 2, sessionId: "run-partial-review-r2", role: "reviewer", inputTokens: 10 }),
    ],
  });
  assert.equal(report.costBasis, "session-events-partial");
  assert.equal(report.totals.cost, 0.05);
  assert.ok(renderRunReport(report).includes("carried no cost"));
});

test("buildRunReport reports unavailable cost without inventing one", () => {  const report = buildRunReport({
    id: "run_nocost",
    round: 2,
    usage: {},
    events: [metric({ round: 2, resumed: true, inputTokens: 5 })],
  });
  assert.equal(report.costBasis, "unavailable");
  assert.equal(report.totals.cost, null);
  assert.equal(report.totals.costPerRound, null);
  assert.ok(renderRunReport(report).includes("no cost recorded"));
});

test("buildRunReport merges repeated calls of one round/role/session", () => {
  const report = buildRunReport({
    id: "run_merge",
    round: 2,
    events: [
      metric({ round: 2, resumed: true, inputTokens: 10, outputTokens: 1, modelCalls: 1, estimatedCost: 0.01 }),
      metric({ round: 2, resumed: true, inputTokens: 5, outputTokens: 1, modelCalls: 1, estimatedCost: 0.02 }),
    ],
  });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].inputTokens, 15);
  assert.equal(report.rows[0].modelCalls, 2);
  assert.equal(report.rows[0].cost, 0.03);
});

test("aggregateRows computes cacheRead share over all tokens and null cost on partial data", () => {
  const aggregate = aggregateRows([
    { inputTokens: 50, outputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0, modelCalls: 1, durationMs: 1, rounds: [1], cost: 0.01 },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 1, durationMs: 1, rounds: [2], cost: null },
  ]);
  assert.equal(aggregate.totalTokens, 100);
  assert.equal(aggregate.cacheReadShare, 0.5);
  assert.equal(aggregate.cost, null);
  assert.equal(aggregate.costPerRound, null);
});

test("buildReports excludes ineligible runs and counts them as skipped", () => {
  const { reports, skipped, considered } = buildReports([
    { id: "a", round: 1, events: [metric()] },
    { id: "b", round: 2, events: [metric({ round: 2, resumed: true })] },
    { id: "c", round: 4, events: [] },
  ]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].runId, "b");
  assert.equal(skipped, 2);
  assert.equal(considered, 3);
});

test("renderReport gives an explicit note when there is no data", () => {
  const text = renderReport([]);
  assert.match(text, /No runs with ≥2 rounds and session metrics/);
  const withData = renderReport([
    buildRunReport({ id: "run_x", round: 2, usage: { estimatedCost: 0.01 }, events: [metric({ round: 2, resumed: true, inputTokens: 7 })] }),
  ]);
  assert.match(withData, /Session reuse report — 1 run\(s\)/);
  assert.match(withData, /run run_x/);
  assert.match(withData, /round-1 vs later/);
});
