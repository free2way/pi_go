import test from "node:test";
import assert from "node:assert/strict";

import { evaluateBrowserSmoke } from "./browser-smoke-verdict.mjs";

function spec(file, title, status = "expected", annotations = []) {
  return { file, title, tests: [{ status, projectName: "chromium", annotations }] };
}

function report(specs) {
  return { suites: [{ title: "browser smoke", specs }] };
}

const complete = () => report([
  spec("tests/e2e/auth.spec.ts", "identity header"),
  spec("tests/e2e/auth.spec.ts", "authenticated shell"),
  spec("tests/e2e/i18n.spec.ts", "locale selector"),
  spec("tests/e2e/i18n.spec.ts", "locale persistence"),
]);

test("browser smoke passes only when every expected scenario executes cleanly", () => {
  const verdict = evaluateBrowserSmoke(complete());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.counts, { total: 4, passed: 4, failed: 0, flaky: 0, skipped: 0 });
});

test("browser smoke rejects an all-skipped report even when Playwright exits zero", () => {
  const skipped = { type: "skip", description: "browser unavailable" };
  const input = complete();
  for (const item of input.suites[0].specs) {
    item.tests[0].status = "skipped";
    item.tests[0].annotations = [skipped];
  }
  const verdict = evaluateBrowserSmoke(input);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(" | "), /4 scenario\(s\) skipped/);
});

test("browser smoke rejects missing files, flaky tests and a non-zero process exit", () => {
  const verdict = evaluateBrowserSmoke(report([
    spec("tests/e2e/auth.spec.ts", "identity header", "flaky"),
    spec("tests/e2e/auth.spec.ts", "authenticated shell"),
  ]), 1);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(" | "), /Playwright exited 1/);
  assert.match(verdict.failures.join(" | "), /flaky/);
  assert.deepEqual(verdict.missing.map((item) => item.file), ["i18n.spec.ts"]);
});
