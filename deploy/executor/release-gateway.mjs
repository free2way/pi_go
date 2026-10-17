#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  executorEnvironment,
  resolveApplicationTarget,
} from "./server.mjs";

const SERVICE = "pigo-release-gateway";
const VERSION = "0.1.0";
const BODY_LIMIT = 64 * 1024;

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function secret(value, name) {
  const text = required(value, name);
  if (Buffer.byteLength(text) < 32 || Buffer.byteLength(text) > 4096) {
    throw new Error(`${name} must contain between 32 and 4096 bytes`);
  }
  return text;
}

function strictFlag(value, name) {
  if (value === undefined || value === "") return true;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be the literal 0 or 1`);
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

export function authorizeReleaseGateway(headers, token) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    && safeEqual(authorization.slice(7), token);
}

function exactKeys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${key} is not allowed`);
}

export function validateReleaseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  exactKeys(value, new Set(["event", "environment", "repository", "commit", "expectedImageDigest"]));
  if (value.event !== "deploy" && value.event !== "rollback") throw new Error("event is not allowed");
  if (value.environment !== "staging" && value.environment !== "production") throw new Error("environment is not allowed");
  if (value.event === "rollback" && value.environment !== "production") throw new Error("rollback is production-only");
  const repository = required(value.repository, "repository");
  if (!path.isAbsolute(repository) || repository.includes("\0") || repository.includes("\n")) {
    throw new Error("repository must be an absolute workspace path");
  }
  const commit = required(value.commit, "commit").toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("commit must be a full SHA-1");
  const expectedImageDigest = String(value.expectedImageDigest ?? "").trim().toLowerCase();
  if (value.environment === "production" && !/^sha256:[a-f0-9]{64}$/u.test(expectedImageDigest)) {
    throw new Error("production requires an immutable expectedImageDigest");
  }
  if (value.environment === "staging" && expectedImageDigest) throw new Error("staging must not select an existing image digest");
  return { event: value.event, environment: value.environment, repository, commit, expectedImageDigest };
}

function json(reply, status, value) {
  const body = JSON.stringify(value);
  reply.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  reply.end(body);
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function loadReleaseGatewayConfig(environment = process.env) {
  const appPath = environment.PIGO_EXECUTOR_APP_PATH?.trim() || "apps/order-status-app";
  if (path.isAbsolute(appPath) || appPath.split(/[\\/]/u).includes("..")) {
    throw new Error("PIGO_EXECUTOR_APP_PATH must be a safe relative path");
  }
  const workspaceRoot = environment.PIGO_EXECUTOR_WORKSPACE_ROOT || "/workspace";
  if (!path.isAbsolute(workspaceRoot) || path.resolve(workspaceRoot) === path.parse(workspaceRoot).root) {
    throw new Error("PIGO_EXECUTOR_WORKSPACE_ROOT must be an absolute, non-root path");
  }
  const imageRepository = environment.PIGO_EXECUTOR_IMAGE_REPOSITORY || "local/order-status-app";
  if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(imageRepository)) throw new Error("PIGO_EXECUTOR_IMAGE_REPOSITORY is invalid");
  const targetNetwork = environment.PIGO_EXECUTOR_TARGET_NETWORK || "pigo-release-targets";
  if (!/^[a-z0-9][a-z0-9_.-]*$/iu.test(targetNetwork) || ["host", "default", "none"].includes(targetNetwork)) {
    throw new Error("PIGO_EXECUTOR_TARGET_NETWORK is invalid");
  }
  const number = (name, fallback) => {
    const result = Number(environment[name] || fallback);
    if (!Number.isInteger(result) || result < 1 || result > 65_535) throw new Error(`${name} must be an integer TCP port`);
    return result;
  };
  const port = number("PORT", 3310);
  const stagingPort = number("PIGO_EXECUTOR_STAGING_PORT", 18080);
  const productionPort = number("PIGO_EXECUTOR_PRODUCTION_PORT", 18081);
  return {
    token: secret(environment.PIGO_RELEASE_GATEWAY_TOKEN, "PIGO_RELEASE_GATEWAY_TOKEN"),
    host: environment.HOST || "0.0.0.0",
    port,
    workspaceRoot: path.resolve(workspaceRoot),
    appPath,
    imageRepository,
    targetNetwork,
    stagingUrl: environment.PIGO_EXECUTOR_STAGING_URL || "http://host.docker.internal:18080",
    productionUrl: environment.PIGO_EXECUTOR_PRODUCTION_URL || "http://host.docker.internal:18081",
    stagingPort,
    productionPort,
    requireRootless: strictFlag(environment.PIGO_RELEASE_REQUIRE_ROOTLESS, "PIGO_RELEASE_REQUIRE_ROOTLESS"),
  };
}

async function docker(config, environment, args, options = {}, runCommand = command) {
  return runCommand("docker", args, {
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd,
    env: executorEnvironment(config, environment),
  });
}

export function isRootlessDockerSecurityOptions(value) {
  return Array.isArray(value)
    && value.some((entry) => typeof entry === "string" && /(?:^|,)name=rootless(?:,|$)/u.test(entry));
}

export async function assertRequiredDockerSecurity(config, runCommand = command) {
  if (!config.requireRootless) return;
  const result = await docker(
    config,
    "staging",
    ["info", "--format", "{{json .SecurityOptions}}"],
    {},
    runCommand,
  );
  let securityOptions;
  try { securityOptions = JSON.parse(result.stdout); } catch { throw new Error("Docker returned invalid security options"); }
  if (!isRootlessDockerSecurityOptions(securityOptions)) {
    throw new Error("PIGO_RELEASE_REQUIRE_ROOTLESS=1 but the configured Docker engine is not rootless");
  }
}

async function inspectImage(config, environment, image, runCommand) {
  const digest = await docker(config, environment, ["image", "inspect", image, "--format", "{{.Id}}"], {}, runCommand);
  const revision = await docker(config, environment, [
    "image", "inspect", image, "--format", "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}",
  ], {}, runCommand);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest.stdout)) throw new Error("image digest is unavailable");
  return { digest: digest.stdout, revision: revision.stdout.toLowerCase() };
}

export async function ensureImage(config, payload, target, runCommand) {
  const image = `${config.imageRepository}:${payload.commit}`;
  let inspected;
  if (payload.environment === "staging") {
    // Staging is the build boundary. Rebuild from the reviewed checkout even
    // when a same-tag image already exists; a stale or attacker-created local
    // tag must never be accepted as evidence of the reviewed source.
    await docker(config, payload.environment, [
      "build", "--label", `org.opencontainers.image.revision=${payload.commit}`, "--tag", image, ".",
    ], { cwd: target.appDirectory, timeout: 15 * 60_000 }, runCommand);
    inspected = await inspectImage(config, payload.environment, image, runCommand);
  } else {
    inspected = await inspectImage(config, payload.environment, image, runCommand);
  }
  if (inspected.revision !== payload.commit) throw new Error("image revision label does not match the reviewed commit");
  if (payload.environment === "production" && inspected.digest !== payload.expectedImageDigest) {
    throw new Error("local image does not match the approved staging digest");
  }
  return { image, imageDigest: inspected.digest };
}

export function validateManagedReleaseContainer(value, policy) {
  const port = value?.HostConfig?.PortBindings?.[`${policy.containerPort}/tcp`];
  const tmpfs = String(value?.HostConfig?.Tmpfs?.["/tmp"] ?? "").split(",");
  return Boolean(
    value
    && value.Name === `/${policy.name}`
    && value.Config?.Image === policy.image
    && value.Config?.User === "1000:1000"
    && value.Config?.Labels?.["pigo.release.gateway"] === "1"
    && value.Config?.Labels?.["pigo.release.environment"] === policy.environment
    && value.Config?.Labels?.["org.opencontainers.image.revision"] === policy.commit
    && value.HostConfig?.Privileged === false
    && value.HostConfig?.ReadonlyRootfs === true
    && Array.isArray(value.HostConfig?.CapDrop)
    && value.HostConfig.CapDrop.length === 1
    && value.HostConfig.CapDrop[0] === "ALL"
    && Array.isArray(value.HostConfig?.SecurityOpt)
    && value.HostConfig.SecurityOpt.includes("no-new-privileges:true")
    && value.HostConfig?.NetworkMode === policy.network
    && value.HostConfig?.PidsLimit === 128
    && value.HostConfig?.Memory === 268435456
    && value.HostConfig?.NanoCpus === 1_000_000_000
    && value.HostConfig?.RestartPolicy?.Name === "unless-stopped"
    && Object.keys(value.HostConfig?.Tmpfs ?? {}).length === 1
    && ["rw", "nosuid", "nodev", "noexec", "size=67108864"].every((option) => tmpfs.includes(option))
    && !value.HostConfig?.PidMode
    // Docker 29 normalizes the secure default to "private" while older
    // daemons report an empty string. Both mean no host/container IPC sharing.
    && ["", "private"].includes(value.HostConfig?.IpcMode ?? "")
    && !value.HostConfig?.Binds?.length
    && !value.HostConfig?.Devices?.length
    && !value.Mounts?.length
    && !Object.keys(value.Config?.Volumes ?? {}).length
    && Array.isArray(port)
    && port.length === 1
    && port[0]?.HostIp === "127.0.0.1"
    && Number(port[0]?.HostPort) === policy.hostPort
  );
}

async function findContainer(config, environment, name, runCommand) {
  const listed = await docker(config, environment, [
    "container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}",
  ], {}, runCommand);
  if (!listed.stdout) return undefined;
  if (listed.stdout !== name) throw new Error("Docker returned an ambiguous managed container name");
  const inspected = await docker(config, environment, ["container", "inspect", name], {}, runCommand);
  const parsed = JSON.parse(inspected.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Docker returned invalid container inspection data");
  return parsed[0];
}

export async function ensureTargetNetwork(config, environment, runCommand = command) {
  const listed = await docker(config, environment, [
    "network", "ls", "--filter", `name=^${config.targetNetwork}$`, "--format", "{{.Name}}",
  ], {}, runCommand);
  if (!listed.stdout) {
    await docker(config, environment, [
      "network", "create",
      "--driver", "bridge",
      "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
      "--label", "pigo.release.gateway=1",
      config.targetNetwork,
    ], {}, runCommand);
  } else if (listed.stdout !== config.targetNetwork) {
    throw new Error("Docker returned an ambiguous target network name");
  }
  const inspected = await docker(config, environment, ["network", "inspect", config.targetNetwork], {}, runCommand);
  const decoded = JSON.parse(inspected.stdout);
  const network = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : undefined;
  if (!network
    || network.Name !== config.targetNetwork
    || network.Driver !== "bridge"
    || network.Internal !== false
    || network.Attachable !== false
    || network.Ingress !== false
    || network.Labels?.["pigo.release.gateway"] !== "1"
    || network.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") {
    throw new Error("target network does not match the fixed release policy");
  }
}

const FIXED_SMOKE_SCRIPT = String.raw`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let healthy = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:8080/healthz", { signal: AbortSignal.timeout(3000) });
    const body = response.ok ? await response.json() : {};
    if (body?.status === "ok" && body?.service === "order-status-app") { healthy = true; break; }
  } catch {}
  await sleep(1000);
}
if (!healthy) throw new Error("fixed health smoke check failed");
const cases = [
  [{ orderId: "PIGO-SMOKE-READY", paid: true, stock: true }, "READY_TO_SHIP"],
  [{ orderId: "PIGO-SMOKE-PAYMENT", paid: false, stock: true }, "WAITING_PAYMENT"],
  [{ orderId: "PIGO-SMOKE-STOCK", paid: true, stock: false }, "WAITING_STOCK"],
];
for (const [input, expected] of cases) {
  const response = await fetch("http://127.0.0.1:8080/api/orders/evaluate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(3000),
  });
  const body = response.ok ? await response.json() : {};
  if (!response.ok || body?.status !== expected) throw new Error("fixed functional smoke check failed");
}
`;

export async function deployManagedContainer(config, payload, artifact, runtime) {
  const name = `pigo-release-order-status-${payload.environment}`;
  const backup = `${name}-previous`;
  const hostPort = payload.environment === "staging" ? config.stagingPort : config.productionPort;
  const policy = {
    name, image: artifact.image, environment: payload.environment, commit: payload.commit,
    network: config.targetNetwork, hostPort, containerPort: 8080,
  };
  await ensureTargetNetwork(config, payload.environment, runtime.runCommand);
  const existingBackup = await findContainer(config, payload.environment, backup, runtime.runCommand);
  if (existingBackup) {
    const backupPolicy = { ...policy, name: backup, image: existingBackup.Config?.Image,
      commit: existingBackup.Config?.Labels?.["org.opencontainers.image.revision"] };
    if (!validateManagedReleaseContainer(existingBackup, backupPolicy)) throw new Error("unmanaged backup container blocks deployment");
    await docker(config, payload.environment, ["container", "rm", "--force", "--volumes", backup], {}, runtime.runCommand);
  }
  const existing = await findContainer(config, payload.environment, name, runtime.runCommand);
  if (existing) {
    const existingPolicy = { ...policy, image: existing.Config?.Image,
      commit: existing.Config?.Labels?.["org.opencontainers.image.revision"] };
    if (!validateManagedReleaseContainer(existing, existingPolicy)) throw new Error("unmanaged container blocks deployment");
    await docker(config, payload.environment, ["container", "stop", "--time", "10", name], {}, runtime.runCommand);
    await docker(config, payload.environment, ["container", "rename", name, backup], {}, runtime.runCommand);
  }
  try {
    await docker(config, payload.environment, [
      "container", "create",
      "--name", name,
      "--label", "pigo.release.gateway=1",
      "--label", `pigo.release.environment=${payload.environment}`,
      "--label", `org.opencontainers.image.revision=${payload.commit}`,
      "--user", "1000:1000",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128",
      "--memory", "268435456",
      "--cpus", "1.0",
      "--restart", "unless-stopped",
      "--network", config.targetNetwork,
      "--publish", `127.0.0.1:${hostPort}:8080`,
      "--env", "PORT=8080",
      artifact.image,
    ], {}, runtime.runCommand);
    const created = await findContainer(config, payload.environment, name, runtime.runCommand);
    if (!validateManagedReleaseContainer(created, policy)) throw new Error("Docker did not apply the fixed release container policy");
    await docker(config, payload.environment, ["container", "start", name], {}, runtime.runCommand);
    await docker(config, payload.environment, [
      "container", "exec", name, "node", "--input-type=module", "--eval", FIXED_SMOKE_SCRIPT,
    ], { timeout: 60_000 }, runtime.runCommand);
    if (existing) await docker(config, payload.environment, ["container", "rm", "--force", "--volumes", backup], {}, runtime.runCommand);
  } catch (error) {
    await docker(config, payload.environment, ["container", "rm", "--force", "--volumes", name], {}, runtime.runCommand).catch(() => undefined);
    if (existing) {
      await docker(config, payload.environment, ["container", "rename", backup, name], {}, runtime.runCommand).catch(() => undefined);
      await docker(config, payload.environment, ["container", "start", name], {}, runtime.runCommand).catch(() => undefined);
    }
    throw error;
  }
}

async function verifyStagingPromotion(config, payload, runCommand) {
  if (payload.event !== "deploy" || payload.environment !== "production") return;
  const name = "pigo-release-order-status-staging";
  const staging = await findContainer(config, "staging", name, runCommand);
  const policy = {
    name,
    image: `${config.imageRepository}:${payload.commit}`,
    environment: "staging",
    commit: payload.commit,
    network: config.targetNetwork,
    hostPort: config.stagingPort,
    containerPort: 8080,
  };
  if (!validateManagedReleaseContainer(staging, policy) || staging.Image !== payload.expectedImageDigest) {
    throw new Error("production requires the same gateway-managed image to be active in staging");
  }
}

export async function executeRelease(config, request, dependencies = {}) {
  const payload = validateReleaseRequest(request);
  const target = await resolveApplicationTarget(config, payload, { requireHead: payload.event !== "rollback" });
  const runtime = {
    runCommand: dependencies.runCommand ?? command,
  };
  await verifyStagingPromotion(config, payload, runtime.runCommand);
  const artifact = await ensureImage(config, payload, target, runtime.runCommand);
  await deployManagedContainer(config, payload, artifact, runtime);
  return {
    status: "succeeded",
    event: payload.event,
    environment: payload.environment,
    repository: target.repository,
    commit: payload.commit,
    image: artifact.image,
    imageDigest: artifact.imageDigest,
  };
}

export function createReleaseGateway(config, execute = executeRelease) {
  let queue = Promise.resolve();
  return http.createServer(async (request, reply) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return json(reply, 200, { status: "ok", service: SERVICE, version: VERSION });
      }
      if (request.method !== "POST" || request.url !== "/v1/deploy") return json(reply, 404, { error: "Not found" });
      if (!authorizeReleaseGateway(request.headers, config.token)) return json(reply, 401, { error: "Unauthorized" });
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(reply, 415, { error: "Content-Type must be application/json" });
      }
      const raw = await readBody(request);
      let decoded;
      try { decoded = JSON.parse(raw.toString("utf8")); } catch { return json(reply, 400, { error: "Invalid JSON" }); }
      let payload;
      try { payload = validateReleaseRequest(decoded); } catch (error) { return json(reply, 400, { error: error.message }); }
      const operation = queue.then(() => execute(config, payload));
      queue = operation.catch(() => undefined);
      return json(reply, 200, await operation);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      console.error(JSON.stringify({ level: "error", event: "release_gateway.failed", message: error.message }));
      return json(reply, status, { error: status >= 500 ? "Release gateway failed" : String(error.message).slice(0, 500) });
    }
  });
}

async function main() {
  const config = loadReleaseGatewayConfig();
  await assertRequiredDockerSecurity(config);
  const server = createReleaseGateway(config);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: "info",
      event: "release_gateway.started",
      port: config.port,
      version: VERSION,
      rootlessRequired: config.requireRootless,
    }));
  });
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main().catch((error) => { console.error(error.message); process.exit(1); });
