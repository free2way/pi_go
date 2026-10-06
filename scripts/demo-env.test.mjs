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
  DEFAULT_ENV_FILE,
  EXAMPLE_ENV_FILE,
  OUTSIDE_TREE_ENV_FILE,
  REPO_ROOT,
  checkDbSafety,
  checkDemoCompose,
  checkSecretParity,
  checkVersionParity,
  credentialPreflight,
  dbNameOf,
  detectDeployReplacedEnvFile,
  envFileHeader,
  envFileLine,
  envFileLocationCheck,
  fingerprintValue,
  maskUrl,
  parseEnvFile,
  planSeedActions,
  resolveDbTarget,
  resolveDemoEnvFile,
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
  const target = resolveDbTarget("postgresql://pigo:DUMMY_SUPER_SECRET@postgres:5432/pigo_demo");
  assert.ok(!target.display.includes("DUMMY_SUPER_SECRET"), "masked display must not contain the password");
  assert.match(target.display, /pigo:\*\*\*@postgres:5432\/pigo_demo/);
  assert.equal(maskUrl("postgresql://u:DUMMY_PASSWORD@h/db"), "postgresql://u:***@h/db");
  assert.equal(maskUrl("postgresql://h/db"), "postgresql://h/db");
  assert.equal(dbNameOf("postgresql://u:DUMMY_PASSWORD@h:5432/pigo_demo"), "pigo_demo");
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
        volumes: [
          { type: "bind", source: "/app/pi-agent/demo-data", target: "/app/data" },
          { type: "bind", source: "/app/pi-agent/demo-workspace", target: "/workspace" },
        ],
        ports: [{ mode: "host", target: 3100, published: "3101", host_ip: "0.0.0.0" }],
      },
      "demo-worker": {
        environment: {
          PI_WEB_CALLBACK_URL: "http://demo-web:3100",
          PI_INTERNAL_TOKEN: "token-abc",
          PI_WORKER_VERSION: "demo-0.27.1",
          PI_SANDBOX_MODE: "auto",
          PI_WORKSPACE_ROOT: "/workspace",
          PI_HOST_WORKSPACE_ROOT: "/app/pi-agent/demo-workspace",
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
  assert.match(codeLines, /host_ip: \$\{PIGO_DEMO_WEB_BIND_ADDRESS:\?[^}]*\}/);
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

// ---------------------------------------------------------------------------
// Env-file resolution and the deploy-recurrence guard.
//
// Incident: `deploy/docker/demo.env` was git-ignored and kept inside the
// deployed tree (`/app/pi-agent/source/…`). Every deploy does
// `mv source source.prevN-…` + extracts a fresh `source/`, so the file vanished
// and the demo stack could not be recreated. Resolution must therefore prefer a
// path outside the tree, and `doctor` must flag the risky location.
// ---------------------------------------------------------------------------

/** Deterministic `exists`/`readdir` doubles — no filesystem, no Docker. */
function fakeIo(present = [], dirs = {}) {
  const set = new Set(present);
  return {
    exists: (target) => set.has(target),
    readdir: (dir) => {
      if (Object.prototype.hasOwnProperty.call(dirs, dir)) return dirs[dir];
      const error = new Error(`ENOENT: ${dir}`);
      error.code = "ENOENT";
      throw error;
    },
  };
}

test("env-file resolution: an explicit PIGO_DEMO_ENV_FILE override wins over every convention", () => {
  const override = "/srv/secrets/pigo-demo.env";
  const io = fakeIo([override, OUTSIDE_TREE_ENV_FILE, DEFAULT_ENV_FILE, EXAMPLE_ENV_FILE]);
  const info = resolveDemoEnvFile({ env: { PIGO_DEMO_ENV_FILE: override }, io });
  assert.equal(info.path, override);
  assert.equal(info.source, "override");
  assert.equal(info.overrideVar, "PIGO_DEMO_ENV_FILE");
  assert.equal(info.isExample, false);
  assert.equal(info.error, null);
});

test("env-file resolution: the legacy DEMO_ENV_FILE is honoured after PIGO_DEMO_ENV_FILE", () => {
  const legacy = resolveDemoEnvFile({ env: { DEMO_ENV_FILE: "/srv/legacy.env" }, io: fakeIo(["/srv/legacy.env"]) });
  assert.equal(legacy.source, "override");
  assert.equal(legacy.overrideVar, "DEMO_ENV_FILE");

  const both = resolveDemoEnvFile({
    env: { PIGO_DEMO_ENV_FILE: "/srv/a.env", DEMO_ENV_FILE: "/srv/b.env" },
    io: fakeIo(["/srv/a.env", "/srv/b.env"]),
  });
  assert.equal(both.path, "/srv/a.env", "PIGO_DEMO_ENV_FILE must win over the legacy alias");
});

test("env-file resolution: a missing override fails loudly instead of falling through", () => {
  const info = resolveDemoEnvFile({ env: { PIGO_DEMO_ENV_FILE: "/nope/demo.env" }, io: fakeIo([OUTSIDE_TREE_ENV_FILE]) });
  assert.equal(info.path, "/nope/demo.env");
  assert.equal(info.exists, false);
  assert.ok(info.error, "a missing override must set an error");
  assert.match(info.error, /PIGO_DEMO_ENV_FILE/);
  assert.match(info.error, /\/nope\/demo\.env/);
});

test("env-file resolution: a path outside the deployed tree wins over the in-repo fallback", () => {
  const info = resolveDemoEnvFile({ env: {}, io: fakeIo([OUTSIDE_TREE_ENV_FILE, DEFAULT_ENV_FILE]) });
  assert.equal(info.path, OUTSIDE_TREE_ENV_FILE);
  assert.equal(info.source, "outside-tree");
  assert.equal(info.error, null);
  assert.ok(info.path.startsWith(REPO_ROOT + "/") === false, "the preferred path must live outside the repo tree");
});

test("env-file resolution: the in-repo file is used only when no outside-tree file exists", () => {
  const info = resolveDemoEnvFile({ env: {}, io: fakeIo([DEFAULT_ENV_FILE]) });
  assert.equal(info.path, DEFAULT_ENV_FILE);
  assert.equal(info.source, "in-repo");
  assert.equal(info.error, null);
});

test("env-file resolution: only the example exists -> actionable error, never a silent default", () => {
  const info = resolveDemoEnvFile({ env: {}, io: fakeIo([EXAMPLE_ENV_FILE]) });
  assert.equal(info.path, EXAMPLE_ENV_FILE);
  assert.equal(info.source, "example");
  assert.equal(info.isExample, true);
  assert.ok(info.error, "the example file must never be accepted silently");
  assert.match(info.error, /example only|demo\.env\.example/);
  assert.match(info.error, /refusing to fall back/);
  assert.ok(info.error.includes(info.recommendedPath), "the fix must name the recommended absolute path");
  assert.match(info.error, /cp deploy\/docker\/demo\.env\.example/);
  assert.match(info.error, /Keep it OUTSIDE/);
});

test("env-file resolution: with nothing present it still names the example and errors", () => {
  const info = resolveDemoEnvFile({ env: {}, io: fakeIo([]) });
  assert.equal(info.path, EXAMPLE_ENV_FILE);
  assert.equal(info.isExample, true);
  assert.ok(info.error);
});

test("env-file resolution: the resolution output carries no env values", () => {
  const secret = "sup3r-s3cret-token";
  const io = fakeIo([OUTSIDE_TREE_ENV_FILE]);
  const info = resolveDemoEnvFile({ env: { PI_INTERNAL_TOKEN: secret, PIGO_POSTGRES_PASSWORD: secret }, io });
  assert.ok(!JSON.stringify(info).includes(secret), "resolution output must never include env values");
});

test("deploy guard: a path outside any source/ tree is safe even with source.prevN siblings", () => {
  const dirs = { "/app/pi-agent": ["source", "source.prev3-20261006", "backups"] };
  const det = detectDeployReplacedEnvFile("/app/pi-agent/demo.env", fakeIo([], dirs));
  assert.equal(det.replaced, false);
  assert.equal(det.treeRoot, null);
});

test("deploy guard: a path inside source/ is flagged and reports the source.prevN evidence", () => {
  const file = "/app/pi-agent/source/deploy/docker/demo.env";
  const dirs = { "/app/pi-agent": ["source", "source.prev2-20261005", "backups"] };
  const det = detectDeployReplacedEnvFile(file, fakeIo([], dirs));
  assert.equal(det.replaced, true);
  assert.equal(det.treeRoot, "/app/pi-agent/source");
  assert.deepEqual(det.prevSiblings, ["source.prev2-20261005"]);
  assert.equal(det.recommendedPath, "/app/pi-agent/demo.env");
});

test("deploy guard: inside source/ is still flagged when no source.prevN sibling can be listed", () => {
  const det = detectDeployReplacedEnvFile("/app/pi-agent/source/deploy/docker/demo.env", fakeIo());
  assert.equal(det.replaced, true);
  assert.deepEqual(det.prevSiblings, []);
});

test("deploy guard: a file inside an already-rotated source.prevN/ is flagged", () => {
  const det = detectDeployReplacedEnvFile("/app/pi-agent/source.prev4-20261006/deploy/docker/demo.env", fakeIo());
  assert.equal(det.replaced, true);
  assert.equal(det.treeRoot, "/app/pi-agent/source.prev4-20261006");
});

test("deploy guard: an ordinary local checkout path is not flagged", () => {
  const det = detectDeployReplacedEnvFile("/opt/pigo/checkout/deploy/docker/demo.env", fakeIo());
  assert.equal(det.replaced, false);
});

test("envFileLocationCheck: safe path PASSes as the single env-file-outside-source check", () => {
  const info = resolveDemoEnvFile({ env: { PIGO_DEMO_ENV_FILE: "/app/pi-agent/demo.env" }, io: fakeIo(["/app/pi-agent/demo.env"]) });
  const check = envFileLocationCheck(info, fakeIo([], { "/app/pi-agent": ["source.prev1-20261006"] }));
  assert.equal(check.name, "env-file-outside-source");
  assert.equal(check.ok, true);
});

test("envFileLocationCheck: FAILs inside source/ and names the exact move target", () => {
  const file = "/app/pi-agent/source/deploy/docker/demo.env";
  const info = resolveDemoEnvFile({ env: { PIGO_DEMO_ENV_FILE: file }, io: fakeIo([file]) });
  const check = envFileLocationCheck(info, fakeIo([], { "/app/pi-agent": ["source", "source.prev7-20261006"] }));
  assert.equal(check.name, "env-file-outside-source");
  assert.equal(check.ok, false);
  assert.match(check.detail, /deploy replaces/);
  assert.match(check.detail, /source\.prev7-20261006/);
  assert.match(check.hint, /move it to \/app\/pi-agent\/demo\.env/);
  assert.match(check.hint, /re-run scripts\/demo-env\.sh doctor/);
});

test("envFileHeader: up, status and doctor each print the resolved path (and never a value)", () => {
  const secret = "sup3r-s3cret-token";
  const info = resolveDemoEnvFile({
    env: { PIGO_DEMO_ENV_FILE: "/app/pi-agent/demo.env", PI_INTERNAL_TOKEN: secret },
    io: fakeIo(["/app/pi-agent/demo.env"]),
  });
  for (const command of ["up", "status", "doctor"]) {
    const header = envFileHeader(command, info);
    assert.ok(header.startsWith(`${command}:`), `${command} header must name the subcommand`);
    assert.ok(header.includes(info.path), `${command} must print the resolved path`);
    assert.ok(!header.includes(secret), `${command} must never print env values`);
  }
  assert.throws(() => envFileHeader("seed", info), /unknown subcommand/);
});

test("envFileLine: names the origin and no values", () => {
  const info = resolveDemoEnvFile({ env: { PIGO_DEMO_ENV_FILE: "/app/pi-agent/demo.env" }, io: fakeIo(["/app/pi-agent/demo.env"]) });
  assert.equal(envFileLine(info), "env file: /app/pi-agent/demo.env (explicit override $PIGO_DEMO_ENV_FILE)");

  const example = resolveDemoEnvFile({ env: {}, io: fakeIo([EXAMPLE_ENV_FILE]) });
  assert.match(envFileLine(example), /EXAMPLE FILE/);
});
