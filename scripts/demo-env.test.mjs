/**
 * Unit tests for the demo/acceptance environment driver (`scripts/demo-env.sh`
 * + `scripts/demo-env-lib.mjs`).
 *
 * Run with `npm run test:scripts` (node --test). Everything here is pure: no
 * Docker daemon, no network, no filesystem writes, no real secrets. The point is
 * to lock in the safety invariant (the demo stack may only ever talk to
 * `pigo_demo`), the token/version consistency reporting and the fail-closed
 * refusal paths before an operator ever runs `up` on a real host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEMO_DB_NAME,
  DEMO_STORIES,
  DEFAULT_COMPOSE_FILE,
  checkDbSafety,
  checkDemoCompose,
  checkSecretParity,
  checkVersionParity,
  credentialPreflight,
  dbNameOf,
  fingerprintValue,
  maskUrl,
  parseEnvFile,
  planSeedActions,
  resolveDbTarget,
} from "./demo-env-lib.mjs";

const composeText = readFileSync(DEFAULT_COMPOSE_FILE, "utf8");
const codeLines = composeText
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

// ---------------------------------------------------------------------------
// The safety invariant: only /pigo_demo may ever be resolved.
// ---------------------------------------------------------------------------

test("db safety: accepts a postgresql URL ending in /pigo_demo", () => {
  const target = resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo_demo");
  assert.equal(target.ok, true, "a demo URL must be accepted");
  assert.equal(target.dbName, DEMO_DB_NAME);
});

test("db safety: accepts the postgres:// scheme variant", () => {
  assert.equal(resolveDbTarget("postgres://user:pw@host:5432/pigo_demo").ok, true);
});

test("db safety: rejects the production database /pigo", () => {
  const target = resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo");
  assert.equal(target.ok, false, "the production DB must never be accepted");
  assert.equal(target.reason, "not-demo");
});

test("db safety: rejects /pigo_test", () => {
  const target = resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo_test");
  assert.equal(target.ok, false);
  assert.equal(target.dbName, "pigo_test");
});

test("db safety: rejects an unset URL", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(resolveDbTarget(value).ok, false, `expected ${JSON.stringify(value)} to be rejected`);
  }
  assert.equal(resolveDbTarget(undefined).reason, "missing");
});

test("db safety: rejects trailing whitespace after /pigo_demo", () => {
  for (const suffix of [" ", "\n", "\t", " "]) {
    const target = resolveDbTarget(`postgresql://pigo:secret@postgres:5432/pigo_demo${suffix}`);
    assert.equal(target.ok, false, `trailing ${JSON.stringify(suffix)} must be rejected`);
    assert.equal(target.reason, "whitespace");
  }
});

test("db safety: rejects /pigo_demo/ and /pigo_demo_extra", () => {
  assert.equal(resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo_demo/").ok, false);
  assert.equal(resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo_demo_extra").ok, false);
});

test("db safety: rejects a host that merely contains pigo_demo", () => {
  const target = resolveDbTarget("postgresql://pigo:secret@pigo_demo:5432/pigo");
  assert.equal(target.ok, false);
  assert.equal(target.dbName, "pigo");
});

test("db safety: rejects a URL carrying a query string (fail closed)", () => {
  assert.equal(resolveDbTarget("postgresql://pigo:secret@postgres:5432/pigo_demo?sslmode=disable").ok, false);
});

test("db safety: never echoes the password when reporting a resolved URL", () => {
  const target = resolveDbTarget("postgresql://pigo:sup3r-s3cret@postgres:5432/pigo_demo");
  assert.ok(!target.display.includes("sup3r-s3cret"), "masked display must not contain the password");
  assert.match(target.display, /pigo:\*\*\*@postgres:5432\/pigo_demo/);
  assert.equal(maskUrl("postgresql://u:p@h/db"), "postgresql://u:***@h/db");
  assert.equal(maskUrl("postgresql://h/db"), "postgresql://h/db");
  assert.equal(dbNameOf("postgresql://u:p@h:5432/pigo_demo"), "pigo_demo");
});

test("checkDbSafety: reports every resolved URL and refuses when any service points at prod", () => {
  const safe = checkDbSafety([
    { source: "demo-web.PI_DATABASE_URL", url: "postgresql://pigo:pw@postgres:5432/pigo_demo" },
  ]);
  assert.equal(safe.ok, true);
  assert.equal(safe.problems.length, 0);
  assert.equal(safe.resolved.length, 1);
  assert.equal(safe.resolved[0].display, "postgresql://pigo:***@postgres:5432/pigo_demo");

  const unsafe = checkDbSafety([
    { source: "demo-web.PI_DATABASE_URL", url: "postgresql://pigo:pw@postgres:5432/pigo_demo" },
    { source: "demo-web.DATABASE_URL", url: "postgresql://pigo:pw@postgres:5432/pigo" },
  ]);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.problems.length, 1);
  assert.match(unsafe.problems[0], /demo-web\.DATABASE_URL/);
  assert.match(unsafe.problems[0], /pigo_demo/);
});

// ---------------------------------------------------------------------------
// Token / version consistency reporting (never prints secret values).
// ---------------------------------------------------------------------------

test("token parity: reports a match with length and hash, never the secret", () => {
  const token = "s3cr3t-internal-token-value";
  const result = checkSecretParity("PI_INTERNAL_TOKEN", token, token);
  assert.equal(result.ok, true);
  assert.match(result.report, /match/);
  assert.match(result.report, new RegExp(`len=${token.length}`));
  assert.ok(!result.report.includes(token), "the report must not contain the token value");
  assert.match(result.report, /sha256:[0-9a-f]{12}/);
});

test("token parity: reports a mismatch with both lengths", () => {
  const result = checkSecretParity("PI_INTERNAL_TOKEN", "aaaaaaaa", "bbbbbbbbbbbb");
  assert.equal(result.ok, false);
  assert.match(result.report, /MISMATCH/);
  assert.match(result.report, /web len=8/);
  assert.match(result.report, /worker len=12/);
});

test("token parity: reports an unset token on either side", () => {
  const result = checkSecretParity("PI_INTERNAL_TOKEN", "", "worker-token");
  assert.equal(result.ok, false);
  assert.match(result.report, /UNSET in web/);
});

test("fingerprintValue: presence/length only", () => {
  assert.deepEqual(fingerprintValue(""), { present: false, length: 0, digest: null });
  const printed = fingerprintValue("abcdef");
  assert.equal(printed.present, true);
  assert.equal(printed.length, 6);
  assert.match(printed.digest, /^[0-9a-f]{12}$/);
});

test("version parity: one shared version string passes", () => {
  const result = checkVersionParity("version", [
    { source: "demo-web.PI_WEB_VERSION", value: "demo-0.27.1" },
    { source: "demo-worker.PI_WORKER_VERSION", value: "demo-0.27.1" },
  ]);
  assert.equal(result.ok, true);
  assert.match(result.report, /demo-0\.27\.1/);
});

test("version parity: divergent web/worker versions fail and name both", () => {
  const result = checkVersionParity("version", [
    { source: "demo-web.PI_WEB_VERSION", value: "demo-a" },
    { source: "demo-worker.PI_WORKER_VERSION", value: "demo-b" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.report, /MISMATCH/);
  assert.match(result.report, /demo-web\.PI_WEB_VERSION=demo-a/);
  assert.match(result.report, /demo-worker\.PI_WORKER_VERSION=demo-b/);
});

test("version parity: an unset version fails with the env hint", () => {
  const result = checkVersionParity("version", [{ source: "PIGO_DEMO_VERSION", value: "" }]);
  assert.equal(result.ok, false);
  assert.match(result.report, /PIGO_DEMO_VERSION/);
});

// ---------------------------------------------------------------------------
// Refusal paths: credential file and resolved-compose structure.
// ---------------------------------------------------------------------------

test("credential preflight: refuses a missing vault file", () => {
  const result = credentialPreflight("/host/demo-data/credentials.v1.json", { exists: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
  assert.match(result.message, /not found/);
});

test("credential preflight: refuses an unreadable vault file", () => {
  const result = credentialPreflight("/host/credentials.v1.json", {
    exists: () => true,
    read: () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreadable");
  assert.match(result.message, /EACCES/);
});

test("credential preflight: refuses invalid JSON and non-v2 vaults", () => {
  const invalid = credentialPreflight("/host/credentials.v1.json", { exists: () => true, read: () => "not json" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-json");

  const legend = credentialPreflight("/host/credentials.v1.json", { exists: () => true, read: () => JSON.stringify({ version: 1, users: {} }) });
  assert.equal(legend.ok, false);
  assert.equal(legend.reason, "wrong-version");
});

test("credential preflight: accepts a v2 vault and reports bytes, not contents", () => {
  const raw = JSON.stringify({ version: 2, users: { owner: { providers: { deepseek: { apiKey: { iv: "x", ciphertext: "y", tag: "z" } } } } } });
  const result = credentialPreflight("/host/credentials.v1.json", { exists: () => true, read: () => raw });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, raw.length);
  assert.ok(!result.message.includes("ciphertext"), "the message must not include vault contents");
});

/** A minimal, well-formed resolved compose config (as `docker compose config --format json`). */
function demoConfig(overrides = {}) {
  return {
    services: {
      "demo-web": {
        environment: {
          NODE_ENV: "development",
          HOST: "0.0.0.0",
          PI_AUTH_MODE: "development",
          PI_DATABASE_URL: "postgresql://pigo:pw@postgres:5432/pigo_demo",
          PI_VAULT_FILE: "/app/data/credentials.v1.json",
          PI_INTERNAL_TOKEN: "token-abc",
          PI_WEB_VERSION: "demo-0.27.1",
        },
        volumes: [{ type: "bind", source: "/app/pi-agent/demo-data", target: "/app/data" }],
        ports: [{ mode: "host", target: 3100, published: "3101", host_ip: "192.168.2.235" }],
      },
      "demo-worker": {
        environment: {
          PI_WEB_CALLBACK_URL: "http://demo-web:3100",
          PI_INTERNAL_TOKEN: "token-abc",
          PI_WORKER_VERSION: "demo-0.27.1",
          PI_SANDBOX_MODE: "auto",
        },
        volumes: [
          { type: "bind", source: "/app/pi-agent/demo-workspace", target: "/workspace" },
          { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
        ],
        group_add: ["983"],
      },
      ...(overrides.services ?? {}),
    },
  };
}

function withServiceOverride(name, patch) {
  const config = demoConfig();
  config.services[name] = { ...config.services[name], ...patch, environment: { ...config.services[name].environment, ...(patch.environment ?? {}) } };
  return config;
}

test("checkDemoCompose: accepts a well-formed demo config", () => {
  const result = checkDemoCompose(demoConfig());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.facts.sandboxMode, "auto");
});

test("checkDemoCompose: refuses a production database URL", () => {
  const config = withServiceOverride("demo-web", { environment: { PI_DATABASE_URL: "postgresql://pigo:pw@postgres:5432/pigo" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /demo-web\.PI_DATABASE_URL/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses a /tmp vault path", () => {
  const config = withServiceOverride("demo-web", { environment: { PI_VAULT_FILE: "/tmp/credentials.v1.json" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /PI_VAULT_FILE/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses a callback into the production web service", () => {
  const config = withServiceOverride("demo-worker", { environment: { PI_WEB_CALLBACK_URL: "http://web:3100" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /PI_WEB_CALLBACK_URL/.test(problem)), problems.join("\n"));
});

test("checkDemoCompose: refuses token/version drift and a missing docker socket", () => {
  const config = withServiceOverride("demo-worker", {
    environment: { PI_INTERNAL_TOKEN: "different", PI_WORKER_VERSION: "demo-other" },
    volumes: [{ type: "bind", source: "/app/pi-agent/demo-workspace", target: "/workspace" }],
    group_add: [],
  });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  const joined = problems.join("\n");
  assert.match(joined, /PI_INTERNAL_TOKEN.*MISMATCH/);
  assert.match(joined, /VERSION: MISMATCH/i);
  assert.match(joined, /docker\.sock/);
  assert.match(joined, /group_add/);
});

test("checkDemoCompose: refuses a config that disables development auth", () => {
  const config = withServiceOverride("demo-web", { environment: { NODE_ENV: "production", PI_AUTH_MODE: "cloudflare" } });
  const { ok, problems } = checkDemoCompose(config);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => /NODE_ENV/.test(problem)));
  assert.ok(problems.some((problem) => /PI_AUTH_MODE/.test(problem)));
});

// ---------------------------------------------------------------------------
// The real compose.demo.yaml: text-level regression guards (no Docker needed).
// ---------------------------------------------------------------------------

test("compose.demo.yaml hard-wires the demo database and never the production one", () => {
  assert.match(codeLines, /@postgres:5432\/pigo_demo/);
  assert.ok(!/:5432\/pigo(?!_demo)/.test(codeLines), "the file must not reference the production database");
});

test("compose.demo.yaml mounts the host vault at the expected path and not /tmp", () => {
  assert.match(codeLines, /PI_VAULT_FILE: \/app\/data\/credentials\.v1\.json/);
  assert.ok(!/PI_VAULT_FILE: \/tmp/.test(codeLines));
  assert.match(codeLines, /\$\{PIGO_DEMO_DATA_DIR:\?[^}]*\}:\/app\/data/);
});

test("compose.demo.yaml keeps the sandbox fail-closed by default", () => {
  assert.match(codeLines, /PI_SANDBOX_MODE: \$\{PI_SANDBOX_MODE:-auto\}/);
  assert.ok(
    !/^\s*PI_SANDBOX_ALLOW_DEGRADED:/m.test(codeLines),
    "PI_SANDBOX_ALLOW_DEGRADED must stay commented out (fail-closed) by default",
  );
  assert.match(composeText, /#\s*PI_SANDBOX_ALLOW_DEGRADED: "1"/);
  assert.match(composeText, /fail-closed/i);
});

test("compose.demo.yaml joins the existing production network and exposes the demo ports", () => {
  assert.match(codeLines, /name: pi-agent-network/);
  assert.match(codeLines, /external: true/);
  assert.match(codeLines, /published: "\$\{PIGO_DEMO_WEB_PORT:-3101\}"/);
  assert.match(codeLines, /published: "\$\{PIGO_DEMO_WEB_LOOPBACK_PORT:-3102\}"/);
  assert.match(codeLines, /host_ip: \$\{PIGO_DEMO_WEB_BIND_ADDRESS:-192\.168\.2\.235\}/);
});

test("compose.demo.yaml gives the worker the docker socket and its gid", () => {
  assert.match(codeLines, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(codeLines, /group_add:\s*\n\s*-\s*"\$\{PIGO_DEMO_DOCKER_GID:-983\}"/);
});

test("compose.demo.yaml preflight script is free of compose interpolation", () => {
  const preflightStart = composeText.indexOf("demo-preflight:");
  const entrypointStart = composeText.indexOf("entrypoint:", preflightStart);
  const entrypointEnd = composeText.indexOf("\n    networks:", entrypointStart);
  const script = composeText.slice(entrypointStart, entrypointEnd);
  assert.ok(script.includes("readFileSync"), "preflight must read the mounted vault");
  assert.ok(
    !script.includes("${"),
    "the inline preflight JS must not contain ${...} — docker compose would interpolate and mangle it",
  );
});

test("compose.demo.yaml allows the worker to reach the demo web service by name", () => {
  assert.match(codeLines, /PI_WEB_CALLBACK_URL: http:\/\/demo-web:3100/);
  assert.ok(!/PI_WEB_CALLBACK_URL: http:\/\/web:3100/.test(codeLines));
});

// ---------------------------------------------------------------------------
// Seed idempotency (pure decision logic).
// ---------------------------------------------------------------------------

test("planSeedActions: an empty environment creates the project, sprint and every story", () => {
  const actions = planSeedActions({ projects: [], sprints: [], stories: [] });
  assert.equal(actions.filter((action) => action.kind === "create-project").length, 1);
  assert.equal(actions.filter((action) => action.kind === "create-sprint").length, 1);
  assert.equal(actions.filter((action) => action.kind === "create-story").length, DEMO_STORIES.length);
});

test("planSeedActions: a rerun updates in place and never duplicates", () => {
  const actions = planSeedActions({
    projects: [{ id: "proj_1", key: "DEMO" }],
    sprints: [{ id: "sprint_1", name: "演示冲刺" }],
    stories: DEMO_STORIES.map((story, index) => ({ id: `story_${index}`, title: story.title })),
  });
  assert.equal(actions.filter((action) => action.kind.startsWith("create-")).length, 0);
  assert.deepEqual(
    actions.map((action) => action.id),
    ["proj_1", "sprint_1", ...DEMO_STORIES.map((_story, index) => `story_${index}`)],
  );
});

test("planSeedActions: matching is by key/name/title, not by array position", () => {
  const actions = planSeedActions({
    projects: [{ id: "p", key: "demo" }],
    sprints: [{ id: "s", name: "other sprint" }],
    stories: [{ id: "x", title: "irrelevant" }],
  });
  assert.equal(actions[0].kind, "update-project");
  assert.equal(actions[1].kind, "create-sprint");
  assert.ok(actions.slice(2).every((action) => action.kind === "create-story"));
});

// ---------------------------------------------------------------------------
// Env-file parsing.
// ---------------------------------------------------------------------------

test("parseEnvFile: ignores comments/blank lines and strips quotes", () => {
  const env = parseEnvFile(
    ["# comment", "", "PIGO_DEMO_VERSION=demo-1", "export PIGO_DEMO_WEB_PORT=3101", 'PI_VAULT_SECRET="quoted value"', "X='single'", "no-equals-line"].join("\n"),
  );
  assert.equal(env.PIGO_DEMO_VERSION, "demo-1");
  assert.equal(env.PIGO_DEMO_WEB_PORT, "3101");
  assert.equal(env.PI_VAULT_SECRET, "quoted value");
  assert.equal(env.X, "single");
});
