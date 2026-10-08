/**
 * Release-gate aggregation helper (REL tooling, "C 组").
 *
 * `scripts/release-gate.mjs` is a thin CLI over this module. Keeping the plan,
 * the status aggregation and the table rendering pure and dependency-free means
 * they can be unit-tested without spawning `npm` or touching a database.
 *
 * Status model:
 *   PASS — the step ran and exited 0.
 *   FAIL — the step ran and exited non-zero (or could not be spawned).
 *   SKIP — the step was deliberately not run for a stated reason. A SKIP is
 *          never counted as a pass and never, on its own, fails the gate; the
 *          reason is always printed so an unset prerequisite is visible.
 *
 * Vitest only collects `src/**`, so this helper is tested with `node --test`
 * (see scripts/release-gate-lib.test.mjs and `npm run test:scripts`).
 */
import { spawnSync } from "node:child_process";

export const PASS = "PASS";
export const FAIL = "FAIL";
export const SKIP = "SKIP";

/** The real-PostgreSQL step is the only gate entry that can touch an external system. */
export const DB_STEP_ID = "pg-concurrency";
export const SECRET_SCAN_STEP_ID = "scan-secrets";

/**
 * Build the ordered gate plan. Command steps are executed in array order.
 *
 * The database step is included only when a connection string is present; when
 * it is absent the step is returned as an explicit SKIP carrying the reason, so
 * the gate can never silently drop its strongest evidence check.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Array<Record<string, unknown>>}
 */
export function planGateSteps(env = process.env) {
  /** @type {Array<Record<string, unknown>>} */
  const steps = [
    { id: "typecheck", label: "npm run typecheck", kind: "command", command: "npm", args: ["run", "typecheck"] },
    { id: "test", label: "npm test", kind: "command", command: "npm", args: ["test"] },
    { id: "test-executor", label: "npm run test:executor", kind: "command", command: "npm", args: ["run", "test:executor"] },
    { id: "lint", label: "npm run lint", kind: "command", command: "npm", args: ["run", "lint"] },
    { id: "build", label: "npm run build", kind: "command", command: "npm", args: ["run", "build"] },
    { id: "validate-compose", label: "npm run validate:compose", kind: "command", command: "npm", args: ["run", "validate:compose"] },
    { id: SECRET_SCAN_STEP_ID, label: "npm run scan:secrets", kind: "command", command: "npm", args: ["run", "scan:secrets"] },
  ];

  const databaseUrl = env.PI_DATABASE_URL || env.DATABASE_URL;
  if (databaseUrl) {
    steps.push({
      id: DB_STEP_ID,
      label: "npm run test:pg:concurrency (real PostgreSQL)",
      kind: "command",
      command: "npm",
      args: ["run", "test:pg:concurrency"],
      // Pass the exact variable the pg check reads; never print its value.
      env: { PI_DATABASE_URL: env.PI_DATABASE_URL || "", DATABASE_URL: env.DATABASE_URL || "" },
    });
  } else {
    steps.push({
      id: DB_STEP_ID,
      label: "real-PostgreSQL concurrency check",
      kind: "skip",
      reason: "PI_DATABASE_URL / DATABASE_URL not set — no database is touched; export one to include this check",
    });
  }

  return steps;
}

/**
 * Aggregate step results into pass/fail/skip counts and the process exit code.
 *
 * @param {Array<{ id: string, status: string, detail?: string }>} results
 */
export function summarizeResults(results) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const result of results) {
    if (result.status === PASS) counts.pass += 1;
    else if (result.status === FAIL) counts.fail += 1;
    else counts.skip += 1;
  }
  const failedIds = results.filter((result) => result.status === FAIL).map((result) => result.id);
  return {
    counts,
    total: results.length,
    ok: counts.fail === 0,
    exitCode: counts.fail === 0 ? 0 : 1,
    failedIds,
  };
}

/**
 * Render a compact, aligned PASS/FAIL/SKIP table. Pure so tests can assert on
 * the exact rendering without capturing a terminal.
 *
 * @param {Array<{ id: string, status: string, detail?: string }>} results
 */
export function renderGateTable(results) {
  const idWidth = Math.max("id".length, ...results.map((result) => result.id.length));
  const statusWidth = Math.max("status".length, ...results.map((result) => result.status.length));
  const header = `${"id".padEnd(idWidth)}  ${"status".padEnd(statusWidth)}  detail`;
  const separator = `${"-".repeat(idWidth)}  ${"-".repeat(statusWidth)}  ${"-".repeat(48)}`;
  const rows = results.map((result) =>
    `${result.id.padEnd(idWidth)}  ${result.status.padEnd(statusWidth)}  ${result.detail ?? ""}`.trimEnd(),
  );
  return [header, separator, ...rows].join("\n");
}

/**
 * Execute the plan with an injected `runStep(step) -> { ok, detail }` so tests
 * never spawn a process. Every step runs even after a failure, so the printed
 * table is complete evidence rather than a truncated one.
 *
 * @param {Array<Record<string, unknown>>} steps
 * @param {{ runStep: (step: Record<string, unknown>) => Promise<{ ok: boolean, detail?: string }> }} options
 */
export async function executeGate(steps, options = {}) {
  const runStep = options.runStep;
  if (typeof runStep !== "function") throw new Error("executeGate requires options.runStep");
  /** @type {Array<{ id: string, status: string, detail?: string }>} */
  const results = [];
  for (const step of steps) {
    if (step.kind === "skip") {
      results.push({ id: String(step.id), status: SKIP, detail: String(step.reason ?? "skipped") });
      continue;
    }
    let outcome;
    try {
      outcome = await runStep(step);
    } catch (error) {
      results.push({ id: String(step.id), status: FAIL, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (outcome && outcome.ok) {
      results.push({ id: String(step.id), status: PASS, detail: outcome.detail ?? "ok" });
    } else {
      results.push({ id: String(step.id), status: FAIL, detail: outcome?.detail ?? "command failed" });
    }
  }
  return results;
}

/**
 * Default runner: spawn the step's command with inherited stdio so the full
 * tool output stays visible in the terminal/log. Never throws; a spawn failure
 * (e.g. npm missing) becomes a FAIL with the error message.
 *
 * @param {Record<string, any>} step
 * @param {{ cwd?: string }} [options]
 */
export function defaultRunStep(step, options = {}) {
  console.log(`\n[release-gate] ▶ ${step.label}`);
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args ?? [], {
    cwd: options.cwd ?? process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...(step.env ?? {}) },
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.error) return { ok: false, detail: `could not spawn: ${result.error.message}` };
  if (result.status === 0) return { ok: true, detail: `exit 0 (${seconds}s)` };
  const signal = result.signal ? ` signal ${result.signal}` : "";
  return { ok: false, detail: `exit ${result.status}${signal} (${seconds}s)` };
}
