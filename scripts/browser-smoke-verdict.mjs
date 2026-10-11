#!/usr/bin/env node
/**
 * Grades the small, credential-free Playwright suite used by PR CI.
 *
 * Playwright exits zero when every test self-skips. This verdict therefore
 * reads the JSON reporter output and requires all expected smoke scenarios to
 * execute cleanly. It is intentionally separate from the live acceptance gate,
 * whose provider/worker scenarios run in the deployment environment.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectSpecs } from "./e2e-suite-result.mjs";

export const REQUIRED_BROWSER_SMOKE = Object.freeze([
  { file: "auth.spec.ts", minimum: 2 },
  { file: "i18n.spec.ts", minimum: 2 },
]);

function matchesFile(actual, expected) {
  return actual === expected || actual.endsWith(`/${expected}`);
}

export function evaluateBrowserSmoke(report, processExitCode = 0) {
  const specs = collectSpecs(report);
  const counts = {
    total: specs.length,
    passed: specs.filter((spec) => spec.status === "passed").length,
    failed: specs.filter((spec) => spec.status === "failed").length,
    flaky: specs.filter((spec) => spec.status === "flaky").length,
    skipped: specs.filter((spec) => spec.status === "skipped").length,
  };
  const missing = REQUIRED_BROWSER_SMOKE.filter((required) =>
    specs.filter((spec) => matchesFile(spec.file, required.file)).length < required.minimum,
  );
  const failures = [];
  if (processExitCode !== 0) failures.push(`Playwright exited ${processExitCode}`);
  if (counts.failed > 0) failures.push(`${counts.failed} scenario(s) failed`);
  if (counts.flaky > 0) failures.push(`${counts.flaky} scenario(s) were flaky`);
  if (counts.skipped > 0) failures.push(`${counts.skipped} scenario(s) skipped`);
  if (missing.length > 0) {
    failures.push(`required smoke coverage missing: ${missing.map((item) => `${item.file}>=${item.minimum}`).join(", ")}`);
  }
  if (counts.total === 0) failures.push("Playwright report contains zero scenarios");
  return {
    ok: failures.length === 0,
    counts,
    missing,
    failures,
    summary: `browser smoke: total=${counts.total} passed=${counts.passed} failed=${counts.failed} flaky=${counts.flaky} skipped=${counts.skipped}`,
  };
}

export function gradeBrowserSmokeFile(reportPath, processExitCode = 0) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      missing: [...REQUIRED_BROWSER_SMOKE],
      failures: [`Playwright JSON report is unavailable: ${error instanceof Error ? error.message : String(error)}`],
      summary: "browser smoke: report unavailable",
    };
  }
  return evaluateBrowserSmoke(report, processExitCode);
}

function main() {
  const reportPath = process.argv[2];
  const processExitCode = Number(process.argv[3] ?? 0);
  if (!reportPath || !Number.isInteger(processExitCode) || processExitCode < 0) {
    console.error("usage: node scripts/browser-smoke-verdict.mjs <playwright-report.json> [playwright-exit-code]");
    process.exitCode = 2;
    return;
  }
  const verdict = gradeBrowserSmokeFile(reportPath, processExitCode);
  console.log(verdict.summary);
  for (const failure of verdict.failures) console.error(`  FAIL: ${failure}`);
  console.log(`browser smoke verdict: ${verdict.ok ? "PASS" : "FAIL"}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
