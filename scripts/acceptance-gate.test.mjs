/**
 * Unit tests for the strict acceptance gate (v0.22).
 *
 * Run with `node --test` (`npm run test:scripts`, also covered by
 * `npm run test:config`-adjacent tooling). The gate's CLI body is guarded, so
 * importing the module only exposes the pure plan/parse helpers and
 * `runAcceptanceGate` with an injected runner.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { E2E_STEP_ID, parseEslintSummary, planAcceptanceSteps, runAcceptanceGate } from "./acceptance-gate.mjs";
import { ALLOW_REQUIRED_SKIPS_ENV, ALLOW_REQUIRED_SKIPS_REASON_ENV, REQUIRED_E2E_SCENARIOS, evaluateE2eSuite } from "./e2e-suite-result.mjs";
import { DB_STEP_ID, FAIL, PASS, SKIP } from "./release-gate-lib.mjs";

/** Synthetic Playwright JSON report: one status (or per-scenario status fn) for every required scenario. */
function syntheticReport(statusFor) {
  const statusOf = typeof statusFor === "function" ? statusFor : () => statusFor;
  return {
    config: {},
    suites: [
      {
        title: "acceptance.spec.ts",
        file: "acceptance.spec.ts",
        specs: REQUIRED_E2E_SCENARIOS.map((entry) => {
          const status = statusOf(entry);
          return {
            file: entry.file,
            title: `${entry.id} ${entry.summary}`,
            ok: status !== "unexpected",
            tests: [
              {
                status,
                projectName: "chromium",
                annotations: status === "skipped" ? [{ type: "fixme", description: "needs a live environment" }] : [],
              },
            ],
          };
        }),
      },
    ],
  };
}

const PREREQUISITES = {
  PI_DATABASE_URL: "postgres://DUMMY_USER:DUMMY_PASSWORD@example.com:5432/d",
  PI_E2E_BASE_URL: "http://127.0.0.1:3100",
};

/** Simulates the graded E2E runner while every other step stays green. */
const gradedE2eRunner = (statusFor, env) => async () => {
  const verdict = evaluateE2eSuite(syntheticReport(statusFor), { env });
  return { ok: verdict.ok, detail: verdict.detail, verdict };
};

test("parseEslintSummary reads the v0.22 eslint footer", () => {
  assert.deepEqual(parseEslintSummary("✖ 2 problems (0 errors, 2 warnings)"), { problems: 2, errors: 0, warnings: 2 });
});

test("parseEslintSummary handles singular forms and clean output", () => {
  assert.deepEqual(parseEslintSummary("✖ 1 problem (0 errors, 1 warning)"), { problems: 1, errors: 0, warnings: 1 });
  assert.equal(parseEslintSummary(""), undefined);
});

test("the database step is REQUIRED (command-less fail), never a skip", () => {
  const db = planAcceptanceSteps({}).find((step) => step.id === DB_STEP_ID);
  assert.notEqual(db.kind, "skip");
  assert.match(db.requiredReason, /PI_DATABASE_URL/);
});

test("the Playwright step is REQUIRED without PI_E2E_BASE_URL, and runs with it", () => {
  const missing = planAcceptanceSteps({}).find((step) => step.id === E2E_STEP_ID);
  assert.match(missing.requiredReason, /PI_E2E_BASE_URL/);
  // The local path (no base URL) must fail with something an operator can act on.
  assert.match(missing.requiredReason, /npm start/);
  assert.match(missing.requiredReason, /export PI_E2E_BASE_URL/);

  const present = planAcceptanceSteps({ PI_E2E_BASE_URL: "http://127.0.0.1:3100" }).find((step) => step.id === E2E_STEP_ID);
  assert.deepEqual(present.args, ["run", "e2e:browser"]);
  assert.equal(present.env.PI_E2E_BASE_URL, "http://127.0.0.1:3100");
});

test("runAcceptanceGate FAILs (not SKIPs) every missing prerequisite even with a green runner", async () => {
  const { results, summary } = await runAcceptanceGate({
    env: {},
    runStep: async () => ({ ok: true, detail: "ok" }),
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.counts.skip, 0, "the acceptance gate must not emit SKIP");
  const db = results.find((result) => result.id === DB_STEP_ID);
  const e2e = results.find((result) => result.id === E2E_STEP_ID);
  assert.equal(db.status, FAIL);
  assert.equal(e2e.status, FAIL);
  assert.match(db.detail, /REQUIRED/);
});

test("runAcceptanceGate promotes any residual SKIP to FAIL and stays green without one", async () => {
  const steps = planAcceptanceSteps({ PI_DATABASE_URL: "postgres://DUMMY_USER:DUMMY_PASSWORD@example.com:5432/d", PI_E2E_BASE_URL: "http://127.0.0.1:3100" });
  // Inject a plan containing a real skip to prove the belt-and-suspenders pass.
  const { results } = await runAcceptanceGate({ env: {}, runStep: async () => ({ ok: true }) });
  assert.ok(results.every((result) => result.status !== SKIP));

  const green = await runAcceptanceGate({
    env: { PI_DATABASE_URL: "postgres://DUMMY_USER:DUMMY_PASSWORD@example.com:5432/d", PI_E2E_BASE_URL: "http://127.0.0.1:3100" },
    runStep: async () => ({ ok: true }),
  });
  assert.equal(green.summary.ok, true);
  assert.equal(green.summary.counts.fail, 0);
  assert.equal(steps.length, green.results.length);
  assert.ok(green.results.every((result) => result.status === PASS));
});

test("runAcceptanceGate FAILs the E2E step when 0 scenarios executed (exit 0 is not evidence)", async () => {
  const gate = await runAcceptanceGate({
    env: PREREQUISITES,
    runStep: async () => ({ ok: true, detail: "ok" }),
    runE2eStep: gradedE2eRunner("skipped", PREREQUISITES),
  });
  const e2e = gate.results.find((result) => result.id === E2E_STEP_ID);
  assert.equal(e2e.status, FAIL);
  assert.match(e2e.detail, /executed=0 passed=0 failed=0 skipped=9/);
  assert.match(e2e.detail, /executed 0 scenarios/);
  assert.equal(gate.summary.ok, false);
  assert.equal(gate.e2e.counts.executed, 0, "the gate must expose the graded counts for the summary");
});

test("runAcceptanceGate FAILs when a required scenario is skipped and names it", async () => {
  const requiredEntry = (entry) => (entry.id === "E2E-04" ? "skipped" : "expected");
  const gate = await runAcceptanceGate({
    env: PREREQUISITES,
    runStep: async () => ({ ok: true, detail: "ok" }),
    runE2eStep: gradedE2eRunner(requiredEntry, PREREQUISITES),
  });
  const e2e = gate.results.find((result) => result.id === E2E_STEP_ID);
  assert.equal(e2e.status, FAIL);
  assert.match(e2e.detail, /E2E-04 \[fixme\]/);
  assert.equal(gate.summary.ok, false);
});

test("runAcceptanceGate PASSes a fully executed required set and prints the counts", async () => {
  const gate = await runAcceptanceGate({
    env: PREREQUISITES,
    runStep: async () => ({ ok: true, detail: "ok" }),
    runE2eStep: gradedE2eRunner("expected", PREREQUISITES),
  });
  assert.equal(gate.summary.ok, true);
  assert.equal(gate.e2e.override.enabled, false);
  assert.match(gate.e2e.lines[0], /^E2E suite: executed=9 passed=9 failed=0 skipped=0/);
  assert.ok(gate.e2e.lines.some((line) => line.startsWith("E2E required scenarios: 9/9 present, 0 not executed")));
});

test("runAcceptanceGate honours the documented override and keeps its reason visible", async () => {
  const reason = "release 0.27: live acceptance environment pending";
  const env = { ...PREREQUISITES, [ALLOW_REQUIRED_SKIPS_ENV]: "1", [ALLOW_REQUIRED_SKIPS_REASON_ENV]: reason };
  const gate = await runAcceptanceGate({
    env,
    runStep: async () => ({ ok: true, detail: "ok" }),
    runE2eStep: gradedE2eRunner((entry) => (entry.id === "E2E-01a" ? "expected" : "skipped"), env),
  });
  assert.equal(gate.summary.ok, true, "the override waives required-scenario skips");
  assert.equal(gate.e2e.override.enabled, true);
  assert.ok(gate.e2e.lines.some((line) => line.includes(`reason: ${reason}`)), "the override reason must be printed");
  assert.match(gate.e2e.detail, /override PI_E2E_ALLOW_REQUIRED_SKIPS=1/);
});
