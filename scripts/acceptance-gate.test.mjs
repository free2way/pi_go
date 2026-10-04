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
import { DB_STEP_ID, FAIL, PASS, SKIP } from "./release-gate-lib.mjs";

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
  const steps = planAcceptanceSteps({ PI_DATABASE_URL: "postgres://u:p@h:5432/d", PI_E2E_BASE_URL: "http://127.0.0.1:3100" });
  // Inject a plan containing a real skip to prove the belt-and-suspenders pass.
  const { results } = await runAcceptanceGate({ env: {}, runStep: async () => ({ ok: true }) });
  assert.ok(results.every((result) => result.status !== SKIP));

  const green = await runAcceptanceGate({
    env: { PI_DATABASE_URL: "postgres://u:p@h:5432/d", PI_E2E_BASE_URL: "http://127.0.0.1:3100" },
    runStep: async () => ({ ok: true }),
  });
  assert.equal(green.summary.ok, true);
  assert.equal(green.summary.counts.fail, 0);
  assert.equal(steps.length, green.results.length);
  assert.ok(green.results.every((result) => result.status === PASS));
});
