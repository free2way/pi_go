#!/usr/bin/env node
/**
 * `npm run drill:providers` — real-provider drill driver.
 *
 * Drives real runs against a deployed PiGO over its HTTP API so an operator can
 * record evidence for the acceptance spec (real provider closure + real
 * medium-sized parallel Sub Agent split).
 *
 * This script NEVER reads credentials from files. Authentication comes from the
 * environment only, and the tool refuses to touch the network without an
 * explicit base URL plus an explicit auth mechanism.
 *
 * Required environment:
 *   PI_DRILL_BASE_URL        e.g. http://127.0.0.1:3100  (no trailing slash needed)
 *   ... and one user-auth mechanism:
 *     PI_DRILL_DEV_EMAIL               development-auth deployment (x-pigo-dev-email)
 *     PI_DRILL_CF_ACCESS_CLIENT_ID +   Cloudflare Access service token
 *     PI_DRILL_CF_ACCESS_CLIENT_SECRET
 *   PI_DRILL_INTERNAL_TOKEN  optional; attached as Bearer for /api/internal/*.
 *                            It authenticates internal routes ONLY and cannot
 *                            create user runs — a run-creation 401 tells you to
 *                            set a user-auth mechanism above.
 *
 * Optional environment:
 *   PI_DRILL_WORKSPACE       workspace id to target (default: first clean active)
 *   PI_DRILL_TASK            task text for normal runs
 *   PI_DRILL_CHECKS          comma-separated check commands (default "node --version")
 *   PI_DRILL_RUNS            number of runs (default 3)
 *   PI_DRILL_TIMEOUT_MS      per-run terminal-state timeout (default 1800000 = 30m)
 *   PI_DRILL_POLL_MS         poll interval (default 5000)
 *   PI_DRILL_REQUEST_TIMEOUT_MS  single HTTP request timeout (default 20000)
 *   PI_DRILL_DEVELOPER_MODEL provider:model override, e.g. "deepseek:deepseek-flash"
 *   PI_DRILL_REVIEWER_MODEL  provider:model override
 *   PI_DRILL_ACCEPTANCE      acceptance criteria captured with the run
 *
 * Flags:
 *   --runs <n>            override PI_DRILL_RUNS
 *   --task <text>         override PI_DRILL_TASK
 *   --parallel-fixture    submit ONE run that explicitly asks for a medium-sized
 *                         parallel split, then assert >=2 subagent.started
 *                         events across waves (PASS/FAIL)
 *   --out <dir>           write a JSON drill record (used by drill-archive.sh)
 *   --no-cancel           do not cancel runs that exceed the timeout
 *   --dry-run             validate env + print the exact plan; no network calls
 *   --help
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "needs_human"]);
/** Terminal states that count as an acceptable drill outcome. */
const ACCEPTED_TERMINAL = new Set(["completed", "needs_human"]);

const DEFAULT_CHECKS = ["node --version"];
const DEFAULT_PARALLEL_TASK = [
  "Parallel drill fixture (medium workload).",
  "Plan a MEDIUM-sized run and split it into at least three independent sub-agents that touch disjoint files.",
  "For example: add src/drill/alpha.ts, src/drill/beta.ts and src/drill/gamma.ts, each exporting one small",
  "pure function, plus one focused test file per module. The three modules must not share files so the plan",
  "can run them in parallel. Do not choose a single-agent strategy. Then make the checks pass.",
].join(" ");
const DEFAULT_TASK = [
  "Provider drill: make a small, self-contained change in the target workspace to prove the real provider",
  "closure (planner -> developer -> checks -> reviewer). Keep it minimal and ensure the configured checks pass.",
].join(" ");

const USAGE = `drill:providers — drive real provider runs against a deployment

Usage:
  PI_DRILL_BASE_URL=... PI_DRILL_DEV_EMAIL=... npm run drill:providers
  PI_DRILL_BASE_URL=... PI_DRILL_DEV_EMAIL=... npm run drill:providers -- --parallel-fixture
  PI_DRILL_BASE_URL=... PI_DRILL_DEV_EMAIL=... npm run drill:providers -- --runs 5 --out backups/drills/mine

Flags:
  --runs <n>          number of runs (default 3)
  --task <text>       task text for normal runs
  --parallel-fixture  ONE run asserting >=2 subagent.started events across waves
  --out <dir>         write <dir>/provider-drill-<timestamp>.json
  --no-cancel         do not cancel a run that exceeds PI_DRILL_TIMEOUT_MS
  --dry-run           validate environment and print the plan; no network calls
  --help

Required env:  PI_DRILL_BASE_URL + (PI_DRILL_DEV_EMAIL | CF Access service token).
Optional env:  PI_DRILL_INTERNAL_TOKEN PI_DRILL_WORKSPACE PI_DRILL_TASK PI_DRILL_CHECKS
               PI_DRILL_RUNS PI_DRILL_TIMEOUT_MS PI_DRILL_POLL_MS PI_DRILL_REQUEST_TIMEOUT_MS
               PI_DRILL_DEVELOPER_MODEL PI_DRILL_REVIEWER_MODEL PI_DRILL_ACCEPTANCE
Credentials are read from the environment only — never from files.`;

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const options = { parallelFixture: false, dryRun: false, cancelOnTimeout: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--parallel-fixture") options.parallelFixture = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-cancel") options.cancelOnTimeout = false;
    else if (arg === "--runs") options.runs = argv[++index];
    else if (arg === "--task") options.task = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

class UsageError extends Error {}

function usageAndExit(message, code = 2) {
  if (message) console.error(`[drill:providers] ${message}`);
  console.error(USAGE);
  process.exit(code);
}

function numberFrom(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive number`);
  return parsed;
}

// ---------------------------------------------------------------- environment
function readConfig(options) {
  const baseUrl = (process.env.PI_DRILL_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new UsageError("PI_DRILL_BASE_URL is required.");
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new UsageError(`PI_DRILL_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new UsageError("PI_DRILL_BASE_URL must be http(s).");
  }

  const devEmail = process.env.PI_DRILL_DEV_EMAIL || "";
  const cfClientId = process.env.PI_DRILL_CF_ACCESS_CLIENT_ID || "";
  const cfClientSecret = process.env.PI_DRILL_CF_ACCESS_CLIENT_SECRET || "";
  const internalToken = process.env.PI_DRILL_INTERNAL_TOKEN || "";
  const hasCf = Boolean(cfClientId && cfClientSecret);
  if (!devEmail && !hasCf) {
    throw new UsageError(
      "no user authentication configured: set PI_DRILL_DEV_EMAIL (development auth) or both " +
        "PI_DRILL_CF_ACCESS_CLIENT_ID and PI_DRILL_CF_ACCESS_CLIENT_SECRET (Cloudflare Access). " +
        "PI_DRILL_INTERNAL_TOKEN alone only authenticates /api/internal/* and cannot create runs.",
    );
  }

  const checks = (process.env.PI_DRILL_CHECKS || DEFAULT_CHECKS.join(","))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (checks.length === 0) throw new UsageError("PI_DRILL_CHECKS resolved to zero check commands.");

  return {
    baseUrl,
    devEmail,
    cfClientId,
    cfClientSecret,
    internalToken,
    hasCf,
    workspaceId: process.env.PI_DRILL_WORKSPACE || "",
    task: options.task || process.env.PI_DRILL_TASK || (options.parallelFixture ? DEFAULT_PARALLEL_TASK : DEFAULT_TASK),
    checks,
    runs: numberFrom(options.runs, numberFrom(process.env.PI_DRILL_RUNS, 3, "PI_DRILL_RUNS"), "--runs"),
    timeoutMs: numberFrom(process.env.PI_DRILL_TIMEOUT_MS, 30 * 60 * 1000, "PI_DRILL_TIMEOUT_MS"),
    pollMs: numberFrom(process.env.PI_DRILL_POLL_MS, 5_000, "PI_DRILL_POLL_MS"),
    requestTimeoutMs: numberFrom(process.env.PI_DRILL_REQUEST_TIMEOUT_MS, 20_000, "PI_DRILL_REQUEST_TIMEOUT_MS"),
    developerModel: parseModel(process.env.PI_DRILL_DEVELOPER_MODEL),
    reviewerModel: parseModel(process.env.PI_DRILL_REVIEWER_MODEL),
    acceptance: process.env.PI_DRILL_ACCEPTANCE || undefined,
    options,
  };
}

function parseModel(value) {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new UsageError(`model override must be provider:model, got "${value}"`);
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function maskEmail(email) {
  if (!email) return "(cloudflare service token)";
  const at = email.indexOf("@");
  if (at <= 1) return `${email[0] ?? "*"}***`;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

// ---------------------------------------------------------------- HTTP
class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> HTTP ${status}${body ? `: ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

function authHeaders(config) {
  const headers = { accept: "application/json" };
  if (config.devEmail) headers["x-pigo-dev-email"] = config.devEmail;
  if (config.hasCf) {
    headers["cf-access-client-id"] = config.cfClientId;
    headers["cf-access-client-secret"] = config.cfClientSecret;
  }
  if (config.internalToken) headers.authorization = `Bearer ${config.internalToken}`;
  return headers;
}

async function api(config, method, pathname, body) {
  const url = `${config.baseUrl}${pathname}`;
  const headers = authHeaders(config);
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) throw new HttpError(method, url, response.status, parsed);
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- drill steps
async function preflight(config) {
  const health = await api(config, "GET", "/api/health");
  if (!health || health.status !== "ok") {
    throw new Error(`deployment /api/health is not ok: ${JSON.stringify(health)}`);
  }
  console.log(`[drill:providers] deployment ok: ${health.service} ${health.version} db=${health.db}`);
  if (config.workspaceId) {
    const workspace = await api(config, "GET", `/api/workspaces/${encodeURIComponent(config.workspaceId)}`);
    assertWorkspaceUsable(workspace);
    return workspace;
  }
  const listing = await api(config, "GET", "/api/workspaces");
  const usable = (listing?.workspaces ?? []).find(
    (workspace) => workspace.status === "active" && workspace.git && workspace.git.dirty === false,
  );
  if (!usable) {
    throw new Error(
      "no clean, active workspace found. Register/refresh one, or set PI_DRILL_WORKSPACE to a specific id.",
    );
  }
  console.log(`[drill:providers] workspace: ${usable.id} (${usable.name})`);
  return usable;
}

function assertWorkspaceUsable(workspace) {
  if (!workspace) throw new Error("workspace not found (check PI_DRILL_WORKSPACE).");
  if (workspace.status !== "active") throw new Error(`workspace ${workspace.id} status is ${workspace.status}, not active.`);
  if (workspace.git && workspace.git.dirty) {
    throw new Error(
      `workspace ${workspace.id} has uncommitted changes (${(workspace.git.dirtyFiles ?? []).slice(0, 5).join(", ")}); real runs require a clean workspace.`,
    );
  }
}

async function createRun(config, workspace, index, task, stamp, fixture) {
  const payload = {
    title: fixture ? `drill-parallel-${stamp}`.slice(0, 80) : `drill-${stamp}-${index + 1}`.slice(0, 80),
    task,
    mode: "real",
    workspaceId: workspace.id,
    checks: config.checks,
    idempotencyKey: `drill-${stamp}-${fixture ? "parallel" : index + 1}`.slice(0, 120),
  };
  if (config.acceptance) payload.acceptanceCriteria = config.acceptance;
  if (config.developerModel) payload.developerModel = config.developerModel;
  if (config.reviewerModel) payload.reviewerModel = config.reviewerModel;
  const run = await api(config, "POST", "/api/runs", payload);
  if (!run?.id) throw new Error(`run creation returned no id: ${JSON.stringify(run).slice(0, 200)}`);
  console.log(`[drill:providers] created run ${run.id} (${run.state})`);
  return run;
}

async function pollRun(config, runId) {
  const deadline = Date.now() + config.timeoutMs;
  let lastState = "";
  for (;;) {
    const run = await api(config, "GET", `/api/runs/${encodeURIComponent(runId)}`);
    if (run.state !== lastState) {
      console.log(`[drill:providers]   ${runId}: state=${run.state} round=${run.round}`);
      lastState = run.state;
    }
    if (TERMINAL_STATES.has(run.state)) return { run, timedOut: false };
    if (Date.now() >= deadline) return { run, timedOut: true };
    await sleep(config.pollMs);
  }
}

async function summarizeRun(config, run) {
  const checks = run.checks ?? [];
  const findings = run.findings ?? [];
  const modelCalls = run.modelCalls ?? (run.usageRoles ?? []).reduce((sum, role) => sum + (role.calls ?? 0), 0);
  let diffPresent = Boolean(run.diff && run.diff.trim().length > 0);
  let artifacts = [];
  try {
    const listed = await api(config, "GET", `/api/runs/${encodeURIComponent(run.id)}/artifacts`);
    artifacts = listed?.artifacts ?? [];
    if (!diffPresent) diffPresent = artifacts.some((artifact) => artifact.id === "diff" || artifact.kind === "patch");
  } catch {
    // Artifact listing is best-effort evidence; the inline diff still counts.
  }
  return {
    id: run.id,
    state: run.state,
    rounds: run.round,
    checksPassed: checks.filter((check) => check.status === "passed").length,
    checksTotal: checks.length,
    modelCalls,
    findingsResolved: findings.filter((finding) => finding.resolved).length,
    findingsTotal: findings.length,
    diffPresent,
    artifacts: artifacts.map((artifact) => artifact.id),
  };
}

async function fetchAllEvents(config, runId) {
  const events = [];
  let after = 0;
  for (;;) {
    const page = await api(config, "GET", `/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=1000`);
    if (!Array.isArray(page) || page.length === 0) break;
    events.push(...page);
    after = page[page.length - 1].seq;
    if (page.length < 1000) break;
  }
  return events;
}

function analyzeParallelism(events) {
  const started = events.filter((event) => event.type === "subagent.started");
  const waveStarted = events.filter((event) => event.type === "subagents.wave_started");
  // Attribute each start to the wave it fell into so "across waves" is provable.
  let waveIndex = 0;
  const startsPerWave = new Map();
  for (const event of events) {
    if (event.type === "subagents.wave_started") waveIndex += 1;
    else if (event.type === "subagent.started") {
      startsPerWave.set(waveIndex, (startsPerWave.get(waveIndex) ?? 0) + 1);
    }
  }
  return {
    startedCount: started.length,
    waveStartedCount: waveStarted.length,
    wavesWithStarts: [...startsPerWave.keys()].length,
    startsPerWave: Object.fromEntries([...startsPerWave.entries()].sort((a, b) => a[0] - b[0])),
    pass: started.length >= 2 && waveStarted.length >= 1,
  };
}

function formatRunLine(summary) {
  return [
    `run=${summary.id}`,
    `state=${summary.state}`,
    `rounds=${summary.rounds}`,
    `checks=${summary.checksPassed}/${summary.checksTotal}`,
    `modelCalls=${summary.modelCalls}`,
    `findings=${summary.findingsResolved}/${summary.findingsTotal}`,
    `diff=${summary.diffPresent ? "present" : "missing"}`,
  ].join("  ");
}

// ---------------------------------------------------------------- main
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usageAndExit(error instanceof Error ? error.message : String(error));
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let config;
  try {
    config = readConfig(options);
  } catch (error) {
    usageAndExit(error instanceof Error ? error.message : String(error));
  }

  const plan = {
    baseUrl: config.baseUrl,
    auth: config.devEmail ? `dev-email ${maskEmail(config.devEmail)}` : "cloudflare service token",
    internalToken: config.internalToken ? "present" : "absent",
    workspaceId: config.workspaceId || "(auto: first clean active workspace)",
    mode: options.parallelFixture ? "parallel-fixture" : `standard x${config.runs}`,
    checks: config.checks,
    models: `${config.developerModel ? `${config.developerModel.provider}:${config.developerModel.model}` : "(server default)"} / ${config.reviewerModel ? `${config.reviewerModel.provider}:${config.reviewerModel.model}` : "(server default)"}`,
    timeoutMs: config.timeoutMs,
    pollMs: config.pollMs,
  };

  if (options.dryRun) {
    console.log("[drill:providers] dry-run — no network calls will be made.");
    for (const [key, value] of Object.entries(plan)) console.log(`  ${key}: ${value}`);
    console.log(`  runs to create: ${options.parallelFixture ? 1 : config.runs}`);
    console.log(`  task: ${config.task.slice(0, 160)}${config.task.length > 160 ? "…" : ""}`);
    process.exit(0);
  }

  console.log(`[drill:providers] target ${plan.baseUrl} (auth: ${plan.auth}, internal token: ${plan.internalToken})`);
  const workspace = await preflight(config);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const runIds = [];
  if (options.parallelFixture) {
    const run = await createRun(config, workspace, 0, config.task, stamp, true);
    runIds.push({ id: run.id, fixture: true });
  } else {
    for (let index = 0; index < config.runs; index += 1) {
      // Sequential creation keeps the deployment's per-user rate limit happy.
      const run = await createRun(config, workspace, index, config.task, stamp, false);
      runIds.push({ id: run.id, fixture: false });
    }
  }

  const summaries = [];
  const failures = [];
  let parallelResult = null;

  for (const entry of runIds) {
    const { run, timedOut } = await pollRun(config, entry.id);
    const summary = await summarizeRun(config, run);
    summary.timedOut = timedOut;
    summaries.push(summary);

    if (entry.fixture) {
      const events = await fetchAllEvents(config, entry.id);
      parallelResult = analyzeParallelism(events);
      console.log(
        `[drill:providers] parallel fixture: subagent.started=${parallelResult.startedCount} waves=${parallelResult.waveStartedCount} wavesWithStarts=${parallelResult.wavesWithStarts} -> ${parallelResult.pass ? "PASS" : "FAIL"}`,
      );
      if (!parallelResult.pass) failures.push(`${entry.id}: parallel split not observed (needs >=2 subagent.started across >=1 wave)`);
    }

    if (timedOut) {
      failures.push(`${entry.id}: timed out after ${config.timeoutMs} ms (last state ${run.state})`);
      if (config.options.cancelOnTimeout) {
        await api(config, "POST", `/api/runs/${encodeURIComponent(entry.id)}/cancel`).catch((error) =>
          console.error(`[drill:providers]   cancel ${entry.id} failed: ${error.message}`),
        );
        console.error(`[drill:providers]   cancelled ${entry.id} after timeout`);
      }
    } else if (!ACCEPTED_TERMINAL.has(run.state)) {
      failures.push(`${entry.id}: terminal state ${run.state}`);
    }
  }

  console.log("\n[drill:providers] per-run summary");
  for (const summary of summaries) console.log(`  ${formatRunLine(summary)}${summary.timedOut ? "  TIMEOUT" : ""}`);

  const record = {
    at: new Date().toISOString(),
    baseUrl: config.baseUrl,
    workspaceId: workspace.id,
    mode: options.parallelFixture ? "parallel-fixture" : "standard",
    runs: summaries,
    parallel: parallelResult,
    failures,
    pass: failures.length === 0,
  };
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    const file = path.join(options.out, `provider-drill-${stamp}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    console.log(`[drill:providers] wrote ${file}`);
  }

  if (failures.length > 0) {
    console.log(`\n[drill:providers] FAIL (${failures.length}):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\n[drill:providers] PASS");
}

try {
  await main();
} catch (error) {
  console.error(`[drill:providers] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
