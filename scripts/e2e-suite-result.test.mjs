/**
 * Unit tests for the acceptance gate's E2E verdict (P1 audit fix, v0.27).
 *
 * Run with `node --test` (`npm run test:scripts`). Every case drives the pure
 * decision logic with a synthetic Playwright JSON report, so no browser, server
 * or database is involved.
 *
 * The contract under test:
 *   - 0 executed scenarios ⇒ FAIL (an all-skipped/`fixme` suite is not evidence)
 *   - a required scenario skipped/fixme/todo ⇒ FAIL naming the scenario
 *   - every required scenario executed ⇒ PASS
 *   - the documented override waives required skips and prints its reason
 *   - the override is strictly parsed (only "1" + a non-empty reason)
 *   - a required scenario missing from the report ⇒ FAIL
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  ALLOW_REQUIRED_SKIPS_ENV,
  ALLOW_REQUIRED_SKIPS_REASON_ENV,
  REQUIRED_E2E_SCENARIOS,
  collectSpecs,
  evaluateE2eSuite,
  parseRequiredSkipOverride,
  runE2eStep,
} from "./e2e-suite-result.mjs";

/** One Playwright spec entry (file + title + single-project test result). */
function spec(file, title, status, annotations = []) {
  return { file, title, ok: status !== "unexpected", tests: [{ status, projectName: "chromium", annotations }] };
}

/** A `test.fixme`/`test.skip` annotation as the json reporter records it. */
const skipAnnotation = (type, reason) => [{ type, description: reason }];
/** Report shape produced by `--reporter=json` (one file suite per spec file). */
const report = (specs) => ({ config: {}, suites: [{ title: "acceptance.spec.ts", file: "acceptance.spec.ts", specs }] });

/** The docs/05 §13 required scenarios, each with the status the case wants. */
function requiredSpecs(statusFor) {
  return REQUIRED_E2E_SCENARIOS.map((entry) => {
    const { status, annotations = [] } = statusFor(entry);
    return spec(entry.file, `${entry.id} ${entry.summary}`, status, annotations);
  });
}

const allPassed = () => ({ status: "expected" });
const allFixme = () => ({ status: "skipped", annotations: skipAnnotation("fixme", "生产验收场景需要真实环境") });
const overrideEnv = (reason) => ({
  [ALLOW_REQUIRED_SKIPS_ENV]: "1",
  [ALLOW_REQUIRED_SKIPS_REASON_ENV]: reason,
});

test("an all-skipped/fixme suite FAILs: 0 executed scenarios is not evidence", () => {
  const verdict = evaluateE2eSuite(report(requiredSpecs(allFixme)), { env: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.counts.executed, 0);
  assert.equal(verdict.counts.skipped, REQUIRED_E2E_SCENARIOS.length);
  assert.match(verdict.detail, /executed=0/);
  assert.match(verdict.detail, /executed 0 scenarios/);
  assert.ok(
    verdict.lines.some((line) => line.startsWith("E2E suite: executed=0 passed=0 failed=0 skipped=9")),
    `counts line missing from: ${verdict.lines.join(" | ")}`,
  );
});

test("executed>0 with required scenarios skipped FAILs and names them with their kind", () => {
  const specs = [
    ...requiredSpecs((entry) =>
      ["E2E-01a", "E2E-03"].includes(entry.id) ? allPassed() : { status: "skipped", annotations: skipAnnotation("fixme", `${entry.id} needs a live environment`) },
    ),
    spec("runs.spec.ts", "creates a demo run from the dialog", "expected"),
  ];
  const verdict = evaluateE2eSuite(report(specs), { env: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.counts.executed, 3);
  assert.deepEqual(
    verdict.requiredSkipped.map((entry) => entry.id),
    ["E2E-01b", "E2E-02", "E2E-04", "E2E-05", "E2E-06", "E2E-07", "E2E-08"],
  );
  assert.match(verdict.detail, /required scenario\(s\) did not execute: E2E-01b \[fixme\]/);
  assert.match(verdict.detail, /E2E-04 \[fixme\]/);
  assert.ok(verdict.lines.some((line) => line.includes("required NOT executed: E2E-07 [fixme] — E2E-07 needs a live environment")));
  assert.equal(verdict.override.enabled, false);
});

test("a suite whose required scenarios all execute PASSes with the counts printed", () => {
  const verdict = evaluateE2eSuite(report(requiredSpecs(allPassed)), { env: {} });
  assert.equal(verdict.ok, true);
  assert.deepEqual(
    [verdict.counts.executed, verdict.counts.passed, verdict.counts.failed, verdict.counts.skipped],
    [REQUIRED_E2E_SCENARIOS.length, REQUIRED_E2E_SCENARIOS.length, 0, 0],
  );
  assert.equal(verdict.detail, `executed=9 passed=9 failed=0 skipped=0`);
  assert.ok(verdict.lines[0].startsWith("E2E suite: executed=9 passed=9 failed=0 skipped=0"));
  assert.ok(verdict.lines.some((line) => line === "E2E verdict: PASS"));
});

test("the documented override waives required skips and the reason is always printed", () => {
  const reason = "release 0.27: live acceptance environment is not provisioned yet";
  const specs = requiredSpecs((entry) => (entry.id === "E2E-01a" ? allPassed() : allFixme()));
  const verdict = evaluateE2eSuite(report(specs), { env: overrideEnv(reason) });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.override.enabled, true);
  assert.equal(verdict.override.reason, reason);
  assert.match(verdict.detail, new RegExp(`override ${ALLOW_REQUIRED_SKIPS_ENV}=1 \\(reason: ${reason}\\)`));
  assert.match(verdict.detail, /waiving E2E-01b/);
  assert.ok(verdict.lines.some((line) => line.includes(`reason: ${reason}`)));
});

test("the override switch is strictly parsed: only the exact value \"1\" plus a reason enables it", () => {
  const reason = "accepted deviation";
  for (const bad of ["true", "yes", "on", "0", "1 ", "TRUE"]) {
    const verdict = evaluateE2eSuite(report(requiredSpecs(allPassed)), { env: { [ALLOW_REQUIRED_SKIPS_ENV]: bad } });
    assert.equal(verdict.ok, false, `"${bad}" must not enable the override`);
    assert.match(verdict.detail, /is not recognised/);
  }

  const noReason = evaluateE2eSuite(report(requiredSpecs(allPassed)), { env: { [ALLOW_REQUIRED_SKIPS_ENV]: "1" } });
  assert.equal(noReason.ok, false);
  assert.match(noReason.detail, /non-empty PI_E2E_ALLOW_REQUIRED_SKIPS_REASON/);

  const blankReason = evaluateE2eSuite(report(requiredSpecs(allPassed)), {
    env: { [ALLOW_REQUIRED_SKIPS_ENV]: "1", [ALLOW_REQUIRED_SKIPS_REASON_ENV]: "   " },
  });
  assert.equal(blankReason.ok, false);

  assert.deepEqual(parseRequiredSkipOverride({}), { enabled: false, reason: "", error: undefined });
  assert.deepEqual(parseRequiredSkipOverride({ [ALLOW_REQUIRED_SKIPS_ENV]: "" }), { enabled: false, reason: "", error: undefined });
  assert.deepEqual(parseRequiredSkipOverride(overrideEnv(reason)), { enabled: true, reason, error: undefined });
});

test("the override can never waive an all-skipped suite", () => {
  const verdict = evaluateE2eSuite(report(requiredSpecs(allFixme)), { env: overrideEnv("we accept the deviation") });
  assert.equal(verdict.override.enabled, true);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /executed 0 scenarios/);
});

test("a required scenario missing from the report FAILs (coverage cannot be deleted)", () => {
  const specs = requiredSpecs(allPassed).filter((entry) => !entry.title.startsWith("E2E-04"));
  const verdict = evaluateE2eSuite(report(specs), { env: {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missingRequired, ["E2E-04"]);
  assert.match(verdict.detail, /required scenario\(s\) missing from the Playwright report: E2E-04/);
});

test("a failed scenario FAILs the verdict with its name, even if the ids are all present", () => {
  const specs = requiredSpecs((entry) => (entry.id === "E2E-02" ? { status: "unexpected" } : allPassed()));
  const verdict = evaluateE2eSuite(report(specs), { env: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.counts.failed, 1);
  assert.match(verdict.detail, /1 E2E scenario\(s\) FAILED/);
  assert.ok(verdict.lines.some((line) => line.includes("FAILED: acceptance.spec.ts › E2E-02")));
});

test("a spec that ran in one project and skipped in another counts once as executed", () => {
  const shared = {
    file: "acceptance.spec.ts",
    title: "E2E-01a 单 Agent 完整闭环",
    ok: true,
    tests: [
      { status: "expected", projectName: "chromium", annotations: [] },
      { status: "skipped", projectName: "mobile", annotations: skipAnnotation("skip", "not selected") },
    ],
  };
  const [collected] = collectSpecs(report([shared]));
  assert.equal(collected.status, "passed");
});

test("runE2eStep refuses to run a step whose required prerequisite is missing", () => {
  const outcome = runE2eStep(
    { id: "e2e-browser", label: "Playwright browser suite", command: "node", args: [], requiredReason: "PI_E2E_BASE_URL is not set" },
    { spawn: () => assert.fail("must not spawn without PI_E2E_BASE_URL"), log: () => {} },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /^REQUIRED, not skippable: PI_E2E_BASE_URL is not set/);
});

test("runE2eStep invokes Playwright with list+json reporters and the json report path", () => {
  let captured;
  const outcome = runE2eStep(
    { id: "e2e-browser", label: "npm run e2e:browser", command: "npm", args: ["run", "e2e:browser"], env: { PI_E2E_BASE_URL: "http://127.0.0.1:3100" } },
    {
      env: { PATH: "/usr/bin" },
      reportDir: "/tmp/pigo-e2e-test",
      spawn: (command, args, spawnOptions) => {
        captured = { command, args, spawnOptions };
        return { status: 0 };
      },
      readReport: () => report(requiredSpecs(allPassed)),
      log: () => {},
    },
  );
  assert.equal(captured.command, "npm");
  assert.deepEqual(captured.args, ["run", "e2e:browser", "--", "--reporter=list", "--reporter=json"]);
  assert.equal(captured.spawnOptions.env.PI_E2E_BASE_URL, "http://127.0.0.1:3100");
  assert.equal(captured.spawnOptions.env.PLAYWRIGHT_JSON_OUTPUT_NAME, join("/tmp/pigo-e2e-test", "playwright-report.json"));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verdict.counts.executed, REQUIRED_E2E_SCENARIOS.length);
});

test("runE2eStep turns an exit-0 all-skipped run into a FAIL with the counts", () => {
  const outcome = runE2eStep(
    { id: "e2e-browser", label: "npm run e2e:browser", command: "npm", args: ["run", "e2e:browser"] },
    { env: {}, reportDir: "/tmp/pigo-e2e-test", spawn: () => ({ status: 0 }), readReport: () => report(requiredSpecs(allFixme)), log: () => {} },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.counts.executed, 0);
  assert.match(outcome.detail, /executed=0 passed=0 failed=0 skipped=9/);
});

test("runE2eStep refuses an exit-0 run that wrote no report (unverifiable pass)", () => {
  const outcome = runE2eStep(
    { id: "e2e-browser", label: "npm run e2e:browser", command: "npm", args: ["run", "e2e:browser"] },
    {
      env: {},
      reportDir: "/tmp/pigo-e2e-test",
      spawn: () => ({ status: 0 }),
      readReport: () => {
        throw new Error("ENOENT: no such file or directory");
      },
      log: () => {},
    },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict, undefined);
  assert.match(outcome.detail, /exited 0 but wrote no readable Playwright JSON report/);
});

test("runE2eStep FAILs a non-zero Playwright exit even when the report looks healthy", () => {
  const outcome = runE2eStep(
    { id: "e2e-browser", label: "npm run e2e:browser", command: "npm", args: ["run", "e2e:browser"] },
    {
      env: {},
      reportDir: "/tmp/pigo-e2e-test",
      spawn: () => ({ status: 1 }),
      readReport: () => report(requiredSpecs((entry) => (entry.id === "E2E-03" ? { status: "unexpected" } : allPassed()))),
      log: () => {},
    },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /^exit 1 /);
  assert.match(outcome.detail, /executed=9 passed=8 failed=1 skipped=0/);
});
