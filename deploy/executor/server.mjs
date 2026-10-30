import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SERVICE = "pigo-release-executor";
const VERSION = "0.5.0";
const BODY_LIMIT = 128 * 1024;
const LOG_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

/** Display diagnostics only; never use this to rewrite commands or identities. */
export function redactExecutorDiagnostic(config, value, limit = 500) {
  const secrets = [config.token, config.releaseGatewayToken, config.metricsToken,
    config.callbackPublicOrigin, config.callbackInternalOrigin, config.releaseGatewayUrl,
    ...Object.entries(process.env).filter(([name, text]) => text && /(?:_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIALS?|_WEBHOOK)$/iu.test(name)).map(([, text]) => text),
  ].filter(text => typeof text === "string" && text.length > 0);
  const forms = [...new Set(secrets.flatMap(text => [text, encodeURIComponent(text), JSON.stringify(text).slice(1, -1)]
    .flatMap(form => [form, JSON.stringify(form).slice(1, -1)])))].sort((a, b) => b.length - a.length);
  let text = value instanceof Error ? value.message : typeof value === "string" ? value : "operation failed";
  for (const form of forms) text = text.replaceAll(form, "[redacted]");
  text = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/<>"']*@[^\s<>"']+/giu, "[redacted-url]")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>[\]}]+/giu, "$1 [redacted]")
    .replace(/([?&](?:access_token|api_key|token|password|secret|signature)=)[^&#\s"'<>]+/giu, "$1[redacted]")
    .replace(/\b([\w-]*(?:api[_-]?key|token|password|passwd|secret|credential)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\][]+)/giu, "$1[redacted]")
    .replace(/\/(?:workspace|app|data|tmp|home|srv|run|var|private|Users|Volumes)(?=\/|$)(?:\/[^\s"'<>`]*)?/gu, "[internal-path]");
  // Also cover custom operator roots not included in the common path prefixes.
  for (const location of [config.workspaceRoot, config.dataFile]) {
    if (typeof location === "string" && location.length > 1) text = text.replaceAll(location, "[internal-path]");
  }
  return text.slice(0, limit);
}

export function logExecutorDiagnostic(config, level, event, fields) {
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
    typeof value === "string" || value instanceof Error ? redactExecutorDiagnostic(config, value, 2_000) : value,
  ]));
  console[level](JSON.stringify({ level, event, ...safe }));
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticateWebhook({ authorization, signature, rawBody, token }) {
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedSignature = `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
  return safeEqual(bearer, token) && safeEqual(typeof signature === "string" ? signature : "", expectedSignature);
}

function requiredText(value, name, max = 1_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is required`);
  return value.trim();
}

export function validatePayload(value, expectedDeliveryId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  const event = value.event;
  if (event !== "run.release_requested" && event !== "run.rollback_requested" && event !== "release.published") throw new Error("unsupported event");
  const environment = value.environment;
  if (environment !== "staging" && environment !== "production") throw new Error("unsupported environment");
  const deliveryId = requiredText(value.deliveryId, "deliveryId", 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(deliveryId)) throw new Error("invalid deliveryId");
  if (deliveryId !== expectedDeliveryId) throw new Error("deliveryId header/body mismatch");
  const attempt = value.attempt;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 10_000) throw new Error("invalid attempt");
  const callbackUrl = requiredText(value.callbackUrl, "callbackUrl", 2_000);
  const parsedCallback = new URL(callbackUrl);
  // The callback origin is supplied by the operator on both PiGO and the
  // executor. Staging may deliberately use a private HTTP service origin; the
  // exact-origin and internal-path checks in `callbackTarget` still run before
  // any delivery is claimed. Keep the untrusted payload limited to web schemes
  // and reject URL credentials here, then let the operator allowlist decide
  // whether HTTP is acceptable for this executor instance.
  if (!["http:", "https:"].includes(parsedCallback.protocol) || parsedCallback.username || parsedCallback.password) {
    throw new Error("callbackUrl must use HTTP or HTTPS without credentials");
  }
  const expectedImageDigest = typeof value.expectedImageDigest === "string" ? value.expectedImageDigest.trim().toLowerCase() : "";
  if (environment === "production" && !/^sha256:[a-f0-9]{64}$/.test(expectedImageDigest)) {
    throw new Error("production requires expectedImageDigest from staging");
  }
  if (event === "run.release_requested" || event === "run.rollback_requested") {
    const repository = requiredText(value.repository, "repository", 2_000);
    if (repository.includes("\\") || (!path.posix.isAbsolute(repository)
      && repository.split("/").some((segment) => !segment || segment === "." || segment === ".."))) {
      throw new Error("repository must be an absolute workspace path or a safe relative workspace path");
    }
    const commit = requiredText(value.commit, "commit", 64).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full SHA-1");
    const reason = event === "run.rollback_requested" ? requiredText(value.reason, "reason", 2_000) : "";
    if (event === "run.rollback_requested" && environment !== "production") throw new Error("rollback is production-only");
    return {
      ...value,
      event,
      environment,
      deliveryId,
      attempt,
      callbackUrl,
      repository,
      commit,
      ...(reason ? { reason } : {}),
      ...(expectedImageDigest ? { expectedImageDigest } : {}),
    };
  }
  if (!Array.isArray(value.commits) || value.commits.length < 1 || value.commits.length > 200) {
    throw new Error("release commits must contain 1 to 200 reviewed commit SHAs");
  }
  const commits = [...new Set(value.commits.map((commit) => requiredText(commit, "commit", 40).toLowerCase()))];
  if (commits.some((commit) => !/^[0-9a-f]{40}$/.test(commit))) throw new Error("release commits must be full SHA-1 values");
  return {
    ...value,
    event,
    environment,
    deliveryId,
    attempt,
    callbackUrl,
    releaseId: requiredText(value.releaseId, "releaseId", 200),
    version: requiredText(value.version, "version", 200),
    commits,
    ...(expectedImageDigest ? { expectedImageDigest } : {}),
  };
}

export function callbackTarget(callbackUrl, publicOrigin, internalOrigin) {
  const target = new URL(callbackUrl);
  if (target.origin !== new URL(publicOrigin).origin) throw new Error("callback origin is not allowlisted");
  if (!target.pathname.startsWith("/api/internal/")) throw new Error("callback path is not allowlisted");
  return internalOrigin ? new URL(`${target.pathname}${target.search}`, internalOrigin).toString() : target.toString();
}

export function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deliveryKey(payload) {
  return `${payload.deliveryId}:${payload.attempt}`;
}

function bodyFingerprint(rawBody) {
  return createHash("sha256").update(rawBody).digest("hex");
}

function json(reply, status, body) {
  const encoded = JSON.stringify(body);
  reply.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  reply.end(encoded);
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function appendTail(current, chunk) {
  const combined = `${current}${chunk}`;
  return combined.length <= LOG_LIMIT ? combined : combined.slice(-LOG_LIMIT);
}

export function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeout ?? COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`${path.basename(file)} failed to start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const reason = timedOut ? "timed out" : `exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
        const detail = (stderr || stdout).trim().slice(-2_000);
        reject(new Error(`${path.basename(file)} ${reason}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export class JsonStateStore {
  constructor(file) {
    this.file = file;
    this.value = { version: 1, deliveries: {}, latestByEnvironment: {} };
    this.recoveredCallbacks = [];
    this.queue = Promise.resolve();
  }

  async init() {
    this.recoveredCallbacks = [];
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value.version !== 1 || !value.deliveries || !value.latestByEnvironment) throw new Error("unsupported executor state");
      this.value = value;
      const recoveredAt = new Date().toISOString();
      let recovered = false;
      for (const [key, delivery] of Object.entries(this.value.deliveries)) {
        if (delivery.status === "pending") {
          delivery.status = "failed";
          delivery.callbackStatus = "pending";
          delivery.detail = "executor restarted before deployment completed; submit a new attempt";
          delivery.finishedAt = recoveredAt;
          recovered = true;
        }
        if ((delivery.status !== "failed" && delivery.status !== "succeeded") || delivery.callbackStatus !== "pending") continue;
        if (typeof delivery.callbackUrl !== "string" || !delivery.callbackUrl
          || typeof delivery.deliveryId !== "string" || !Number.isInteger(delivery.attempt)) {
          // Legacy state did not persist callbackUrl. Keep it retryable without
          // inventing a callback target or weakening the callback allowlist.
          delivery.callbackStatus = "failed";
          recovered = true;
          continue;
        }
        this.recoveredCallbacks.push({
          key,
          payload: {
            deliveryId: delivery.deliveryId,
            attempt: delivery.attempt,
            callbackUrl: delivery.callbackUrl,
          },
          outcome: {
            status: delivery.status,
            detail: String(delivery.detail ?? "deployment result recovered after executor restart"),
            ...(delivery.deploymentId ? { deploymentId: delivery.deploymentId } : {}),
            ...(delivery.url ? { url: delivery.url } : {}),
            ...(delivery.commit ? { commit: delivery.commit } : {}),
            ...(delivery.image ? { image: delivery.image } : {}),
            ...(delivery.imageDigest ? { imageDigest: delivery.imageDigest } : {}),
            ...(delivery.rolledBackFromCommit ? { rolledBackFromCommit: delivery.rolledBackFromCommit } : {}),
            ...(delivery.rolledBackFromDigest ? { rolledBackFromDigest: delivery.rolledBackFromDigest } : {}),
          },
        });
      }
      await chmod(this.file, 0o600);
      if (recovered) await this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async mutate(operation) {
    let result;
    this.queue = this.queue.catch(() => undefined).then(async () => {
      result = operation(this.value);
      await this.persist();
    });
    await this.queue;
    return result;
  }

  getDelivery(key) {
    return this.value.deliveries[key];
  }

  takeRecoveredCallbacks() {
    return this.recoveredCallbacks.splice(0);
  }

  latest(environment) {
    const key = this.value.latestByEnvironment[environment];
    return key ? this.value.deliveries[key] : undefined;
  }

  successfulDeployment(environment, repository, commit) {
    return Object.values(this.value.deliveries)
      .filter((item) => item.event === "run.release_requested"
        && item.environment === environment
        && item.status === "succeeded"
        && item.repository === repository
        && item.commit === commit
        && item.imageDigest)
      .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)))[0];
  }

  successfulDeploymentsForCommits(environment, commits) {
    const allowed = new Set(commits);
    return Object.values(this.value.deliveries)
      .filter((item) => item.event === "run.release_requested"
        && item.environment === environment
        && item.status === "succeeded"
        && allowed.has(item.commit)
        && item.imageDigest)
      .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)));
  }

  summary() {
    const deliveries = Object.values(this.value.deliveries);
    return {
      deliveries: deliveries.length,
      pending: deliveries.filter((item) => item.status === "pending").length,
      failed: deliveries.filter((item) => item.status === "failed").length,
    };
  }

  metricCounts() {
    const states = ["pending", "succeeded", "failed", "other"];
    const counts = { delivery: Object.fromEntries(states.map(s => [s, 0])), callback: Object.fromEntries(states.map(s => [s, 0])) };
    for (const item of Object.values(this.value.deliveries)) {
      counts.delivery[states.includes(item.status) ? item.status : "other"]++;
      counts.callback[states.includes(item.callbackStatus) ? item.callbackStatus : "other"]++;
    }
    return counts;
  }

  async persist() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
  }
}

export function executorEnvironment(config, environment) {
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    APP_BASE_URL: environment === "staging" ? config.stagingUrl : config.productionUrl,
    ORDER_STATUS_PORT: environment === "staging" ? String(config.stagingPort) : String(config.productionPort),
    COMPOSE_PROJECT_NAME: `order-status-${environment}`,
    PIGO_DEPLOY_ENVIRONMENT: environment,
  };
}

export async function resolveApplicationTarget(config, payload, options = {}) {
  const workspaceRoot = await realpath(config.workspaceRoot);
  const requestedRepository = path.isAbsolute(payload.repository)
    ? payload.repository
    : path.join(workspaceRoot, payload.repository);
  const repository = await realpath(requestedRepository);
  if (!pathWithin(workspaceRoot, repository)) throw new Error("repository is outside the workspace allowlist");
  const repositoryStats = await stat(repository);
  if (!repositoryStats.isDirectory()) throw new Error("repository is not a directory");
  const git = async (args) => command("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...args], {
    timeout: 60_000,
    env: executorEnvironment(config, payload.environment),
  });
  const resolvedCommit = (await git(["rev-parse", `${payload.commit}^{commit}`])).stdout.toLowerCase();
  const head = (await git(["rev-parse", "HEAD"])).stdout.toLowerCase();
  if (resolvedCommit !== payload.commit) throw new Error("target commit is not available in the workspace repository");
  if (options.requireHead !== false && head !== payload.commit) throw new Error("workspace HEAD does not match the reviewed merge commit");
  if ((await git(["status", "--porcelain"])).stdout) throw new Error("workspace is dirty; deployment refused");
  const appDirectory = await realpath(path.join(repository, config.appPath));
  if (!pathWithin(repository, appDirectory)) throw new Error("application path escapes the repository");
  return { repository, appDirectory };
}

async function releaseGatewayRequest(config, body) {
  const response = await (config.fetchImpl ?? fetch)(`${config.releaseGatewayUrl}/v1/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.releaseGatewayToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  const raw = await response.text();
  let decoded;
  try { decoded = raw ? JSON.parse(raw) : {}; } catch { throw new Error("release gateway returned invalid JSON"); }
  if (!response.ok) throw new Error(`release gateway rejected deployment: ${redactExecutorDiagnostic(config, String(decoded.error || `HTTP ${response.status}`), 300)}`);
  if (!decoded || typeof decoded !== "object" || !/^sha256:[a-f0-9]{64}$/.test(decoded.imageDigest ?? "")) {
    throw new Error("release gateway returned incomplete deployment evidence");
  }
  return decoded;
}

export async function runDeploy(config, store, payload, reportProgress = async () => undefined) {
  await reportProgress("validating", "workspace and reviewed commit validation started");
  const target = await resolveApplicationTarget(config, payload);
  const image = `${config.imageRepository}:${payload.commit}`;
  let staging;
  let approvedDigest;
  if (payload.environment === "production") {
    staging = store.successfulDeployment("staging", target.repository, payload.commit);
    if (staging && payload.expectedImageDigest !== staging.imageDigest) {
      throw new Error("requested production digest does not match the successful staging deployment");
    }
    // Staging and production executors may intentionally use separate state
    // volumes. In that topology the production executor has no local staging
    // record. The shared release gateway remains the enforcement boundary: it
    // verifies that a gateway-managed staging container with this exact commit,
    // immutable image digest, and fixed runtime policy is active before it
    // creates a production candidate.
    approvedDigest = staging?.imageDigest ?? payload.expectedImageDigest;
  }
  await reportProgress("deploying", "isolated release gateway deployment and smoke checks started");
  const deployed = await releaseGatewayRequest(config, {
    event: "deploy",
    environment: payload.environment,
    repository: target.repository,
    commit: payload.commit,
    ...(approvedDigest ? { expectedImageDigest: approvedDigest } : {}),
  });
  await reportProgress("verifying", "isolated release gateway evidence verification started");
  if (deployed.image !== image || deployed.repository !== target.repository || deployed.commit !== payload.commit) {
    throw new Error("release gateway evidence does not match the requested deployment");
  }
  const digest = deployed.imageDigest;
  if (payload.environment === "production") {
    if (digest !== approvedDigest || digest !== payload.expectedImageDigest) {
      throw new Error("production deployment changed the staged image digest");
    }
  }
  return {
    detail: `${payload.environment} deploy and smoke checks passed`,
    deploymentId: `order-status-${payload.environment}-${payload.commit.slice(0, 12)}`,
    ...(payload.environment === "staging"
      ? config.stagingPublicUrl ? { url: config.stagingPublicUrl } : {}
      : config.productionPublicUrl ? { url: config.productionPublicUrl } : {}),
    commit: payload.commit,
    image,
    imageDigest: digest,
    repository: target.repository,
  };
}

export async function runRollback(config, store, payload, reportProgress = async () => undefined) {
  await reportProgress("validating", "immutable rollback target validation started");
  const target = await resolveApplicationTarget(config, payload, { requireHead: false });
  const previous = store.latest("production");
  if (!previous || previous.status !== "succeeded" || !previous.imageDigest || !previous.commit) {
    throw new Error("current production deployment evidence is unavailable");
  }
  if (previous.repository !== target.repository) throw new Error("current production deployment belongs to a different repository");
  const historical = store.successfulDeployment("production", target.repository, payload.commit);
  if (!historical || historical.imageDigest !== payload.expectedImageDigest) {
    throw new Error("rollback target is not a successful historical production deployment");
  }
  if (previous.imageDigest === historical.imageDigest) throw new Error("rollback target is already active in production");

  const image = `${config.imageRepository}:${payload.commit}`;
  await reportProgress("deploying", "isolated release gateway rollback and smoke checks started");
  const deployed = await releaseGatewayRequest(config, {
    event: "rollback",
    environment: "production",
    repository: target.repository,
    commit: payload.commit,
    expectedImageDigest: historical.imageDigest,
  });
  await reportProgress("verifying", "isolated release gateway rollback evidence verification started");
  if (deployed.image !== image || deployed.repository !== target.repository || deployed.commit !== payload.commit) {
    throw new Error("release gateway evidence does not match the requested rollback");
  }
  const digest = deployed.imageDigest;
  if (digest !== historical.imageDigest || digest !== payload.expectedImageDigest) {
    throw new Error("rollback changed the historical image digest");
  }
  return {
    detail: "production rollback and smoke checks passed",
    deploymentId: `order-status-production-rollback-${payload.commit.slice(0, 12)}`,
    ...(config.productionPublicUrl ? { url: config.productionPublicUrl } : {}),
    commit: payload.commit,
    image,
    imageDigest: digest,
    repository: target.repository,
    rolledBackFromCommit: previous.commit,
    rolledBackFromDigest: previous.imageDigest,
  };
}

export async function runReleaseRegistration(config, store, payload, containsCommit = deploymentContainsCommit) {
  const candidates = store.successfulDeploymentsForCommits(payload.environment, payload.commits);
  let deployed;
  for (const candidate of candidates) {
    if (payload.environment === "production" && candidate.imageDigest !== payload.expectedImageDigest) continue;
    let includesAll = true;
    for (const commit of payload.commits) {
      if (!await containsCommit(config, candidate, commit)) { includesAll = false; break; }
    }
    if (includesAll) { deployed = candidate; break; }
  }
  if (!deployed) throw new Error(`no successful ${payload.environment} deployment matches the reviewed release commits`);
  if (payload.environment === "production" && deployed.imageDigest !== payload.expectedImageDigest) {
    throw new Error("production release does not match the staged image digest");
  }
  return {
    detail: `${payload.version} registered against the existing ${payload.environment} deployment`,
    deploymentId: deployed.deploymentId,
    url: deployed.url,
    commit: deployed.commit,
    image: deployed.image,
    imageDigest: deployed.imageDigest,
    reviewedCommits: payload.commits,
  };
}

async function deploymentContainsCommit(config, deployment, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(deployment.commit ?? "")) return false;
  const root = await realpath(config.workspaceRoot);
  const repository = await realpath(deployment.repository);
  if (!pathWithin(root, repository)) throw new Error("release repository is outside the workspace allowlist");
  try {
    await command("git", ["--no-replace-objects", "-c", `safe.directory=${repository}`, "-C", repository,
      "merge-base", "--is-ancestor", commit, deployment.commit], {
      timeout: 30_000, env: executorEnvironment(config, deployment.environment),
    });
    return true;
  } catch { return false; }
}

export async function postCallback(config, payload, outcome) {
  const url = callbackTarget(payload.callbackUrl, config.callbackPublicOrigin, config.callbackInternalOrigin);
  const body = {
    deliveryId: payload.deliveryId,
    attempt: payload.attempt,
    status: outcome.status,
    detail: redactExecutorDiagnostic(config, outcome.detail),
    ...(outcome.deploymentId ? { deploymentId: outcome.deploymentId } : {}),
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.commit ? { commit: outcome.commit } : {}),
    ...(outcome.image ? { image: outcome.image } : {}),
    ...(outcome.imageDigest ? { imageDigest: outcome.imageDigest } : {}),
    ...(outcome.reviewedCommits ? { reviewedCommits: outcome.reviewedCommits } : {}),
    ...(outcome.rolledBackFromCommit ? { rolledBackFromCommit: outcome.rolledBackFromCommit } : {}),
    ...(outcome.rolledBackFromDigest ? { rolledBackFromDigest: outcome.rolledBackFromDigest } : {}),
  };
  let lastError;
  for (const delayMs of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = await (config.fetchImpl ?? fetch)(url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const error = new Error(`callback returned HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return;
    } catch (error) {
      lastError = error;
      if (error.retryable === false) throw error;
    }
  }
  throw lastError;
}

export async function postProgress(config, payload, stage, detail) {
  if (payload.event !== "run.release_requested" && payload.event !== "run.rollback_requested") return;
  const url = callbackTarget(payload.callbackUrl, config.callbackPublicOrigin, config.callbackInternalOrigin);
  const response = await (config.fetchImpl ?? fetch)(url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({
      deliveryId: payload.deliveryId,
      attempt: payload.attempt,
      status: "progress",
      stage,
      detail: redactExecutorDiagnostic(config, detail),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`progress callback returned HTTP ${response.status}`);
}

export function loadConfig(environment = process.env) {
  const token = environment.PIGO_EXECUTOR_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("PIGO_EXECUTOR_TOKEN must contain at least 32 characters");
  const appPath = environment.PIGO_EXECUTOR_APP_PATH?.trim() || "apps/order-status-app";
  if (path.isAbsolute(appPath) || appPath.split(/[\\/]/).includes("..")) throw new Error("PIGO_EXECUTOR_APP_PATH must be a safe relative path");
  if (!environment.PIGO_EXECUTOR_CALLBACK_ORIGIN) throw new Error("PIGO_EXECUTOR_CALLBACK_ORIGIN is required");
  const callbackOriginUrl = new URL(environment.PIGO_EXECUTOR_CALLBACK_ORIGIN);
  if (!["http:", "https:"].includes(callbackOriginUrl.protocol)) {
    throw new Error("PIGO_EXECUTOR_CALLBACK_ORIGIN must use HTTP or HTTPS");
  }
  if (callbackOriginUrl.username || callbackOriginUrl.password || callbackOriginUrl.search || callbackOriginUrl.hash
    || (callbackOriginUrl.pathname && callbackOriginUrl.pathname !== "/")) {
    throw new Error("PIGO_EXECUTOR_CALLBACK_ORIGIN must contain only scheme and host");
  }
  const callbackPublicOrigin = callbackOriginUrl.origin;
  const callbackInternalOrigin = environment.PIGO_EXECUTOR_CALLBACK_INTERNAL_ORIGIN
    ? new URL(environment.PIGO_EXECUTOR_CALLBACK_INTERNAL_ORIGIN).origin
    : "";
  const allowedEnvironments = new Set((environment.PIGO_EXECUTOR_ALLOWED_ENVIRONMENTS || "staging,production")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  if (allowedEnvironments.size === 0 || [...allowedEnvironments].some((value) => !["staging", "production"].includes(value))) {
    throw new Error("PIGO_EXECUTOR_ALLOWED_ENVIRONMENTS must contain staging and/or production");
  }
  const port = Number(environment.PORT || 3300);
  const stagingPort = Number(environment.PIGO_EXECUTOR_STAGING_PORT || 18080);
  const productionPort = Number(environment.PIGO_EXECUTOR_PRODUCTION_PORT || 18081);
  for (const [name, value] of [["PORT", port], ["PIGO_EXECUTOR_STAGING_PORT", stagingPort], ["PIGO_EXECUTOR_PRODUCTION_PORT", productionPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer TCP port`);
  }
  const workspaceRoot = environment.PIGO_EXECUTOR_WORKSPACE_ROOT || "/workspace";
  if (!path.isAbsolute(workspaceRoot)) throw new Error("PIGO_EXECUTOR_WORKSPACE_ROOT must be absolute");
  const imageRepository = environment.PIGO_EXECUTOR_IMAGE_REPOSITORY || "local/order-status-app";
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(imageRepository)) throw new Error("PIGO_EXECUTOR_IMAGE_REPOSITORY is invalid");
  const targetNetwork = environment.PIGO_EXECUTOR_TARGET_NETWORK || "pigo-release-targets";
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(targetNetwork)) throw new Error("PIGO_EXECUTOR_TARGET_NETWORK is invalid");
  const releaseGatewayToken = environment.PIGO_RELEASE_GATEWAY_TOKEN?.trim() ?? "";
  if (releaseGatewayToken.length < 32) throw new Error("PIGO_RELEASE_GATEWAY_TOKEN must contain at least 32 characters");
  const releaseGateway = new URL(environment.PIGO_RELEASE_GATEWAY_URL || "http://release-gateway:3310");
  if (releaseGateway.protocol !== "http:" || releaseGateway.username || releaseGateway.password || releaseGateway.pathname !== "/") {
    throw new Error("PIGO_RELEASE_GATEWAY_URL must be an HTTP origin without credentials or a path");
  }
  const publicUrl = (name) => {
    const raw = environment[name]?.trim() || "";
    if (!raw) return "";
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${name} must use HTTP or HTTPS`);
    if (parsed.username || parsed.password) throw new Error(`${name} must not contain credentials`);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "host.docker.internal" || hostname === "localhost" || hostname === "0.0.0.0"
      || hostname === "::1" || hostname.startsWith("127.")) {
      throw new Error(`${name} must be reachable from a user's browser`);
    }
    return parsed.toString();
  };
  return {
    token,
    metricsToken: environment.PIGO_EXECUTOR_METRICS_TOKEN?.trim() || "",
    host: environment.HOST || "127.0.0.1",
    port,
    workspaceRoot,
    appPath,
    dataFile: environment.PIGO_EXECUTOR_DATA_FILE || "/data/executions.json",
    callbackPublicOrigin,
    callbackInternalOrigin,
    allowedEnvironments,
    imageRepository,
    targetNetwork,
    releaseGatewayToken,
    releaseGatewayUrl: releaseGateway.origin,
    stagingUrl: environment.PIGO_EXECUTOR_STAGING_URL || "http://127.0.0.1:18080",
    productionUrl: environment.PIGO_EXECUTOR_PRODUCTION_URL || "http://127.0.0.1:18081",
    stagingPublicUrl: publicUrl("PIGO_EXECUTOR_STAGING_PUBLIC_URL"),
    productionPublicUrl: publicUrl("PIGO_EXECUTOR_PRODUCTION_PUBLIC_URL"),
    stagingPort,
    productionPort,
  };
}

export async function createExecutor(options = {}) {
  const config = options.config ?? loadConfig();
  const allowedEnvironments = config.allowedEnvironments ?? new Set(["staging", "production"]);
  const store = options.store ?? new JsonStateStore(config.dataFile);
  await store.init();
  let jobs = Promise.resolve();
  let metricsCache;

  async function processDelivery(payload, key) {
    let outcome;
    const reportProgress = async (stage, detail) => {
      try {
        await postProgress(config, payload, stage, detail);
      } catch (error) {
        logExecutorDiagnostic(config, "warn", "progress.callback_failed", { deliveryId: payload.deliveryId, attempt: payload.attempt, stage, message: error.message });
      }
    };
    try {
      const result = payload.event === "run.release_requested"
        ? await runDeploy(config, store, payload, reportProgress)
        : payload.event === "run.rollback_requested"
          ? await runRollback(config, store, payload, reportProgress)
          : await runReleaseRegistration(config, store, payload);
      outcome = { status: "succeeded", ...result };
    } catch (error) {
      outcome = { status: "failed", detail: redactExecutorDiagnostic(config, error instanceof Error ? error : "deployment failed") };
    }
    outcome = { ...outcome, detail: redactExecutorDiagnostic(config, outcome.detail) };
    await store.mutate((state) => {
      state.deliveries[key] = { ...state.deliveries[key], ...outcome, finishedAt: new Date().toISOString() };
      if (outcome.status === "succeeded" && (payload.event === "run.release_requested" || payload.event === "run.rollback_requested")) state.latestByEnvironment[payload.environment] = key;
    });
    try {
      await postCallback(config, payload, outcome);
      await store.mutate((state) => { state.deliveries[key].callbackStatus = "succeeded"; });
    } catch (error) {
      logExecutorDiagnostic(config, "error", "callback.failed", { deliveryId: payload.deliveryId, attempt: payload.attempt, message: error.message });
      await store.mutate((state) => { state.deliveries[key].callbackStatus = "failed"; });
    }
  }

  async function retryCallback(payload, key, outcome) {
    try {
      await postCallback(config, payload, outcome);
      await store.mutate((state) => { state.deliveries[key].callbackStatus = "succeeded"; });
    } catch (error) {
      logExecutorDiagnostic(config, "error", "callback.retry_failed", { deliveryId: payload.deliveryId, attempt: payload.attempt, message: error.message });
      await store.mutate((state) => { state.deliveries[key].callbackStatus = "failed"; });
    }
  }

  for (const recovered of store.takeRecoveredCallbacks?.() ?? []) {
    jobs = jobs.then(() => retryCallback(recovered.payload, recovered.key, recovered.outcome)).catch((error) => {
      logExecutorDiagnostic(config, "error", "recovery.callback_unhandled", { deliveryId: recovered.payload.deliveryId, message: error.message });
    });
  }

  const server = http.createServer(async (request, reply) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return json(reply, 200, { status: "ok", service: SERVICE, version: VERSION, ...store.summary() });
      }
      if (request.method === "GET" && request.url === "/metrics") {
        // Dedicated read-only credentials cannot also be deployment credentials.
        if (!config.metricsToken || config.metricsToken.length < 32 || config.metricsToken === config.token || config.metricsToken === config.releaseGatewayToken
          || !safeEqual(String(request.headers.authorization ?? ""), `Bearer ${config.metricsToken}`)) return json(reply, 401, { error: "Unauthorized" });
        try {
          if (!metricsCache || Date.now() - metricsCache.at >= 15_000) metricsCache = { at: Date.now(), counts: store.metricCounts() };
        } catch { return json(reply, 503, { error: "Metrics unavailable" }); }
        const only = allowedEnvironments.size === 1 ? [...allowedEnvironments][0] : "unknown";
        const environment = ["staging", "production"].includes(only) ? only : "unknown";
        const labels = `service="${SERVICE}",environment="${environment}",version="${VERSION}"`;
        let output = "";
        for (const [kind, counts] of Object.entries(metricsCache.counts)) {
          const name = `pigo_executor_${kind}_records`;
          output += `# HELP ${name} Retained ${kind} records; counts may decrease after retention.\n# TYPE ${name} gauge\n`;
          for (const [state, value] of Object.entries(counts)) output += `${name}{${labels},state="${state}"} ${value}\n`;
        }
        output += `# HELP pigo_executor_observation_age_seconds Age of cached executor counts.\n# TYPE pigo_executor_observation_age_seconds gauge\npigo_executor_observation_age_seconds{${labels}} ${(Date.now() - metricsCache.at) / 1000}\n`;
        reply.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
        return reply.end(output);
      }
      if (request.method !== "POST" || request.url !== "/hooks/pigo-release") return json(reply, 404, { error: "Not found" });
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(reply, 415, { error: "Content-Type must be application/json" });
      }
      const rawBody = await readBody(request);
      if (!authenticateWebhook({
        authorization: request.headers.authorization,
        signature: request.headers["x-pigo-signature"],
        rawBody,
        token: config.token,
      })) return json(reply, 401, { error: "Unauthorized" });
      const deliveryId = requiredText(request.headers["x-pigo-delivery-id"], "X-PiGO-Delivery-Id", 200);
      let decoded;
      try {
        decoded = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return json(reply, 400, { error: "Invalid JSON" });
      }
      let payload;
      try {
        payload = validatePayload(decoded, deliveryId);
        if (!allowedEnvironments.has(payload.environment)) {
          throw new Error(`environment ${payload.environment} is not allowed by this executor`);
        }
        callbackTarget(payload.callbackUrl, config.callbackPublicOrigin, config.callbackInternalOrigin);
      } catch (error) {
        logExecutorDiagnostic(config, "warn", "request.rejected", {
          status: 400,
          deliveryId: deliveryId.slice(0, 200),
          reason: redactExecutorDiagnostic(config, error instanceof Error ? error : "invalid request"),
        });
        return json(reply, 400, { error: redactExecutorDiagnostic(config, error) });
      }
      const key = deliveryKey(payload);
      const fingerprint = bodyFingerprint(rawBody);
      const claim = await store.mutate((state) => {
        const existing = state.deliveries[key];
        if (existing) {
          if (existing.fingerprint !== fingerprint) return { kind: "conflict", existing };
          if (existing.status !== "pending" && existing.callbackStatus === "failed") {
            existing.callbackStatus = "pending";
            return { kind: "retry-callback", existing: { ...existing } };
          }
          return { kind: "duplicate", existing };
        }
        state.deliveries[key] = {
          event: payload.event,
          environment: payload.environment,
          deliveryId: payload.deliveryId,
          attempt: payload.attempt,
          callbackUrl: payload.callbackUrl,
          fingerprint,
          status: "pending",
          callbackStatus: "pending",
          startedAt: new Date().toISOString(),
          ...(payload.commit ? { commit: payload.commit } : {}),
          ...(payload.reason ? { reason: redactExecutorDiagnostic(config, payload.reason) } : {}),
        };
        return { kind: "claimed" };
      });
      if (claim.kind === "conflict") return json(reply, 409, { error: "delivery id and attempt were reused with a different payload" });
      if (claim.kind === "retry-callback") {
        jobs = jobs.then(() => retryCallback(payload, key, claim.existing)).catch((error) => {
          logExecutorDiagnostic(config, "error", "callback.retry_unhandled", { deliveryId, message: error.message });
        });
        return json(reply, 202, { accepted: true, duplicate: true, callbackRetry: true, status: claim.existing.status, deliveryId, attempt: payload.attempt });
      }
      if (claim.kind === "duplicate") {
        const status = claim.existing.status === "pending" ? 202 : claim.existing.status === "succeeded" ? 200 : 409;
        return json(reply, status, { accepted: status === 202, duplicate: true, status: claim.existing.status, deliveryId, attempt: payload.attempt });
      }
      jobs = jobs.then(() => processDelivery(payload, key)).catch((error) => {
        logExecutorDiagnostic(config, "error", "job.unhandled", { deliveryId, message: error.message });
      });
      return json(reply, 202, { accepted: true, deliveryId, attempt: payload.attempt });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      logExecutorDiagnostic(config, "error", "request.failed", { status, message: error.message });
      return json(reply, status, { error: status === 500 ? "Internal server error" : redactExecutorDiagnostic(config, error) });
    }
  });
  return { server, config, store };
}

async function main() {
  const { server, config } = await createExecutor();
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ level: "info", event: "executor.started", host: config.host, port: config.port, version: VERSION }));
  });
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main().catch((error) => {
  logExecutorDiagnostic({}, "error", "executor.start_failed", { message: error });
  process.exit(1);
});
