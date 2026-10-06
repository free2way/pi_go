#!/usr/bin/env node
/**
 * Demo / acceptance environment driver for PiGO.
 *
 * `scripts/demo-env.sh` is a thin wrapper around this module. The pure decision
 * logic (DB-name safety invariant, token/version parity, credential preflight,
 * resolved-compose inspection) is exported so `scripts/demo-env.test.mjs` can
 * assert it with `npm run test:scripts` — no Docker daemon, no network, no
 * secrets in the test process.
 *
 * Core safety invariant: the demo stack may only ever talk to the isolated
 * `pigo_demo` database. `up` resolves the effective compose configuration and
 * refuses to start when ANY resolved `*DATABASE_URL*` does not end in
 * `/pigo_demo`; it prints exactly what it resolved (password masked) first.
 *
 * Secret handling: this module never prints secret values. It reports presence,
 * length and a truncated SHA-256 so two values can be compared in logs.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_COMPOSE_FILE = path.join(REPO_ROOT, "deploy", "docker", "compose.demo.yaml");
/** In-repo fallback (git-ignored): fine for local development, replaced by a deploy. */
export const DEFAULT_ENV_FILE = path.join(REPO_ROOT, "deploy", "docker", "demo.env");
/** Placeholder template. Shipping a real value here is a bug — see the example file. */
export const EXAMPLE_ENV_FILE = path.join(REPO_ROOT, "deploy", "docker", "demo.env.example");
/**
 * Preferred location on a deploy host: `<parent-of-repo>/demo.env`. A deploy
 * moves this repo (`…/source`) aside to `source.prevN-…` and extracts a fresh
 * `source/`, so an env file inside the tree silently disappears. One directory
 * up survives. See docs/25-demo-environment.md.
 */
export const OUTSIDE_TREE_ENV_FILE = path.join(path.dirname(REPO_ROOT), "demo.env");

/** Explicit override; wins over every convention. */
export const ENV_FILE_OVERRIDE_VAR = "PIGO_DEMO_ENV_FILE";
/** Legacy alias, checked after `PIGO_DEMO_ENV_FILE`. */
export const LEGACY_ENV_FILE_VAR = "DEMO_ENV_FILE";

const ENV_FILE_SOURCE_LABELS = {
  override: "explicit override",
  "outside-tree": "outside the deployed tree (recommended on a deploy host)",
  "in-repo": "in-repo fallback (local development)",
  example: "EXAMPLE FILE — placeholders only, not usable",
};

/** True when an absolute path segment looks like a source tree a deploy swaps out. */
function isReplacedTreeSegment(segment) {
  return segment === "source" || /^source\.prev/.test(segment);
}

export const DEMO_DB_NAME = "pigo_demo";
export const DEMO_WEB_SERVICE = "demo-web";
export const DEMO_WORKER_SERVICE = "demo-worker";
export const DEMO_VAULT_IN_CONTAINER = "/app/data/credentials.v1.json";
export const DEMO_DATA_MOUNT = "/app/data";

/** Env vars `up` requires before it will touch Docker. Names only — values are never logged. */
export const REQUIRED_DEMO_ENV = [
  "PIGO_POSTGRES_PASSWORD",
  "PI_VAULT_SECRET",
  "PI_INTERNAL_TOKEN",
  "PIGO_DEMO_DATA_DIR",
  "PIGO_DEMO_WORKSPACE_ROOT",
  "PIGO_DEMO_MODELS_FILE",
];

/** Placeholders shipped in demo.env.example; a copied-but-unedited file must not start. */
export const PLACEHOLDER_PREFIX = "replace-with-";

export const DEMO_PROJECT_KEY = "DEMO";
export const DEMO_PROJECT_NAME = "PiGO 演示项目";
export const DEMO_PROJECT_DESCRIPTION = "演示 / 验收用项目：由 scripts/demo-env.sh seed 幂等维护。";
export const DEMO_SPRINT_NAME = "演示冲刺";
export const DEMO_SPRINT_GOAL = "演示规划 → 开发 → 检查 → 审核 → 人工合并的完整闭环。";

/** Canonical demo stories. `seed` matches them by title, so reruns never duplicate. */
export const DEMO_STORIES = [
  {
    title: "演示故事 A：修复并发刷新竞态",
    description: "refreshSession 在并发调用时会重复触发 client.refresh；请加入按 token 去重的锁并补充失败后重试的回归测试。",
    acceptanceCriteria: [
      "并发调用 refreshSession 时 client.refresh 只被触发一次",
      "上游失败后锁被清理，后续调用可以重试",
      "新增并发回归测试并通过",
    ],
    definitionOfDone: ["npm run typecheck 通过", "npm test 通过", "无新增 lint 错误"],
    priority: "must",
    estimate: 3,
    status: "ready",
  },
  {
    title: "演示故事 B：导出审核快照",
    description: "为审核阶段增加只读快照导出，便于人工复核 diff 与检查输出。",
    acceptanceCriteria: ["快照包含 tree hash 与完整 diff", "审核结束后快照被销毁", "下载端点返回 200"],
    definitionOfDone: ["快照内容与工作区一致", "新增单元测试覆盖 hash 校验"],
    priority: "should",
    estimate: 5,
    status: "ready",
  },
  {
    title: "演示故事 C：本地化文案校对",
    description: "校对中英文界面的关键文案，修正不一致的术语。",
    acceptanceCriteria: ["术语在 zh-CN / en 两种语言下一致", "没有缺失的 i18n key"],
    definitionOfDone: ["i18n 覆盖测试通过"],
    priority: "could",
    estimate: 2,
    status: "backlog",
  },
];

export const DEMO_SEED_SPEC = {
  project: { key: DEMO_PROJECT_KEY, name: DEMO_PROJECT_NAME, description: DEMO_PROJECT_DESCRIPTION },
  sprint: { name: DEMO_SPRINT_NAME, goal: DEMO_SPRINT_GOAL, status: "active" },
  stories: DEMO_STORIES,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parse a `KEY=value` env file (comments, blank lines, `export `, quotes). */
export function parseEnvFile(text) {
  const env = {};
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const index = withoutExport.indexOf("=");
    if (index === -1) continue;
    const key = withoutExport.slice(0, index).trim();
    let value = withoutExport.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Replace the password in a URL with `***` so a resolved URL can be printed. */
export function maskUrl(value) {
  return String(value ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i, (_match, scheme, userinfo) => {
    const user = userinfo.split(":")[0];
    return `${scheme}${user}:***@`;
  });
}

/** Best-effort database name for reporting; `null` when the value is unusable. */
export function dbNameOf(value) {
  try {
    const name = decodeURIComponent(new URL(String(value).trim()).pathname.replace(/^\//, ""));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * THE safety invariant. Returns `{ ok, dbName, reason, display }`.
 * Accepts only a URL whose value ends in `/pigo_demo` (so trailing whitespace,
 * a trailing slash, query-string-less variants like `/pigo_demo_extra` and the
 * production `/pigo` are all rejected).
 */
export function resolveDbTarget(raw) {
  const value = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
  if (value === "") return { ok: false, dbName: null, reason: "missing", display: "(unset)" };
  const display = maskUrl(value);
  if (value !== value.trim()) return { ok: false, dbName: dbNameOf(value), reason: "whitespace", display };
  if (!value.endsWith(`/${DEMO_DB_NAME}`)) return { ok: false, dbName: dbNameOf(value), reason: "not-demo", display };
  let dbName;
  try {
    dbName = decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
  } catch {
    return { ok: false, dbName: null, reason: "unparseable", display };
  }
  if (dbName !== DEMO_DB_NAME) return { ok: false, dbName, reason: "not-demo", display };
  return { ok: true, dbName, reason: "ok", display };
}

function dbProblem(source, target) {
  const reason = target.reason === "missing"
    ? "is unset"
    : target.reason === "whitespace"
      ? "has leading/trailing whitespace"
      : target.reason === "unparseable"
        ? "is not a parseable URL"
        : `points at database "${target.dbName ?? "unknown"}"`;
  return `${source}: ${target.display} ${reason} — the demo stack refuses anything that does not end in /${DEMO_DB_NAME}`;
}

/**
 * @param {{ source: string, url: string }[]} entries
 * @returns {{ ok: boolean, resolved: Array<{source:string, ok:boolean, dbName:string|null, reason:string, display:string}>, problems: string[] }}
 */
export function checkDbSafety(entries) {
  const resolved = (entries ?? []).map((entry) => ({ source: entry.source, ...resolveDbTarget(entry.url) }));
  const problems = resolved.filter((entry) => !entry.ok).map((entry) => dbProblem(entry.source, entry));
  return { ok: problems.length === 0, resolved, problems };
}

/** Presence/length/hash of a secret — never the value. */
export function fingerprintValue(value) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (text.length === 0) return { present: false, length: 0, digest: null };
  return { present: true, length: text.length, digest: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

/** Compare two secret values (e.g. the internal token in web vs. worker). */
export function checkSecretParity(label, webValue, workerValue) {
  const web = fingerprintValue(webValue);
  const worker = fingerprintValue(workerValue);
  if (!web.present || !worker.present) {
    const missing = [!web.present ? "web" : null, !worker.present ? "worker" : null].filter(Boolean).join(", ");
    return { ok: false, report: `${label}: UNSET in ${missing} (web len=${web.length}, worker len=${worker.length})` };
  }
  if (web.digest !== worker.digest) {
    return { ok: false, report: `${label}: MISMATCH (web len=${web.length} sha256:${web.digest}, worker len=${worker.length} sha256:${worker.digest})` };
  }
  return { ok: true, report: `${label}: match (len=${web.length}, sha256:${web.digest})` };
}

/** All entries must be set and identical (web/worker/expected version strings). */
export function checkVersionParity(label, entries) {
  const values = (entries ?? []).map((entry) => ({ source: entry.source, value: String(entry.value ?? "").trim() }));
  const missing = values.filter((entry) => entry.value === "");
  if (missing.length > 0) {
    return { ok: false, report: `${label}: unset for ${missing.map((entry) => entry.source).join(", ")} — set PIGO_DEMO_VERSION in the demo env file` };
  }
  const distinct = [...new Set(values.map((entry) => entry.value))];
  if (distinct.length > 1) {
    return { ok: false, report: `${label}: MISMATCH (${values.map((entry) => `${entry.source}=${entry.value}`).join(", ")})` };
  }
  return { ok: true, report: `${label}: ${distinct[0]} (${values.map((entry) => entry.source).join(" == ")})` };
}

/**
 * Fail-closed credential check. Never reads repo content into a vault; the file
 * must already exist. `io` is injectable for tests.
 */
export function credentialPreflight(filePath, io = {}) {
  const exists = io.exists ?? existsSync;
  const read = io.read ?? ((target) => readFileSync(target, "utf8"));
  if (!exists(filePath)) {
    return {
      ok: false,
      reason: "missing",
      message: `credential vault not found: ${filePath} — place an existing credentials.v1.json there (never commit it)`,
    };
  }
  let raw;
  try {
    raw = read(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      message: `credential vault not readable: ${filePath} (${error?.code ?? error?.message ?? "unknown"}) — check ownership/mode (0600, uid 1000)`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { ok: false, reason: "invalid-json", message: `credential vault is not valid JSON: ${filePath}` };
  }
  if (parsed?.version !== 2) {
    return { ok: false, reason: "wrong-version", message: `credential vault version ${parsed?.version ?? "unknown"} != 2: ${filePath}` };
  }
  return { ok: true, reason: "ok", bytes: String(raw).length, message: `credential vault OK (${filePath}, ${String(raw).length} bytes)` };
}

/** Normalise `docker compose config --format json` into a small, testable shape. */
export function extractServices(config) {
  const out = {};
  for (const [name, service] of Object.entries(config?.services ?? {})) {
    const env = {};
    for (const [key, value] of Object.entries(service?.environment ?? {})) {
      env[key] = value === null || value === undefined ? "" : String(value);
    }
    out[name] = {
      env,
      volumes: Array.isArray(service?.volumes) ? service.volumes : [],
      ports: Array.isArray(service?.ports) ? service.ports : [],
      groupAdd: service?.group_add ?? service?.groupAdd ?? [],
    };
  }
  return out;
}

function volumeTargets(service) {
  return service.volumes.map((volume) => (typeof volume === "string" ? volume : volume?.target ?? "")).filter(Boolean);
}

/**
 * Structural checks over the RESOLVED compose config (as `docker compose config
 * --format json` produces). Pure: takes the parsed config, returns problems.
 */
export function checkDemoCompose(config, options = {}) {
  const webName = options.webService ?? DEMO_WEB_SERVICE;
  const workerName = options.workerService ?? DEMO_WORKER_SERVICE;
  const expectedPort = String(options.webPort ?? "3101");
  const expectedBind = String(options.webBindAddress ?? "192.168.2.235");
  const services = extractServices(config);
  const web = services[webName];
  const worker = services[workerName];
  const problems = [];
  const facts = {};

  if (!web) problems.push(`service "${webName}" not found in the resolved compose config`);
  if (!worker) problems.push(`service "${workerName}" not found in the resolved compose config`);

  // Every resolved database URL, in every service, must be the demo database.
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [key, value] of Object.entries(service.env)) {
      if (!/DATABASE_URL$/.test(key)) continue;
      const target = resolveDbTarget(value);
      if (!target.ok) problems.push(dbProblem(`${serviceName}.${key}`, target));
    }
  }

  if (web) {
    facts.webVersion = web.env.PI_WEB_VERSION ?? "";
    facts.vaultFile = web.env.PI_VAULT_FILE ?? "";
    if (web.env.PI_VAULT_FILE !== DEMO_VAULT_IN_CONTAINER) {
      problems.push(`${webName}.PI_VAULT_FILE is "${web.env.PI_VAULT_FILE ?? ""}" — the mounted vault must be ${DEMO_VAULT_IN_CONTAINER} (never /tmp)`);
    }
    if (!volumeTargets(web).some((target) => target.split(":")[0] === DEMO_DATA_MOUNT)) {
      problems.push(`${webName} does not mount a volume at ${DEMO_DATA_MOUNT} — the vault/runs file would live in the container`);
    }
    if (String(web.env.HOST ?? "") !== "0.0.0.0") problems.push(`${webName}.HOST is "${web.env.HOST ?? ""}" — expected 0.0.0.0`);
    if (String(web.env.NODE_ENV ?? "") !== "development") problems.push(`${webName}.NODE_ENV is "${web.env.NODE_ENV ?? ""}" — development auth requires NODE_ENV=development`);
    if (String(web.env.PI_AUTH_MODE ?? "") !== "development") problems.push(`${webName}.PI_AUTH_MODE is "${web.env.PI_AUTH_MODE ?? ""}" — expected development`);
    const port = web.ports.find((entry) => String(entry?.published ?? "") === expectedPort);
    if (!port) {
      problems.push(`${webName} does not publish port ${expectedPort}`);
    } else if (String(port.host_ip ?? port.hostIp ?? "") !== expectedBind) {
      problems.push(`${webName} port ${expectedPort} binds ${port.host_ip ?? port.hostIp ?? "(all interfaces)"} — expected ${expectedBind}`);
    }
  }

  if (worker) {
    facts.workerVersion = worker.env.PI_WORKER_VERSION ?? "";
    facts.callbackUrl = worker.env.PI_WEB_CALLBACK_URL ?? "";
    facts.sandboxMode = worker.env.PI_SANDBOX_MODE ?? "";
    if (!worker.volumes.some((volume) => String(typeof volume === "string" ? volume : volume?.source ?? volume?.target ?? "").includes("docker.sock"))) {
      problems.push(`${workerName} does not mount /var/run/docker.sock — sandbox containers cannot be created`);
    }
    const groupAdd = worker.groupAdd;
    if (groupAdd.length === 0) problems.push(`${workerName}.group_add is empty — the non-root worker cannot use the docker socket`);
    for (const entry of groupAdd) {
      if (String(entry).includes("/") || String(entry).includes(":")) problems.push(`${workerName}.group_add contains a mount-like entry: ${entry}`);
    }
    try {
      const callback = new URL(String(worker.env.PI_WEB_CALLBACK_URL ?? ""));
      if (callback.hostname !== webName) {
        problems.push(`${workerName}.PI_WEB_CALLBACK_URL host "${callback.hostname}" must be the demo web service "${webName}" (never the production web)`);
      }
    } catch {
      problems.push(`${workerName}.PI_WEB_CALLBACK_URL is not a URL: ${worker.env.PI_WEB_CALLBACK_URL ?? "(unset)"}`);
    }
    if (String(worker.env.PI_SANDBOX_MODE ?? "") !== "auto") {
      problems.push(`${workerName}.PI_SANDBOX_MODE is "${worker.env.PI_SANDBOX_MODE ?? ""}" — expected auto (fail-closed when Docker is unusable)`);
    }
    const mountTargets = volumeTargets(worker);
    if (!mountTargets.some((target) => target.split(":")[0] === "/workspace")) {
      problems.push(`${workerName} does not mount the workspaces root at /workspace`);
    }
  }

  if (web && worker) {
    const token = checkSecretParity("PI_INTERNAL_TOKEN (web/worker)", web.env.PI_INTERNAL_TOKEN, worker.env.PI_INTERNAL_TOKEN);
    facts.token = token.report;
    facts.webToken = web.env.PI_INTERNAL_TOKEN;
    facts.workerToken = worker.env.PI_INTERNAL_TOKEN;
    if (!token.ok) problems.push(token.report);
    const version = checkVersionParity("PI_WEB_VERSION / PI_WORKER_VERSION", [
      { source: `${webName}.PI_WEB_VERSION`, value: web.env.PI_WEB_VERSION },
      { source: `${workerName}.PI_WORKER_VERSION`, value: worker.env.PI_WORKER_VERSION },
    ]);
    facts.version = version.report;
    if (!version.ok) problems.push(version.report);
  }

  return { ok: problems.length === 0, problems, facts };
}

/**
 * Pure idempotency decision for `seed`: matched by project key, sprint name and
 * story title, so a rerun updates in place instead of duplicating. Returns the
 * planned actions with the ids that already exist.
 */
export function planSeedActions(existing, spec = DEMO_SEED_SPEC) {
  const project = (existing?.projects ?? []).find((entry) => String(entry.key ?? "").toUpperCase() === spec.project.key.toUpperCase());
  const sprints = existing?.sprints ?? [];
  const stories = existing?.stories ?? [];
  const actions = [
    { kind: project ? "update-project" : "create-project", id: project?.id ?? null, label: `${spec.project.key} ${spec.project.name}` },
  ];
  const sprint = sprints.find((entry) => entry.name === spec.sprint.name);
  actions.push({ kind: sprint ? "update-sprint" : "create-sprint", id: sprint?.id ?? null, label: spec.sprint.name });
  for (const story of spec.stories) {
    const found = stories.find((entry) => entry.title === story.title);
    actions.push({ kind: found ? "update-story" : "create-story", id: found?.id ?? null, label: story.title });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Env-file resolution (the incident: deploy/ replaces source/, so an env file
// kept inside the tree silently disappears) and the recurrence guard.
// ---------------------------------------------------------------------------

/** Human label for a resolved env file's origin. */
export function envFileSourceLabel(info) {
  const base = ENV_FILE_SOURCE_LABELS[info?.source] ?? "unknown";
  return info?.overrideVar ? base + " $" + info.overrideVar : base;
}

/** Ordered resolution candidates (override first, example last). */
export function envFileCandidates(env = process.env) {
  const candidates = [];
  for (const varName of [ENV_FILE_OVERRIDE_VAR, LEGACY_ENV_FILE_VAR]) {
    const raw = String(env?.[varName] ?? "").trim();
    if (raw !== "") candidates.push({ source: "override", overrideVar: varName, path: path.resolve(raw) });
  }
  candidates.push({ source: "outside-tree", overrideVar: null, path: OUTSIDE_TREE_ENV_FILE });
  candidates.push({ source: "in-repo", overrideVar: null, path: DEFAULT_ENV_FILE });
  candidates.push({ source: "example", overrideVar: null, path: EXAMPLE_ENV_FILE });
  return candidates;
}

/**
 * Actionable, fail-closed message when no usable env file exists. It names every
 * candidate that was tried and the exact command that fixes it — the example
 * file must never be used silently.
 */
export function envFileMissingMessage(info, io = {}) {
  const exists = io.exists ?? existsSync;
  const lines = [
    `demo env file not found: no usable env file resolved (tried, in order):`,
  ];
  for (const candidate of info.candidates) {
    const label = candidate.source === "override" ? "$" + candidate.overrideVar : candidate.source;
    lines.push(`  ${exists(candidate.path) ? "found  " : "missing"} ${candidate.path} (${label})`);
  }
  lines.push(`refusing to fall back to ${info.path} — it is the example file with replace-with-… placeholders.`);
  lines.push(`fix: cp deploy/docker/demo.env.example ${info.recommendedPath} && chmod 600 ${info.recommendedPath}`);
  lines.push(`     then fill it in and re-run. Keep it OUTSIDE ${REPO_ROOT}/ (a deploy replaces that directory; see docs/25-demo-environment.md).`);
  return lines.join("\n");
}

/**
 * Resolve the effective demo env file. Precedence:
 *   1. `PIGO_DEMO_ENV_FILE` (then legacy `DEMO_ENV_FILE`) — explicit override;
 *   2. `<parent-of-repo>/demo.env` — outside the deployed tree (recommended);
 *   3. `<repo>/deploy/docker/demo.env` — in-repo fallback for local development;
 *   4. `demo.env.example` — never used silently: `error` is set and callers refuse.
 *
 * `io.exists` is injectable for tests. Returns the path (never any values).
 */
export function resolveDemoEnvFile({ env = process.env, io = {} } = {}) {
  const exists = io.exists ?? existsSync;
  const candidates = envFileCandidates(env);
  const override = candidates.find((candidate) => candidate.source === "override");
  const fallbacks = candidates.filter((candidate) => candidate.source !== "override");
  const outside = fallbacks.find((candidate) => candidate.source === "outside-tree");
  const recommendedPath = outside.path;

  const overrideInfo = (candidate, present) => ({
    path: candidate.path,
    source: "override",
    overrideVar: candidate.overrideVar,
    isExample: false,
    exists: present,
    error: present
      ? null
      : `demo env file from ${candidate.overrideVar} not found: ${candidate.path}\n  → point ${candidate.overrideVar} at an existing file, or unset it to use the conventional locations.`,
    recommendedPath,
    candidates,
  });

  // 1. An explicit override is honoured as-is (and fails loudly when it is wrong).
  if (override) return overrideInfo(override, exists(override.path));

  // 2/3/4. First existing conventional candidate wins; the example never silently wins.
  const found = fallbacks.find((candidate) => exists(candidate.path)) ?? fallbacks[fallbacks.length - 1];
  const isExample = found.source === "example";
  const info = {
    path: found.path,
    source: found.source,
    overrideVar: null,
    isExample,
    exists: exists(found.path),
    error: null,
    recommendedPath,
    candidates,
  };
  info.error = isExample ? envFileMissingMessage(info, io) : null;
  return info;
}

/**
 * Detect an env file that lives inside a directory a deploy replaces. The host
 * deploy does `mv source source.prevN-…` and extracts a fresh `source/`, so a
 * file at `…/source/…` (or inside an already-rotated `source.prevN/`) is gone
 * after the next deploy. Purely path/`readdir` based and injectable for tests.
 */
export function detectDeployReplacedEnvFile(filePath, io = {}) {
  const readdir = io.readdir ?? readdirSync;
  const parts = path.resolve(String(filePath)).split(path.sep).filter(Boolean);
  const dirs = parts.slice(0, -1);
  const segmentIndex = dirs.findIndex((segment) => isReplacedTreeSegment(segment));
  if (segmentIndex === -1) {
    return { replaced: false, treeRoot: null, parentDir: null, prevSiblings: [], recommendedPath: null };
  }
  const treeRoot = path.sep + dirs.slice(0, segmentIndex + 1).join(path.sep);
  const parentDir = path.sep + dirs.slice(0, segmentIndex).join(path.sep);
  let prevSiblings = [];
  try {
    prevSiblings = (readdir(parentDir) ?? []).filter((entry) => /^source\.prev/.test(String(entry))).map(String).sort();
  } catch {
    prevSiblings = [];
  }
  return {
    replaced: true,
    treeRoot,
    parentDir,
    prevSiblings,
    recommendedPath: path.join(parentDir, "demo.env"),
  };
}

/** One-line, value-free statement of which env file is in use. */
export function envFileLine(info) {
  return `env file: ${info.path} (${envFileSourceLabel(info)})`;
}

/**
 * Header each subcommand prints. `up`, `status` and `doctor` all go through
 * this so the resolved path is always visible (and never a secret value).
 */
export function envFileHeader(command, info) {
  if (!["up", "status", "doctor"].includes(command)) throw new Error(`unknown subcommand for env-file header: ${command}`);
  return `${command}: ${envFileLine(info)}`;
}

/**
 * The single recurrence guard `doctor` reports: FAIL when the effective env
 * file sits inside a deploy-replaced tree, with the exact remediation.
 */
export function envFileLocationCheck(info, io = {}) {
  const detection = detectDeployReplacedEnvFile(info.path, io);
  if (!detection.replaced) {
    return {
      name: "env-file-outside-source",
      ok: true,
      detail: `${info.path} is outside any deploy-replaced source/ tree`,
      hint: "",
    };
  }
  const evidence = detection.prevSiblings.length > 0 ? `; sibling ${detection.prevSiblings.join(", ")} already seen` : "";
  return {
    name: "env-file-outside-source",
    ok: false,
    detail: `${info.path} lives inside a directory a deploy replaces (${detection.treeRoot}${evidence}) — a deploy moves source/ aside and extracts a fresh one, so this file WILL disappear and 'up' will fail with "couldn't find env file"`,
    hint: `move it to ${detection.recommendedPath} and re-run scripts/demo-env.sh doctor (or set PIGO_DEMO_ENV_FILE to an absolute path outside source/)`,
  };
}

// ---------------------------------------------------------------------------
// Docker / compose orchestration
// ---------------------------------------------------------------------------

function paths() {
  return { composeFile: process.env.DEMO_COMPOSE_FILE || DEFAULT_COMPOSE_FILE };
}

function loadFileEnv(envFile) {
  if (!existsSync(envFile)) return undefined;
  return parseEnvFile(readFileSync(envFile, "utf8"));
}

function effectiveEnv(fileEnv) {
  // Compose precedence: the shell environment wins over --env-file, so mirror it.
  return { ...fileEnv, ...process.env };
}

function compose(args, env, envFile) {
  const { composeFile } = paths();
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", composeFile, "--project-name", "pigo-demo", ...args],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (result.error) {
    return { status: 1, stdout: result.stdout ?? "", stderr: `docker CLI not available: ${result.error.message}` };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolvedConfig(env, envFile) {
  const result = compose(["config", "--format", "json"], env, envFile);
  if (result.status !== 0) return { ok: false, error: result.stderr.trim() || result.stdout.trim() };
  try {
    return { ok: true, config: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `could not parse \`docker compose config\` output: ${error.message}` };
  }
}

function dbEntriesFromConfig(config) {
  const entries = [];
  for (const [serviceName, service] of Object.entries(extractServices(config))) {
    for (const [key, value] of Object.entries(service.env)) {
      if (/DATABASE_URL$/.test(key)) entries.push({ source: `${serviceName}.${key}`, url: value });
    }
  }
  return entries;
}

function printDbResolution(entries) {
  for (const entry of entries) {
    const marker = entry.ok ? "PASS" : "FAIL";
    console.log(`  ${marker} ${entry.source} -> ${entry.display} (database=${entry.dbName ?? "?"}, ${entry.reason})`);
  }
}

function requireReady(effective, info) {
  const missing = REQUIRED_DEMO_ENV.filter((name) => !String(effective[name] ?? "").trim());
  if (missing.length > 0) {
    console.error(`demo env is incomplete: ${missing.join(", ")}`);
    console.error(`  → fill in ${info.path}, then re-run.`);
    if (info.path !== info.recommendedPath) {
      console.error(`  → on a deploy host, keep it at ${info.recommendedPath} (outside the replaced source/ tree).`);
    }
    return false;
  }
  const placeholders = REQUIRED_DEMO_ENV.filter((name) => String(effective[name]).startsWith(PLACEHOLDER_PREFIX));
  if (placeholders.length > 0) {
    console.error(`demo env still contains example placeholders: ${placeholders.join(", ")}`);
    console.error(`  → replace every replace-with-… value in ${info.path} before starting.`);
    return false;
  }
  return true;
}

function healthJson(service, url, env, timeoutMs, intervalMs, envFile) {
  const script = `fetch(${JSON.stringify(url)}).then(async r=>{const t=await r.text();if(!r.ok){console.error(t);process.exit(1)}process.stdout.write(t)}).catch(e=>{console.error(String(e));process.exit(1)})`;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const result = compose(["exec", "-T", service, "node", "-e", script], env, envFile);
    if (result.status === 0) {
      try {
        return { ok: true, json: JSON.parse(result.stdout) };
      } catch {
        return { ok: true, json: { raw: result.stdout.trim() } };
      }
    }
    last = (result.stderr || result.stdout).trim();
    const wait = Date.now() + intervalMs > deadline ? 0 : intervalMs;
    spawnSync("sleep", [String(Math.ceil(wait / 1000))]);
  }
  return { ok: false, error: last };
}

function loopbackBase(env) {
  if (env.PIGO_DEMO_SEED_BASE_URL) return env.PIGO_DEMO_SEED_BASE_URL.replace(/\/$/, "");
  const host = env.PIGO_DEMO_WEB_LOOPBACK_ADDRESS || "127.0.0.1";
  const port = env.PIGO_DEMO_WEB_LOOPBACK_PORT || "3102";
  return `http://${host}:${port}`;
}

async function api(baseUrl, devEmail, method, requestPath, body) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { "content-type": "application/json", "x-pigo-dev-email": devEmail },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    throw new Error(`${method} ${requestPath} -> HTTP ${response.status}: ${json?.error ?? text.slice(0, 200)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdUp(argv) {
  const info = resolveDemoEnvFile();
  console.log(envFileHeader("up", info));
  if (info.error) {
    console.error(info.error);
    return 1;
  }
  const envFile = info.path;
  const fileEnv = loadFileEnv(envFile);
  if (!fileEnv) {
    console.error(`demo env file not found: ${envFile}`);
    console.error(`  → cp deploy/docker/demo.env.example ${info.recommendedPath} && chmod 600 ${info.recommendedPath}  (then edit; never commit it)`);
    return 1;
  }
  const env = effectiveEnv(fileEnv);
  if (!requireReady(env, info)) return 1;

  const vaultFile = path.join(env.PIGO_DEMO_DATA_DIR, "credentials.v1.json");
  const vault = credentialPreflight(vaultFile);
  console.log(vault.ok ? `PASS ${vault.message}` : `FAIL ${vault.message}`);
  if (!vault.ok) {
    console.error("refusing to start: the demo stack is fail-closed on the credential file.");
    return 1;
  }

  const resolved = resolvedConfig(env, envFile);
  if (!resolved.ok) {
    console.error("refusing to start: `docker compose config` failed:");
    console.error(resolved.error);
    return 1;
  }

  const dbEntries = dbEntriesFromConfig(resolved.config);
  const db = checkDbSafety(dbEntries);
  console.log("resolved database target(s):");
  printDbResolution(db.resolved);
  if (!db.ok) {
    console.error("refusing to start: DB safety invariant violated (only /pigo_demo is allowed).");
    for (const problem of db.problems) console.error(`  - ${problem}`);
    return 1;
  }

  const structural = checkDemoCompose(resolved.config, {
    webPort: env.PIGO_DEMO_WEB_PORT,
    webBindAddress: env.PIGO_DEMO_WEB_BIND_ADDRESS,
  });
  if (!structural.ok) {
    console.error("refusing to start: resolved compose config is not demo-safe:");
    for (const problem of structural.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`PASS compose structure: ${structural.facts.version}; token ${structural.facts.token}`);

  const build = env.PIGO_DEMO_SKIP_BUILD === "1" ? [] : ["--build"];
  const upArgs = ["up", "-d", ...build, ...argv];
  console.log(`$ docker compose -f ${paths().composeFile} ${upArgs.join(" ")}`);
  const up = compose(upArgs, env, envFile);
  if (up.stdout.trim()) console.log(up.stdout.trim());
  if (up.status !== 0) {
    console.error(up.stderr.trim());
    console.error("demo stack failed to start (the fail-closed preflight service may have rejected the vault).");
    return up.status;
  }

  const timeoutMs = Number(env.PIGO_DEMO_HEALTH_TIMEOUT_MS || 120_000);
  const web = healthJson(DEMO_WEB_SERVICE, "http://127.0.0.1:3100/api/health", env, timeoutMs, 3000, envFile);
  if (!web.ok) {
    console.error(`demo-web did not become healthy: ${web.error}`);
    console.error("  → scripts/demo-env.sh doctor   (and: docker compose logs demo-web)");
    return 1;
  }
  const worker = healthJson(DEMO_WORKER_SERVICE, "http://127.0.0.1:3200/health", env, timeoutMs, 3000, envFile);
  if (!worker.ok) {
    console.error(`demo-worker did not become healthy: ${worker.error}`);
    console.error("  → scripts/demo-env.sh doctor   (and: docker compose logs demo-worker)");
    return 1;
  }

  console.log("demo stack is up:");
  console.log(`  web    ${loopbackBase(env) || "loopback"}  http://${env.PIGO_DEMO_WEB_BIND_ADDRESS}:${env.PIGO_DEMO_WEB_PORT}  version=${web.json.version ?? "?"} db=${web.json.db ?? "?"}`);
  console.log(`  worker version=${worker.json.version ?? "?"} storage=${worker.json.storage ?? "?"} activeJobs=${worker.json.activeJobs ?? "?"}`);
  console.log(`  database ${db.resolved.map((entry) => entry.dbName).join(",")}`);
  return 0;
}

function cmdDown(_argv) {
  const info = resolveDemoEnvFile();
  const envFile = info.path;
  const fileEnv = loadFileEnv(envFile);
  const env = effectiveEnv(fileEnv ?? {});
  const result = compose(["down"], env, envFile);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status === 0) {
    console.log("demo stack stopped. Volumes were NOT deleted (no --volumes): the demo worker state volume and the host data/workspace directories are intact.");
  }
  return result.status;
}

function cmdStatus(_argv) {
  const info = resolveDemoEnvFile();
  console.log(envFileHeader("status", info));
  if (info.error) {
    console.error(info.error);
    return 1;
  }
  const envFile = info.path;
  const fileEnv = loadFileEnv(envFile);
  if (!fileEnv) {
    console.error(`demo env file not found: ${envFile} (needed to interpolate the compose file)`);
    return 1;
  }
  const env = effectiveEnv(fileEnv);
  const ps = compose(["ps"], env, envFile);
  if (ps.stdout.trim()) console.log(ps.stdout.trim());
  if (ps.status !== 0) console.error(ps.stderr.trim());

  const resolved = resolvedConfig(env, envFile);
  if (resolved.ok) {
    const db = checkDbSafety(dbEntriesFromConfig(resolved.config));
    console.log("resolved target: " + db.resolved.map((entry) => `${entry.display} (${entry.reason})`).join(", "));
  }

  for (const [service, url] of [
    [DEMO_WEB_SERVICE, "http://127.0.0.1:3100/api/health"],
    [DEMO_WORKER_SERVICE, "http://127.0.0.1:3200/health"],
  ]) {
    const health = healthJson(service, url, env, 5000, 2000, envFile);
    console.log(`  ${service}: ${health.ok ? JSON.stringify(health.json) : `unreachable (${health.error})`}`);
  }
  return 0;
}

function cmdDoctor(_argv) {
  const info = resolveDemoEnvFile();
  console.log(envFileHeader("doctor", info));
  const envFile = info.path;
  const fileEnv = info.error ? undefined : loadFileEnv(envFile);
  const results = [];
  const record = (name, ok, detail, hint) => {
    results.push({ name, ok, detail, hint });
  };

  if (info.error) {
    record("env-file", false, info.error.split("\n")[0], info.error.split("\n").slice(1).map((line) => line.trim()).join(" "));
  } else if (!fileEnv) {
    record("env-file", false, `${envFile} not found`, `cp deploy/docker/demo.env.example ${info.recommendedPath} and edit it`);
  } else {
    record("env-file", true, `${envFile} (${envFileSourceLabel(info)})`, "");
  }

  // Single recurrence guard: an env file inside a deploy-replaced tree is lost on
  // the next deploy. Reported as one FAIL with the exact remediation.
  const locationCheck = envFileLocationCheck(info);
  record(locationCheck.name, locationCheck.ok, locationCheck.detail, locationCheck.hint);

  const env = effectiveEnv(fileEnv ?? {});
  const missing = REQUIRED_DEMO_ENV.filter((name) => !String(env[name] ?? "").trim());
  record("env-required", missing.length === 0, missing.length === 0 ? `${REQUIRED_DEMO_ENV.length} required values present` : `missing ${missing.join(", ")}`, `fill in ${info.path}`);
  const placeholders = REQUIRED_DEMO_ENV.filter((name) => String(env[name] ?? "").startsWith(PLACEHOLDER_PREFIX));
  record("env-placeholders", placeholders.length === 0, placeholders.length === 0 ? "no example placeholders" : `unreplaced: ${placeholders.join(", ")}`, "replace the replace-with-… values");

  const vaultFile = env.PIGO_DEMO_DATA_DIR ? path.join(env.PIGO_DEMO_DATA_DIR, "credentials.v1.json") : "(PIGO_DEMO_DATA_DIR unset)";
  const vault = credentialPreflight(vaultFile);
  record("credential-file", vault.ok, vault.message, "place an existing credentials.v1.json in PIGO_DEMO_DATA_DIR (0600, uid 1000); never commit it");

  const resolved = resolvedConfig(env, envFile);
  record("compose-config", resolved.ok, resolved.ok ? "resolved" : resolved.error, "check every ${VAR:?} in the demo env file; then `docker compose config`");
  if (!resolved.ok) {
    reportDoctor(results);
    return 1;
  }
  const config = resolved.config;
  const structural = checkDemoCompose(config, {
    webPort: env.PIGO_DEMO_WEB_PORT,
    webBindAddress: env.PIGO_DEMO_WEB_BIND_ADDRESS,
  });
  const db = checkDbSafety(dbEntriesFromConfig(config));
  record("database-name", db.ok, db.resolved.map((entry) => `${entry.source}=${entry.display} (${entry.dbName ?? "?"})`).join("; ") || "no *DATABASE_URL* resolved", "the demo DB must be /pigo_demo; fix the compose/env wiring");
  record("compose-structure", structural.ok, structural.ok ? `version=${structural.facts.version}; token ${structural.facts.token}` : structural.problems.join("; "), "fix deploy/docker/compose.demo.yaml");

  const token = checkSecretParity("PI_INTERNAL_TOKEN", structural.facts.webToken, structural.facts.workerToken);
  record("internal-token-parity", token.ok, token.report, "set the SAME PI_INTERNAL_TOKEN for demo-web and demo-worker");
  const version = checkVersionParity("version-string", [
    { source: "PIGO_DEMO_VERSION", value: env.PIGO_DEMO_VERSION },
    { source: "resolved web/worker", value: structural.facts.webVersion === structural.facts.workerVersion ? structural.facts.webVersion : `${structural.facts.webVersion} != ${structural.facts.workerVersion}` },
  ]);
  record("version-parity", version.ok, version.report, "set one PIGO_DEMO_VERSION value used by both services");

  // Docker socket usability, checked inside the running demo worker.
  const socketScript = [
    "const fs=require('node:fs');const p='/var/run/docker.sock';",
    "try{const st=fs.statSync(p);if(!st.isSocket()){console.error('not a socket');process.exit(1)}",
    "const groups=process.getgroups();if(!groups.includes(st.gid)){console.error(`socket gid ${st.gid} not in process groups [${groups.join(',')}]`);process.exit(1)}",
    "console.log(`socket ok gid=${st.gid} groups=[${groups.join(',')}]`)}",
    "catch(e){console.error(e.code||e.message);process.exit(1)}",
  ].join("");
  const socket = compose(["exec", "-T", DEMO_WORKER_SERVICE, "node", "-e", socketScript], env, envFile);
  record(
    "docker-socket",
    socket.status === 0,
    (socket.stdout || socket.stderr).trim() || "no output",
    "set PIGO_DEMO_DOCKER_GID to `stat -c %g /var/run/docker.sock` and ensure the socket is mounted into demo-worker",
  );

  const webHealth = healthJson(DEMO_WEB_SERVICE, "http://127.0.0.1:3100/api/health", env, 5000, 2000, envFile);
  record("web-health", webHealth.ok, webHealth.ok ? JSON.stringify(webHealth.json) : webHealth.error, "scripts/demo-env.sh up; docker compose logs demo-web");
  const workerHealth = healthJson(DEMO_WORKER_SERVICE, "http://127.0.0.1:3200/health", env, 5000, 2000, envFile);
  record("worker-health", workerHealth.ok, workerHealth.ok ? JSON.stringify(workerHealth.json) : workerHealth.error, "scripts/demo-env.sh up; docker compose logs demo-worker");

  if (webHealth.ok && workerHealth.ok) {
    const live = checkVersionParity("live version", [
      { source: "GET /api/health", value: webHealth.json.version },
      { source: "GET /health", value: workerHealth.json.version },
      { source: "PIGO_DEMO_VERSION", value: env.PIGO_DEMO_VERSION },
    ]);
    record("live-version", live.ok, live.report, "rebuild the demo images after changing PIGO_DEMO_VERSION");
    const callbackHost = (() => {
      try {
        return new URL(String(structural.facts.callbackUrl ?? "")).hostname;
      } catch {
        return "";
      }
    })();
    record("callback-host", callbackHost === DEMO_WEB_SERVICE, `PI_WEB_CALLBACK_URL host=${callbackHost || "(unset)"}`, `must be ${DEMO_WEB_SERVICE}, never the production web service`);
  }

  const degraded = String(env.PI_SANDBOX_ALLOW_DEGRADED ?? "");
  record("sandbox-fail-closed", true, degraded === "1" ? "PI_SANDBOX_ALLOW_DEGRADED=1 — degraded (in-process) execution is ENABLED" : `mode=${structural.facts.sandboxMode}; degraded execution disabled (fail-closed)`, "leave PI_SANDBOX_ALLOW_DEGRADED unset unless isolation loss is explicitly accepted");

  reportDoctor(results);
  return results.every((entry) => entry.ok) ? 0 : 1;
}

function reportDoctor(results) {
  console.log("demo environment doctor:");
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}: ${entry.detail}`);
    if (!entry.ok && entry.hint) console.log(`      → ${entry.hint}`);
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(failed.length === 0 ? "all checks passed." : `${failed.length}/${results.length} check(s) failed.`);
}

async function cmdSeed(_argv) {
  const fileEnv = loadFileEnv(resolveDemoEnvFile().path);
  const env = effectiveEnv(fileEnv ?? {});
  const baseUrl = loopbackBase(env);
  const devEmail = env.PIGO_DEMO_DEV_EMAIL || "developer@localhost";

  let projects;
  try {
    projects = await api(baseUrl, devEmail, "GET", "/api/agile/projects");
  } catch (error) {
    console.error(`cannot reach the demo web at ${baseUrl}: ${error.message}`);
    console.error("  → scripts/demo-env.sh up  (seed needs the loopback port from compose.demo.yaml)");
    return 1;
  }

  const existingProject = (projects.projects ?? []).find(
    (entry) => String(entry.key ?? "").toUpperCase() === DEMO_PROJECT_KEY,
  );
  const project = existingProject
    ? await api(baseUrl, devEmail, "PATCH", `/api/agile/projects/${existingProject.id}`, {
        name: DEMO_PROJECT_NAME,
        description: DEMO_PROJECT_DESCRIPTION,
      })
    : await api(baseUrl, devEmail, "POST", "/api/agile/projects", {
        key: DEMO_PROJECT_KEY,
        name: DEMO_PROJECT_NAME,
        description: DEMO_PROJECT_DESCRIPTION,
      });

  const sprints = await api(baseUrl, devEmail, "GET", `/api/sprints?projectId=${encodeURIComponent(project.id)}`);
  const existingSprint = (sprints.sprints ?? []).find((entry) => entry.name === DEMO_SPRINT_NAME);
  const sprint = existingSprint
    ? await api(baseUrl, devEmail, "PATCH", `/api/sprints/${existingSprint.id}`, {
        name: DEMO_SPRINT_NAME,
        goal: DEMO_SPRINT_GOAL,
        status: "active",
      })
    : await api(baseUrl, devEmail, "POST", "/api/sprints", {
        projectId: project.id,
        name: DEMO_SPRINT_NAME,
        goal: DEMO_SPRINT_GOAL,
        status: "active",
      });

  const stories = await api(baseUrl, devEmail, "GET", `/api/stories?projectId=${encodeURIComponent(project.id)}`);
  const byTitle = new Map((stories.stories ?? []).map((entry) => [entry.title, entry]));
  // Idempotency decision from the TRUE pre-state, so the report says what was
  // created vs. refreshed. Stable keys: project key, sprint name, story title.
  const plan = planSeedActions({
    projects: existingProject ? [existingProject] : [],
    sprints: existingSprint ? [existingSprint] : [],
    stories: stories.stories ?? [],
  });

  const seededStories = [];
  for (const story of DEMO_STORIES) {
    const existing = byTitle.get(story.title);
    // `POST /api/stories` needs projectId + sprintId; `PATCH /api/stories/:id`
    // has a strict schema that rejects projectId, so send only the fields it
    // accepts.
    const saved = existing
      ? await api(baseUrl, devEmail, "PATCH", `/api/stories/${existing.id}`, { ...story, sprintId: sprint.id })
      : await api(baseUrl, devEmail, "POST", "/api/stories", { ...story, projectId: project.id, sprintId: sprint.id });
    seededStories.push(saved);
  }

  console.log("demo seed complete (idempotent: matched by project key, sprint name and story title):");
  console.log(`  project  ${DEMO_PROJECT_KEY}  ${project.id}`);
  console.log(`  sprint   ${DEMO_SPRINT_NAME}  ${sprint.id}`);
  for (const story of seededStories) {
    console.log(`  story    ${story.status.padEnd(9)} ${story.id}  ${story.title}`);
  }
  console.log(`  actions  ${plan.map((action) => action.kind).join(", ")}`);
  console.log(`  owner    ${devEmail} (x-pigo-dev-email)`);
  return 0;
}

function usage() {
  console.log(`PiGO demo environment

Usage: scripts/demo-env.sh <command>

  up       validate env + DB safety invariant, start the stack, wait for health
  down     stop the stack WITHOUT deleting volumes
  status   read-only: containers, resolved DB target, health
  seed     idempotently create/refresh the demo project, sprint and stories
  doctor   PASS/FAIL checks (DB name, vault, docker socket, token, versions)

Environment overrides:
  PIGO_DEMO_ENV_FILE  explicit env file (wins over everything; keep it OUTSIDE the
                      deployed source/ tree, e.g. /app/pi-agent/demo.env)
  DEMO_COMPOSE_FILE   default deploy/docker/compose.demo.yaml

Env-file resolution order:
  1. $PIGO_DEMO_ENV_FILE (then legacy $DEMO_ENV_FILE)
  2. <parent-of-repo>/demo.env   (outside the tree a deploy replaces — recommended)
  3. deploy/docker/demo.env      (in-repo fallback for local development)
  4. deploy/docker/demo.env.example — refused (placeholders); prints a fix command
up/status/doctor always print the resolved env-file path, never any value.

This is NOT production. See docs/25-demo-environment.md.`);
}

async function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "up":
      return cmdUp(rest);
    case "down":
      return cmdDown(rest);
    case "status":
      return cmdStatus(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "seed":
      return cmdSeed(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
