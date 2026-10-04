/**
 * Unit tests for the release-gate helper.
 *
 * Run with `npm run test:scripts` (node --test). Vitest only collects `src/**`,
 * and this task must not touch `src/**`, so node's built-in runner is used
 * instead of adding a vitest-collected file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DB_STEP_ID,
  FAIL,
  PASS,
  SKIP,
  executeGate,
  planGateSteps,
  renderGateTable,
  summarizeResults,
} from "./release-gate-lib.mjs";

test("planGateSteps runs the six fixed checks in order", () => {
  const steps = planGateSteps({});
  assert.deepEqual(
    steps.slice(0, 6).map((step) => step.id),
    ["typecheck", "test", "lint", "build", "validate-compose", "scan-secrets"],
  );
});

test("planGateSteps SKIPs the database check with an explicit reason when no URL is set", () => {
  const dbStep = planGateSteps({}).find((step) => step.id === DB_STEP_ID);
  assert.ok(dbStep, "database step must be present as a skip");
  assert.equal(dbStep.kind, "skip");
  assert.match(dbStep.reason, /PI_DATABASE_URL/);
  assert.ok(!("command" in dbStep), "a skipped step must not carry a command");
});

test("planGateSteps includes the database check when PI_DATABASE_URL is set", () => {
  const dbStep = planGateSteps({ PI_DATABASE_URL: "postgres://user:pass@db:5432/pigo" }).find(
    (step) => step.id === DB_STEP_ID,
  );
  assert.equal(dbStep.kind, "command");
  assert.deepEqual(dbStep.args, ["run", "test:pg:concurrency"]);
  assert.equal(dbStep.env.PI_DATABASE_URL, "postgres://user:pass@db:5432/pigo");
});

test("planGateSteps accepts DATABASE_URL as a fallback", () => {
  const dbStep = planGateSteps({ DATABASE_URL: "postgres://user:change-me@host:5432/d" }).find(
    (step) => step.id === DB_STEP_ID,
  );
  assert.equal(dbStep.kind, "command");
  assert.equal(dbStep.env.DATABASE_URL, "postgres://user:change-me@host:5432/d");
  assert.equal(dbStep.env.PI_DATABASE_URL, "");
});

test("summarizeResults: all PASS exits 0", () => {
  const summary = summarizeResults([
    { id: "a", status: PASS },
    { id: "b", status: PASS },
    { id: "c", status: SKIP },
  ]);
  assert.deepEqual(summary.counts, { pass: 2, fail: 0, skip: 1 });
  assert.equal(summary.ok, true);
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.failedIds, []);
});

test("summarizeResults: any FAIL exits non-zero and lists the failures", () => {
  const summary = summarizeResults([
    { id: "a", status: PASS },
    { id: "b", status: FAIL, detail: "exit 1" },
    { id: DB_STEP_ID, status: SKIP },
  ]);
  assert.equal(summary.ok, false);
  assert.notEqual(summary.exitCode, 0);
  assert.deepEqual(summary.failedIds, ["b"]);
});

test("summarizeResults: SKIP alone is green", () => {
  const summary = summarizeResults([{ id: DB_STEP_ID, status: SKIP }]);
  assert.equal(summary.ok, true);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.counts.skip, 1);
});

test("executeGate maps runner outcomes and never turns a SKIP into a PASS", async () => {
  const steps = planGateSteps({});
  const seen = [];
  const results = await executeGate(steps, {
    runStep: async (step) => {
      seen.push(step.id);
      if (step.id === "lint") return { ok: false, detail: "exit 1 (0.1s)" };
      return { ok: true, detail: "exit 0 (0.1s)" };
    },
  });
  // The skip step is not handed to the runner, but the command steps are.
  assert.ok(!seen.includes(DB_STEP_ID));
  assert.equal(results.filter((result) => result.status === PASS).length, 5);
  const dbResult = results.find((result) => result.id === DB_STEP_ID);
  assert.equal(dbResult.status, SKIP);
  assert.match(dbResult.detail, /no database is touched/);
  assert.equal(summarizeResults(results).exitCode, 1);
});

test("executeGate converts a throwing runner into a FAIL and keeps going", async () => {
  const results = await executeGate(planGateSteps({}), {
    runStep: async (step) => {
      if (step.id === "build") throw new Error("spawn ENOENT");
      return { ok: true };
    },
  });
  const build = results.find((result) => result.id === "build");
  assert.equal(build.status, FAIL);
  assert.match(build.detail, /ENOENT/);
  // Subsequent steps still ran (six command steps + one skip).
  assert.equal(results.length, 7);
});

test("renderGateTable contains every id, status and detail", () => {
  const table = renderGateTable([
    { id: "typecheck", status: PASS, detail: "exit 0 (2.0s)" },
    { id: "lint", status: FAIL, detail: "exit 1 (0.5s)" },
    { id: "pg-concurrency", status: SKIP, detail: "PI_DATABASE_URL / DATABASE_URL not set" },
  ]);
  assert.match(table, /id\s+status\s+detail/);
  assert.match(table, /typecheck\s+PASS\s+exit 0/);
  assert.match(table, /lint\s+FAIL\s+exit 1/);
  assert.match(table, /pg-concurrency\s+SKIP/);
});
