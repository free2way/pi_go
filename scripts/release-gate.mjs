#!/usr/bin/env node
/**
 * `npm run gate:release` — the single release gate.
 *
 * Runs, in order:
 *   1. npm run typecheck
 *   2. npm test
 *   3. npm run test:executor
 *   4. npm run lint
 *   5. npm run build
 *   6. npm run validate:compose
 *   7. npm run scan:secrets            (tracked-file secret scan)
 *   8. npm run test:pg:concurrency     (only when PI_DATABASE_URL / DATABASE_URL
 *                                       is set; otherwise an explicit SKIP)
 *
 * The secret scan and the PostgreSQL check are the two pieces a bare "run the
 * unit suite" gate is missing. The PostgreSQL step is the only one that can
 * touch an external system, and it is opt-in via the connection string.
 *
 * Safety:
 *   - Every step except the database check is local and read-mostly (`build`
 *     writes `dist/`). The database check never runs unless a URL is exported.
 *   - `--dry-run` prints the exact plan and executes nothing.
 *   - A missing prerequisite is reported as SKIP with a reason, never a silent
 *     pass; any FAIL makes the process exit non-zero.
 *
 * Aggregation/rendering lives in scripts/release-gate-lib.mjs and is unit
 * tested with `npm run test:scripts` (node --test).
 */
import {
  DB_STEP_ID,
  SKIP,
  defaultRunStep,
  executeGate,
  planGateSteps,
  renderGateTable,
  summarizeResults,
} from "./release-gate-lib.mjs";

const argv = new Set(process.argv.slice(2));

if (argv.has("--help") || argv.has("-h")) {
  console.log(`release gate

Usage:
  npm run gate:release            # run every step (PostgreSQL step auto-SKIPs without a URL)
  npm run gate:release -- --dry-run   # print the plan, execute nothing

Environment:
  PI_DATABASE_URL / DATABASE_URL  when set, adds the real-PostgreSQL concurrency check
  CI                              when "true", forces the quiet summary (same output)

Exit code: 0 when no step FAILed (SKIPs are allowed but always printed).`);
  process.exit(0);
}

const dryRun = argv.has("--dry-run") || argv.has("--list") || argv.has("--plan");
const steps = planGateSteps(process.env);

if (dryRun) {
  console.log("[release-gate] dry-run — nothing will be executed. Planned steps:");
  for (const [index, step] of steps.entries()) {
    if (step.kind === "skip") {
      console.log(`  ${index + 1}. SKIP  ${step.label} — ${step.reason}`);
    } else {
      console.log(`  ${index + 1}. RUN   ${step.label}   (${step.command} ${(step.args ?? []).join(" ")})`);
    }
  }
  const dbStep = steps.find((step) => step.id === DB_STEP_ID);
  if (dbStep?.kind === "skip") {
    console.log("\n[release-gate] note: the PostgreSQL concurrency check is skipped; export PI_DATABASE_URL to include it.");
  }
  process.exit(0);
}

console.log(`[release-gate] running ${steps.length} step(s)…`);
const results = await executeGate(steps, { runStep: (step) => defaultRunStep(step, { cwd: process.cwd() }) });

console.log("\n[release-gate] summary");
console.log(renderGateTable(results));

const summary = summarizeResults(results);
console.log(
  `\n[release-gate] ${summary.counts.pass} passed, ${summary.counts.fail} failed, ${summary.counts.skip} skipped — ${summary.ok ? "PASS" : "FAIL"}`,
);
if (summary.counts.skip > 0) {
  console.log("[release-gate] skipped steps and reasons:");
  for (const result of results) {
    if (result.status === SKIP) console.log(`  - ${result.id}: ${result.detail}`);
  }
}
if (!summary.ok) console.log(`[release-gate] FAIL: ${summary.failedIds.join(", ")}`);

process.exit(summary.exitCode);
