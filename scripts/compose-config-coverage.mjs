#!/usr/bin/env node
/**
 * Config coverage check for deploy/docker/compose.yaml (v0.22, B3).
 *
 * The v0.22 review found that the standard Compose file never passed the newer
 * `PI_*` settings, so features existed in code but could not be enabled in a
 * standard deployment. This module is the regression guard: it asserts that the
 * compose file forwards every critical environment variable to the service that
 * actually reads it, and that the deployment-log directory is mounted into the
 * web container read-only.
 *
 * It is a *pure text* check (no Docker daemon, no `docker compose config`), so it
 * runs everywhere the rest of the local gate runs. `validate-compose.mjs` calls
 * `checkComposeCoverage` after its structural checks; the CLI form (`npm run
 * test:config`) prints the missing variables as a diff and exits non-zero.
 *
 * Adding a critical variable: extend `CRITICAL_ENV` below. The check derives
 * everything else from the file, so it cannot silently pass by listing a var
 * that is not actually wired.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Curated list of critical variables, grouped by the service that reads them in
 * the source (`src/server/**` → web, `src/worker/**` → worker). Keep this in
 * sync with the real `process.env.PI_*` reads; the mapping is asserted, not the
 * values.
 */
export const CRITICAL_ENV = {
  web: [
    // model catalog / credential probing (AUD-08)
    "PI_MODEL_CATALOG_JSON",
    "PI_MODEL_PROBE_MODE",
    "PI_PROVIDER_PROBE_BASE_URL",
    "PI_STARTUP_CREDENTIAL_PROBE_BUDGET_MS",
    // closure/approval automation (docs/10 A1/A2)
    "PI_MERGE_REQUEST_URL",
    "PI_MERGE_REQUEST_TOKEN",
    "PI_MERGE_REQUEST_PROJECT",
    "PI_MERGE_REQUEST_TARGET_BRANCH",
    "PI_POST_MERGE_DEPLOY_HOOK",
    "PI_POST_MERGE_DEPLOY_TOKEN",
    // deployment panel (docs/10 A3)
    "PI_WEB_VERSION",
    "PI_WORKER_VERSION",
    "PI_ROLLBACK_TAGS",
    "PI_DEPLOY_LOG",
    // run budgets / limits (COST-002, SEC-008)
    "PI_RUN_MAX_TOKENS",
    "PI_RUN_MAX_COST_USD",
    "PI_RUN_MAX_MODEL_CALLS",
    "PI_RUN_MAX_DURATION_SECONDS",
    "PI_RUN_CREATE_PER_MINUTE",
    "PI_RUN_ACTIONS_PER_MINUTE",
    "PI_ARTIFACT_MAX_DOWNLOAD_BYTES",
    "PI_JOB_STALE_SECONDS",
    // alerts / pipeline / workspaces
    "PI_ALERT_WEBHOOK",
    "PI_ALERT_COOLDOWN_SECONDS",
    "PI_PIPELINE_VERSION",
    "PI_WORKSPACES_ENABLED",
    // decision plane / Jev (docs/26). Engine defaults to disabled and every
    // empty value falls back to the documented default; TYPESAFE_API_KEY is the
    // secret read by `PI_DECISION_ENGINE=jev` and stays empty by default.
    "PI_DECISION_ENGINE",
    "PI_JEV_MODE",
    "PI_JEV_BASE_URL",
    "PI_JEV_MODEL",
    "PI_JEV_TIMEOUT_MS",
    "PI_JEV_MAX_ATTEMPTS",
    "PI_JEV_STATE_MAX_TOKENS",
    "PI_JEV_STATE_MAX_BYTES",
    "PI_JEV_REVIEW_MAX_FINDINGS",
    "PI_JEV_SHADOW_SAMPLE_RATE",
    "PI_JEV_POLICY_VERSION",
    "PI_JEV_ALLOW_SOURCE",
    "TYPESAFE_API_KEY",
  ],
  worker: [
    // plugins (GAP-02)
    "PI_PLUGIN_ALLOWLIST",
    "PI_PLUGIN_REQUESTS",
    "PI_PLUGIN_REQUIRE_PIN",
    "PI_PLUGIN_ALLOW_PROJECT",
    "PI_PLUGIN_CONTAINER_DIR",
    // plugins (Sprint 2: SHA-256 pinned registry)
    "PI_PLUGIN_REGISTRY",
    // run budgets (COST-002)
    "PI_RUN_MAX_TOKENS",
    "PI_RUN_MAX_COST_USD",
    "PI_RUN_MAX_MODEL_CALLS",
    "PI_RUN_MAX_DURATION_SECONDS",
    // disk watermarks (REL-010)
    "PI_MIN_FREE_DISK_MB",
    "PI_CRITICAL_FREE_DISK_MB",
    // provider retry / planner / limits
    "PI_PROVIDER_ATTEMPTS",
    "PI_PROVIDER_BACKOFF_MS",
    "PI_PROVIDER_MAX_BACKOFF_MS",
    "PI_PLANNER_THINKING",
    "PI_REVIEWER_THINKING",
    "PI_REVIEW_RETRY_MAX_ELAPSED_SECONDS",
    "PI_REVIEW_CONVERGENCE_GUARD",
    "PI_REVIEW_STALL_ROUNDS",
    "PI_REVIEW_FILE_DIFF_BYTES",
    "PI_REVIEW_TOTAL_DIFF_BYTES",
    // Sprint 2 session-reuse A/B switch (default on)
    "PI_SESSION_REUSE",
    "PI_CALLBACK_MAX_BYTES",
    "PI_WORKSPACE_LOCK_STALE_SECONDS",
    // identity / sandbox plumbing
    "PI_WORKER_ID",
    "PI_WORKER_VERSION",
    "PI_DOCKER_SOCKET",
    "PI_DOCKER_API_VERSION",
    "PI_GIT_EMPTY_CONFIG",
    "PI_SANDBOX_EXTRA_BINDS",
    "PI_SANDBOX_EXTRA_ENV",
    // decision plane / Jev opt-in trigger (docs/26)
    "PI_JEV_MODE",
  ],
};

/**
 * Non-`PI_*` names that are legitimately read by a service and therefore allowed
 * in `CRITICAL_ENV`. Currently only the decision-plane secret: it must be
 * forwarded so `PI_DECISION_ENGINE=jev` can authenticate, but it is never given
 * a value here or in the compose files (see the reverse guard below).
 */
export const ALLOWED_NON_PI_ENV = new Set(["TYPESAFE_API_KEY"]);

/**
 * The deployment log must be readable by the web container, and mounted
 * read-only. `pathFragment` is the container-side directory that `PI_DEPLOY_LOG`
 * points into.
 */
export const DEPLOY_LOG_MOUNT = {
  service: "web",
  pathFragment: "/app/pi-agent/backups",
  readOnly: true,
};

/**
 * Files/directories a critical variable points at and that must therefore be
 * mounted into the container that reads them. `label` is used verbatim in the
 * failure message so a broken mount produces a precise diff.
 */
export const CRITICAL_MOUNTS = [
  { label: "deployment log", ...DEPLOY_LOG_MOUNT },
  { label: "plugin registry", service: "worker", pathFragment: "/app/pi-agent/pi-plugins.json", readOnly: true },
];

/** Extract one service block: from `  <name>:` to the next 2-space service key. */
export function serviceBlock(lines, name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z]/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** List items under a `    <section>:` block (`      - value`). */
export function listItems(block, section) {
  if (!block) return [];
  const start = block.findIndex((line) => line.trim() === `${section}:`);
  if (start === -1) return [];
  const items = [];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (/^    [a-zA-Z_]/.test(line)) break;
    const match = line.match(/^      -\s+(.+)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

/** Environment variable names under a service's `environment:` map. */
export function environmentKeys(block) {
  if (!block) return [];
  const start = block.findIndex((line) => line.trim() === "environment:");
  if (start === -1) return [];
  const keys = [];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (/^    [a-zA-Z_]/.test(line)) break;
    const match = line.match(/^      ([A-Za-z_][A-Za-z0-9_]*):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * @param {string} text raw compose.yaml
 * @param {{ criticalEnv?: Record<string, string[]>, mounts?: typeof CRITICAL_MOUNTS }} [spec]
 * @returns {{ problems: string[], services: Record<string, { env: string[], volumes: string[] }> }}
 */
export function checkComposeCoverage(text, spec = {}) {
  const criticalEnv = spec.criticalEnv ?? CRITICAL_ENV;
  const mounts = spec.mounts ?? CRITICAL_MOUNTS;
  const lines = text.split("\n");
  const services = {};
  const problems = [];

  for (const [service, vars] of Object.entries(criticalEnv)) {
    const block = serviceBlock(lines, service);
    if (!block) {
      problems.push(`service "${service}" not found — cannot verify ${vars.length} variable(s)`);
      continue;
    }
    const env = environmentKeys(block);
    services[service] = { env, volumes: listItems(block, "volumes") };
    for (const name of vars) {
      if (!env.includes(name)) {
        problems.push(`${service}: missing environment variable ${name}`);
      }
    }
  }

  for (const mount of mounts) {
    const block = serviceBlock(lines, mount.service);
    const volumes = listItems(block, "volumes");
    services[mount.service] ??= { env: environmentKeys(block), volumes };
    const found = volumes.find((entry) => entry.includes(mount.pathFragment));
    if (!found) {
      problems.push(`${mount.service}: ${mount.label} not mounted (expected a volume containing ${mount.pathFragment})`);
    } else if (mount.readOnly && !/:ro(?:,|$)/.test(found)) {
      problems.push(`${mount.service}: ${mount.label} mount must be read-only (:ro): ${found}`);
    }
  }

  // Reverse guard: every curated variable must be a known env name (a `PI_*`
  // feature knob, or an explicitly allowlisted non-`PI_*` secret), so a typo here
  // is caught instead of silently never matching the compose file.
  for (const [service, vars] of Object.entries(criticalEnv)) {
    for (const name of vars) {
      if (!/^PI_[A-Z0-9_]+$/.test(name) && !ALLOWED_NON_PI_ENV.has(name)) {
        problems.push(`curated list has an invalid variable name: ${service}/${name}`);
      }
    }
  }

  return { problems, services };
}

/** Render the problems as a compact diff-style report. */
export function renderProblems(problems) {
  return problems.map((problem) => ` - ${problem}`).join("\n");
}

const file = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "deploy", "docker", "compose.yaml");

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`compose config coverage

Usage:
  npm run test:config            # verify every critical PI_* var is wired
  npm run test:config -- --json  # machine-readable result

Exit code: 0 when the compose file forwards every curated variable to the right
service and mounts the deployment log read-only; 1 otherwise.`);
    process.exit(0);
  }
  const text = readFileSync(file, "utf8");
  const { problems, services } = checkComposeCoverage(text);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems, services }, null, 2));
  } else if (problems.length > 0) {
    console.error(`compose config coverage FAILED (${problems.length} problem(s)):`);
    console.error(renderProblems(problems));
    console.error("\nFix deploy/docker/compose.yaml (and mirror the variable in .env.example).");
  } else {
    const total = Object.values(CRITICAL_ENV).reduce((sum, vars) => sum + vars.length, 0);
    console.log(`compose config coverage OK (${total} critical env entries + ${CRITICAL_MOUNTS.length} mount(s))`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
