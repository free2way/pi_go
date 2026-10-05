/**
 * Regression test for the v0.22 compose config coverage (B3).
 *
 * Vitest only collects `src/**`, so this runs with `node --test` (see
 * `npm run test:config`, also included in `npm run test:scripts`). It asserts
 * the *real* deploy/docker/compose.yaml forwards every curated critical PI_*
 * variable, then proves the checker fails loudly when one is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CRITICAL_ENV, checkComposeCoverage, environmentKeys, listItems, serviceBlock } from "./compose-config-coverage.mjs";

const composePath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "deploy", "docker", "compose.yaml");
const composeText = readFileSync(composePath, "utf8");

test("real compose.yaml forwards every curated critical variable", () => {
  const { problems } = checkComposeCoverage(composeText);
  assert.deepEqual(problems, [], `compose config coverage problems:\n${problems.join("\n")}`);
});

test("curated list covers the v0.22 features named by the review", () => {
  const web = new Set(CRITICAL_ENV.web);
  const worker = new Set(CRITICAL_ENV.worker);
  for (const name of ["PI_MODEL_CATALOG_JSON", "PI_MERGE_REQUEST_URL", "PI_MERGE_REQUEST_TOKEN", "PI_POST_MERGE_DEPLOY_HOOK", "PI_POST_MERGE_DEPLOY_TOKEN", "PI_WEB_VERSION", "PI_WORKER_VERSION", "PI_ROLLBACK_TAGS", "PI_DEPLOY_LOG"]) {
    assert.ok(web.has(name), `web must cover ${name}`);
  }
  for (const name of ["PI_PLUGIN_ALLOWLIST", "PI_PLUGIN_REQUESTS", "PI_PLUGIN_REQUIRE_PIN", "PI_PLUGIN_REGISTRY"]) {
    assert.ok(worker.has(name), `worker must cover ${name}`);
  }
  for (const name of ["PI_RUN_MAX_TOKENS", "PI_RUN_MAX_COST_USD", "PI_RUN_MAX_MODEL_CALLS", "PI_RUN_MAX_DURATION_SECONDS"]) {
    assert.ok(web.has(name) && worker.has(name), `both services must cover ${name}`);
  }
});

test("the deployment log directory is mounted read-only into web", () => {
  const webVolumes = listItems(serviceBlock(composeText.split("\n"), "web"), "volumes");
  const mount = webVolumes.find((entry) => entry.includes("/app/pi-agent/backups"));
  assert.ok(mount, "web must mount the deployment log directory");
  assert.match(mount, /:ro(?:,|$)/, "the deployment log mount must be read-only");
});

test("the SHA-256 plugin registry is mounted read-only into worker", () => {
  const workerVolumes = listItems(serviceBlock(composeText.split("\n"), "worker"), "volumes");
  const mount = workerVolumes.find((entry) => entry.includes("/app/pi-agent/pi-plugins.json"));
  assert.ok(mount, "worker must mount the plugin registry file");
  assert.match(mount, /:ro(?:,|$)/, "the plugin registry mount must be read-only");
});

test("checker FAILS when the plugin registry mount is not read-only", () => {
  const rw = composeText.replace(/(\$\{PI_PLUGIN_REGISTRY_HOST_FILE:-\.\/pi-plugins\.example\.json\}:\/app\/pi-agent\/pi-plugins\.json):ro/, "$1");
  assert.notEqual(rw, composeText, "fixture must actually drop the :ro flag");
  const { problems } = checkComposeCoverage(rw);
  assert.ok(
    problems.some((problem) => /plugin registry mount must be read-only/.test(problem)),
    `expected a read-only complaint for the registry, got:\n${problems.join("\n")}`,
  );
});

test("parser reads environment keys and volumes per service", () => {
  const lines = composeText.split("\n");
  const workerEnv = environmentKeys(serviceBlock(lines, "worker"));
  assert.ok(workerEnv.includes("PI_SANDBOX_MODE"));
  const workerVolumes = listItems(serviceBlock(lines, "worker"), "volumes");
  assert.ok(workerVolumes.some((entry) => entry.includes("/var/run/docker.sock")));
});

test("checker FAILS with a clear diff when a variable is missing", () => {
  const withoutRollback = composeText.replace(/^ {6}PI_ROLLBACK_TAGS:.*\n/m, "");
  assert.notEqual(withoutRollback, composeText, "fixture must actually remove the variable");
  const { problems } = checkComposeCoverage(withoutRollback);
  assert.ok(
    problems.some((problem) => /web: missing environment variable PI_ROLLBACK_TAGS/.test(problem)),
    `expected a precise missing-variable diff, got:\n${problems.join("\n")}`,
  );
});

test("checker FAILS when the deploy-log mount is not read-only", () => {
  const rw = composeText.replace(/(\$\{PI_DEPLOY_LOG_HOST_DIR:-\.\/backups\}:\/app\/pi-agent\/backups):ro/, "$1");
  const { problems } = checkComposeCoverage(rw);
  assert.ok(
    problems.some((problem) => /deployment log mount must be read-only/.test(problem)),
    `expected a read-only complaint, got:\n${problems.join("\n")}`,
  );
});
