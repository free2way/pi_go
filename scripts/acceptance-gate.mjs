#!/usr/bin/env node
/**
 * `npm run gate:acceptance` — the stricter, acceptance-only release gate (v0.22).
 *
 * Difference from `gate:release` (which stays developer-friendly):
 *
 *   1. A SKIP is a FAIL. Every prerequisite (PostgreSQL URL, Playwright base
 *      URL) is required, and a missing one fails loudly with the reason.
 *   2. Lint must be warning-free. The gate parses
 *      `✖ N problems (0 errors, M warnings)` and requires M = 0; `gate:release`
 *      only requires exit 0 (warnings allowed).
 *   3. The real-PostgreSQL concurrency check MUST run
 *      (`PI_DATABASE_URL` / `DATABASE_URL` required).
 *   4. The Playwright browser suite MUST actually execute
 *      (`PI_E2E_BASE_URL` required); a missing URL is a FAIL, not a skip.
 *   5. Executing is not enough (P1 audit fix, v0.27). The Playwright JSON report
 *      is graded by scripts/e2e-suite-result.mjs: 0 executed scenarios is a
 *      FAIL, and every scenario in `REQUIRED_E2E_SCENARIOS` must actually run —
 *      a `skipped`/`fixme`/`todo` required scenario fails the gate and is named
 *      in the output. Because the suite self-skips without a browser/server and
 *      the docs/05 §13 live scenarios are `fixme` by default, an exit-0 run is
 *      no longer sufficient evidence. The gate always prints
 *      executed/passed/failed/skipped counts.
 *
 * Escape hatch (strictly parsed, default OFF):
 *   PI_E2E_ALLOW_REQUIRED_SKIPS=1            waives required-scenario skips only
 *   PI_E2E_ALLOW_REQUIRED_SKIPS_REASON=...   mandatory; printed in the summary
 * It can never waive "0 scenarios executed", and any other value for the switch
 * ("true", "yes", "0") is itself a FAIL.
 *
 * The fixed command steps, aggregation and table rendering are shared with
 * `gate:release` via scripts/release-gate-lib.mjs, so the two gates cannot drift
 * on ordering or status semantics.
 *
 * Safety: identical to the release gate — every step is local and read-mostly
 * except the opt-in PostgreSQL check; `--dry-run` executes nothing.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FAIL,
  SKIP,
  defaultRunStep,
  executeGate,
  planGateSteps,
  renderGateTable,
  summarizeResults,
} from "./release-gate-lib.mjs";
import { ALLOW_REQUIRED_SKIPS_ENV, ALLOW_REQUIRED_SKIPS_REASON_ENV, runE2eStep } from "./e2e-suite-result.mjs";

export const LINT_STEP_ID = "lint";
export const E2E_STEP_ID = "e2e-browser";

/**
 * Parse the ESLint summary footer. Returns `{ errors, warnings }` or undefined
 * when the output has no `N problems` line (clean run). Tolerant of the singular
 * `problem`/`error`/`warning` forms.
 *
 * @param {string} output
 */
export function parseEslintSummary(output) {
  const match = output.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/);
  if (!match) return undefined;
  return { problems: Number(match[1]), errors: Number(match[2]), warnings: Number(match[3]) };
}

/**
 * Build the acceptance plan: the release plan with every optional step turned
 * into a required one, plus the Playwright suite.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function planAcceptanceSteps(env = process.env) {
  const steps = planGateSteps(env).map((step) => {
    if (step.kind !== "skip") return step;
    // A skip becomes a command-less step the runner turns into a FAIL. Using
    // kind "command" keeps it out of executeGate's skip branch.
    return { id: step.id, label: step.label, kind: "command", command: "node", args: [], requiredReason: step.reason };
  });

  const baseUrl = env.PI_E2E_BASE_URL;
  if (baseUrl) {
    steps.push({
      id: E2E_STEP_ID,
      label: "npm run e2e:browser (Playwright)",
      kind: "command",
      command: "npm",
      args: ["run", "e2e:browser"],
      env: { PI_E2E_BASE_URL: baseUrl },
    });
  } else {
    steps.push({
      id: E2E_STEP_ID,
      label: "Playwright browser suite",
      kind: "command",
      command: "node",
      args: [],
      requiredReason:
        "PI_E2E_BASE_URL is not set — the acceptance gate requires the Playwright suite to actually run; start a PiGO server (npm run build && npm start) and export PI_E2E_BASE_URL=http://127.0.0.1:3100 (the suite never starts one itself)",
    });
  }
  return steps;
}

/** Lint step for the acceptance gate: exit 0 AND zero warnings. */
function runLintNoWarnings(step, cwd) {
  console.log(`\n[acceptance-gate] ▶ ${step.label} (exit 0 and 0 warnings)`);
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args ?? [], { cwd, encoding: "utf8" });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.error) return { ok: false, detail: `could not spawn: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, detail: `exit ${result.status} (${seconds}s)` };

  const summary = parseEslintSummary(output);
  if (summary && summary.warnings > 0) {
    return {
      ok: false,
      detail: `lint reported ${summary.warnings} warning(s) — the acceptance gate requires 0 warnings (${summary.errors} error(s))`,
    };
  }
  return { ok: true, detail: `0 warnings (${seconds}s)` };
}

/** Runner that enforces the warning-free lint and the graded E2E suite on top of the shared default. */
async function runAcceptanceStep(step, cwd, env, options = {}) {
  if (step.id === LINT_STEP_ID) return runLintNoWarnings(step, cwd);
  if (step.id === E2E_STEP_ID) {
    return runE2eStep(step, {
      cwd,
      env,
      spawn: options.spawn,
      readReport: options.readReport,
      reportDir: options.reportDir,
      log: options.log,
    });
  }
  return defaultRunStep(step, { cwd });
}

/**
 * Run the acceptance gate and return the rendered result. Exported so a future
 * node test can drive it with an injected runner.
 *
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, runStep?: Function, runE2eStep?: Function, spawn?: Function, readReport?: Function, reportDir?: string, log?: Function }} [options]
 */
export async function runAcceptanceGate(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const steps = planAcceptanceSteps(env);
  const base = options.runStep ?? ((step) => runAcceptanceStep(step, cwd, env, options));
  // The E2E step is graded from the Playwright JSON report. `runE2eStep` can be
  // injected on its own; when only `runStep` is injected the E2E step keeps
  // using it, so existing callers and tests are unaffected.
  const runE2e = options.runE2eStep ?? (options.runStep ? base : (step) => runAcceptanceStep(step, cwd, env, options));

  /** @type {any} */
  let e2eVerdict;
  const runner = async (step) => {
    if (step.requiredReason) {
      console.log(`\n[acceptance-gate] ✖ ${step.label}`);
      console.log(`[acceptance-gate]   required prerequisite missing: ${step.requiredReason}`);
      return { ok: false, detail: `REQUIRED, not skippable: ${step.requiredReason}` };
    }
    const outcome = step.id === E2E_STEP_ID ? await runE2e(step) : await base(step);
    if (step.id === E2E_STEP_ID && outcome?.verdict) e2eVerdict = outcome.verdict;
    return outcome;
  };
  const results = await executeGate(steps, { runStep: runner });

  // Belt and suspenders: any step still reported SKIP by the shared executor is
  // promoted to FAIL — the acceptance gate forbids skips.
  for (const result of results) {
    if (result.status === SKIP) {
      result.status = FAIL;
      result.detail = `skipped in the developer gate but forbidden here — ${result.detail}`;
    }
  }
  return { steps, results, summary: summarizeResults(results), e2e: e2eVerdict };
}

const argv = new Set(process.argv.slice(2));

async function main() {
  if (argv.has("--help") || argv.has("-h")) {
    console.log(`acceptance gate (stricter than gate:release)

Usage:
  npm run gate:acceptance            # every prerequisite is required
  npm run gate:acceptance -- --dry-run   # print the plan, execute nothing

Required environment:
  PI_DATABASE_URL / DATABASE_URL  the real-PostgreSQL concurrency check MUST run
  PI_E2E_BASE_URL                 the Playwright suite MUST run against this URL

Rejects (FAIL, never SKIP): a missing prerequisite, any lint warning, an
unexecuted database check, an unexecuted Playwright suite.

Additionally (P1 audit fix): the Playwright JSON report is graded, so the gate
also FAILs when the suite executes 0 scenarios (all skipped/fixme) or when any
docs/05 §13 required scenario (E2E-01a/01b, E2E-02..08) is skipped/fixme/todo —
the offending scenario ids are printed with their skip reason, together with the
executed/passed/failed/skipped counts.

Operator override (strictly parsed, default OFF):
  ${ALLOW_REQUIRED_SKIPS_ENV}=1   waive required-scenario skips
  ${ALLOW_REQUIRED_SKIPS_REASON_ENV}=<text>  mandatory justification, printed
  Any other value of the switch is itself a FAIL; the override can never waive
  "0 scenarios executed".

Exit code: 0 only when every step PASSed.`);
    process.exit(0);
  }

  const dryRun = argv.has("--dry-run") || argv.has("--list") || argv.has("--plan");
  const planned = planAcceptanceSteps(process.env);

  if (dryRun) {
    console.log("[acceptance-gate] dry-run — nothing will be executed. Required steps:");
    for (const [index, step] of planned.entries()) {
      const requirement = step.requiredReason ? ` (REQUIRED: ${step.requiredReason})` : "";
      const command = step.args && step.args.length ? ` (${step.command} ${step.args.join(" ")})` : "";
      console.log(`  ${index + 1}. RUN   ${step.label}${command}${requirement}`);
    }
    const missing = planned.filter((step) => step.requiredReason).map((step) => step.id);
    if (missing.length > 0) {
      console.log(`\n[acceptance-gate] note: without the required prerequisites this run would FAIL: ${missing.join(", ")}`);
      console.log("                    export PI_DATABASE_URL and PI_E2E_BASE_URL for a full acceptance run.");
    }
    process.exit(0);
  }

  console.log(`[acceptance-gate] running ${planned.length} required step(s)…`);
  const { results, summary, e2e } = await runAcceptanceGate();

  console.log("\n[acceptance-gate] summary");
  console.log(renderGateTable(results));
  if (e2e) {
    // Always re-print the machine verdict in the summary: a human reading the
    // tail of a CI log must see the counts and any override reason even when
    // the step detail above scrolled away.
    console.log("\n[acceptance-gate] e2e evidence:");
    for (const line of e2e.lines) console.log(`  ${line}`);
  }
  console.log(
    `\n[acceptance-gate] ${summary.counts.pass} passed, ${summary.counts.fail} failed, ${summary.counts.skip} skipped — ${summary.ok ? "PASS" : "FAIL"}`,
  );
  if (!summary.ok) {
    console.log("[acceptance-gate] failed steps:");
    for (const result of results) {
      if (result.status === FAIL) console.log(`  - ${result.id}: ${result.detail}`);
    }
  }
  process.exit(summary.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
