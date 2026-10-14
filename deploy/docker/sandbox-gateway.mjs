#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BODY_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const NAME = /^pigo-task-[a-z0-9-]{8,80}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const LABEL_VALUE = /^[A-Za-z0-9._:/ -]{0,100}$/u;
const FORBIDDEN_ENV = /^(?:DOCKER_|PI_INTERNAL_TOKEN$|PIGO_EXECUTOR_TOKEN$)/u;

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function secret(value, name) {
  const text = required(value, name);
  const bytes = Buffer.byteLength(text);
  if (bytes < 32 || bytes > 4096) throw new Error(`${name} must contain between 32 and 4096 bytes`);
  return text;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not allowed`);
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function bearer(headers, token) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    && safeEqual(authorization.slice(7), token);
}

export function authorizeGateway(headers, token) {
  return bearer(headers, token);
}

export function classifyGatewayRequest(method, requestUrl, apiVersion) {
  const url = new URL(requestUrl ?? "/", "http://gateway.invalid");
  const prefix = `/${apiVersion}`;
  if (method === "GET" && url.pathname === "/healthz") return { kind: "health", url };
  if (!url.pathname.startsWith(`${prefix}/`)) return { kind: "not_found", url };
  if (method === "GET" && url.pathname === `${prefix}/_ping`) return { kind: "ping", url };
  const escaped = prefix.replace(".", "\\.");
  const image = url.pathname.match(new RegExp(`^${escaped}/images/(.+)/json$`, "u"));
  if (method === "GET" && image) return { kind: "image", url, image: decodeURIComponent(image[1]) };
  if (method === "POST" && url.pathname === `${prefix}/containers/create`) return { kind: "create", url };
  const container = url.pathname.match(new RegExp(`^${escaped}/containers/([a-f0-9]{64})(?:/(start|wait|kill|logs))?$`, "u"));
  if (container) return { kind: "container", url, id: container[1], action: container[2] };
  return { kind: "not_found", url };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvedInside(root, candidate) {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  return inside(realRoot, realCandidate);
}

function parseBind(value) {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\0")) throw new Error("bind must be a string");
  const parts = value.split(":");
  if (parts.length !== 3) throw new Error("bind must use source:destination:mode");
  const [source, destination, mode] = parts;
  if (!path.isAbsolute(source) || !path.posix.isAbsolute(destination) || !["ro", "rw"].includes(mode)) {
    throw new Error("bind source/destination/mode is invalid");
  }
  return { source: path.resolve(source), destination: path.posix.normalize(destination), mode };
}

function validTmpfs(tmpfs) {
  const expected = new Map([
    ["/tmp", "size=512m,mode=1777"],
    ["/run", "size=16m,mode=755"],
    ["/home/node/.cache", "size=64m,mode=700,uid=1000,gid=1000"],
  ]);
  if (!tmpfs || typeof tmpfs !== "object" || Array.isArray(tmpfs) || Object.keys(tmpfs).length !== expected.size) return false;
  return [...expected].every(([key, value]) => tmpfs[key] === value);
}

export async function validateSandboxSpec(spec, policy) {
  const value = object(spec, "container spec");
  exactKeys(value, new Set(["Image", "Cmd", "Env", "WorkingDir", "User", "HostConfig", "Labels"]), "container spec");
  if (value.Image !== policy.image) throw new Error("sandbox image is not the configured immutable image");
  if (!Array.isArray(value.Cmd) || value.Cmd.length === 0 || value.Cmd.length > 128
    || value.Cmd.some((item) => typeof item !== "string" || item.length > 32_768)) throw new Error("sandbox command is invalid");
  if (value.User !== "node" && value.User !== "1000" && value.User !== "1000:1000") throw new Error("sandbox user must be non-root node");
  if (typeof value.WorkingDir !== "string" || !inside("/workspace/runs", path.posix.normalize(value.WorkingDir))) {
    throw new Error("sandbox working directory must be below /workspace/runs");
  }
  if (!Array.isArray(value.Env) || value.Env.length > 128) throw new Error("sandbox environment is invalid");
  for (const entry of value.Env) {
    if (typeof entry !== "string" || entry.length > 32_768 || !entry.includes("=")) throw new Error("sandbox environment entry is invalid");
    const name = entry.slice(0, entry.indexOf("="));
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name)) throw new Error(`sandbox environment variable ${name || "<empty>"} is forbidden`);
  }

  const host = object(value.HostConfig, "HostConfig");
  exactKeys(host, new Set([
    "Binds", "NetworkMode", "AutoRemove", "ReadonlyRootfs", "Tmpfs", "CapDrop", "SecurityOpt", "PidsLimit", "Memory", "NanoCpus",
  ]), "HostConfig");
  if (host.AutoRemove !== false || host.ReadonlyRootfs !== true) throw new Error("sandbox lifecycle/root filesystem policy is invalid");
  if (!Array.isArray(host.CapDrop) || host.CapDrop.length !== 1 || host.CapDrop[0] !== "ALL") throw new Error("sandbox must drop all capabilities");
  if (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 || host.SecurityOpt[0] !== "no-new-privileges:true") {
    throw new Error("sandbox must enable no-new-privileges");
  }
  if (host.NetworkMode !== "none" && host.NetworkMode !== policy.network) throw new Error("sandbox network mode is not allowed");
  integer(host.PidsLimit, "HostConfig.PidsLimit", 1, policy.maxPids);
  integer(host.Memory, "HostConfig.Memory", 64 * 1024 * 1024, policy.maxMemory);
  integer(host.NanoCpus, "HostConfig.NanoCpus", 1, policy.maxNanoCpus);
  if (!validTmpfs(host.Tmpfs)) throw new Error("sandbox tmpfs policy is invalid");
  if (!Array.isArray(host.Binds) || host.Binds.length < 2 || host.Binds.length > 16) throw new Error("sandbox bind list is invalid");

  let hasWorktree = false;
  let hasModels = false;
  for (const raw of host.Binds) {
    const bind = parseBind(raw);
    if (inside("/workspace/runs", bind.destination)) {
      if (!await resolvedInside(policy.hostRunsRoot, bind.source)) throw new Error("sandbox run bind escapes the host runs root");
      if (bind.destination === value.WorkingDir) hasWorktree = true;
      continue;
    }
    if (inside("/workspace/projects", bind.destination) && bind.destination.endsWith("/.git")) {
      if (bind.mode !== "rw" || !await resolvedInside(policy.hostProjectsRoot, bind.source) || !bind.source.endsWith("/.git")) {
        throw new Error("sandbox repository metadata bind is invalid");
      }
      continue;
    }
    if (bind.destination === "/home/node/.pi") {
      if (bind.mode !== "rw" || !await resolvedInside(policy.hostRunsRoot, bind.source)) {
        throw new Error("sandbox state bind is invalid");
      }
      continue;
    }
    if (bind.destination === "/home/node/.pi/agent/models.json") {
      if (bind.mode !== "ro" || path.resolve(bind.source) !== policy.modelsFile || !await resolvedInside(path.dirname(policy.modelsFile), bind.source)) {
        throw new Error("sandbox model definition bind is invalid");
      }
      hasModels = true;
      continue;
    }
    if (inside("/opt/pigo/plugins", bind.destination)) {
      if (bind.mode !== "ro" || !(await Promise.all(policy.pluginRoots.map((root) => resolvedInside(root, bind.source).catch(() => false)))).some(Boolean)) {
        throw new Error("sandbox plugin bind is outside the read-only plugin roots");
      }
      continue;
    }
    throw new Error("sandbox bind destination is not allowed");
  }
  if (!hasWorktree || !hasModels) throw new Error("sandbox requires its own worktree and the read-only model definition");

  const labels = object(value.Labels, "Labels");
  exactKeys(labels, new Set(["pigo.sandbox", "pigo.label"]), "Labels");
  if (labels["pigo.sandbox"] !== "1" || !LABEL_VALUE.test(String(labels["pigo.label"] ?? ""))) throw new Error("sandbox labels are invalid");
  return value;
}

function json(reply, status, value) {
  const body = JSON.stringify(value);
  reply.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  reply.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function dockerBuffer(config, method, pathName, body) {
  return new Promise((resolve, reject) => {
    const headers = body ? { "Content-Type": "application/json", "Content-Length": body.length } : {};
    const request = http.request({ socketPath: config.socketPath, path: pathName, method, headers, timeout: 30_000 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) response.destroy(new Error("Docker response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 500, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Docker request timed out")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function dockerJson(config, method, pathName, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const result = await dockerBuffer(config, method, pathName, payload);
  let decoded = {};
  try { if (result.body.length) decoded = JSON.parse(result.body.toString("utf8")); } catch { throw new Error("Docker returned invalid JSON"); }
  if (result.status >= 400) throw Object.assign(new Error(`Docker request failed with HTTP ${result.status}`), { statusCode: 502 });
  return decoded;
}

export function isManagedSandboxInspection(value, policy) {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.Name === "string"
    && NAME.test(value.Name.replace(/^\//u, ""))
    && value.Config?.Image === policy.image
    && ["node", "1000", "1000:1000"].includes(value.Config?.User)
    && value.Config?.Labels?.["pigo.sandbox"] === "1"
    && value.HostConfig?.Privileged === false
    && value.HostConfig?.ReadonlyRootfs === true
    && Array.isArray(value.HostConfig?.CapDrop)
    && value.HostConfig.CapDrop.length === 1
    && value.HostConfig.CapDrop[0] === "ALL"
    && Array.isArray(value.HostConfig?.SecurityOpt)
    && value.HostConfig.SecurityOpt.includes("no-new-privileges:true")
    && ["none", policy.network].includes(value.HostConfig?.NetworkMode)
    && !value.HostConfig?.PidMode
    && !value.HostConfig?.IpcMode
    && !value.HostConfig?.Devices?.length
  );
}

async function recoverManagedSandbox(config, id) {
  try {
    const inspected = await dockerJson(config, "GET", `/${config.apiVersion}/containers/${id}/json`);
    return isManagedSandboxInspection(inspected, config.policy);
  } catch {
    return false;
  }
}

function proxyDocker(config, request, reply, dockerPath) {
  const upstream = http.request({ socketPath: config.socketPath, path: dockerPath, method: request.method, timeout: config.waitTimeoutMs }, (response) => {
    reply.writeHead(response.statusCode ?? 502, { "Content-Type": response.headers["content-type"] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.pipe(reply);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Docker request timed out")));
  upstream.on("error", () => { if (!reply.headersSent) json(reply, 502, { error: "Docker gateway upstream failed" }); else reply.destroy(); });
  request.on("aborted", () => upstream.destroy());
  upstream.end();
}

export function loadGatewayConfig(env = process.env) {
  const workspaceInput = required(env.PI_HOST_WORKSPACE_ROOT, "PI_HOST_WORKSPACE_ROOT");
  const modelsInput = required(env.PI_SANDBOX_MODELS_FILE, "PI_SANDBOX_MODELS_FILE");
  if (!path.isAbsolute(workspaceInput) || path.resolve(workspaceInput) === path.parse(workspaceInput).root) {
    throw new Error("PI_HOST_WORKSPACE_ROOT must be an absolute, non-root path");
  }
  if (!path.isAbsolute(modelsInput)) throw new Error("PI_SANDBOX_MODELS_FILE must be absolute");
  const workspace = path.resolve(workspaceInput);
  const network = required(env.PI_SANDBOX_NETWORK, "PI_SANDBOX_NETWORK");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(network) || ["host", "default"].includes(network)) {
    throw new Error("PI_SANDBOX_NETWORK must name a non-host Docker network");
  }
  const pluginRoots = String(env.PI_SANDBOX_PLUGIN_ROOTS || "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!path.isAbsolute(item) || path.resolve(item) === path.parse(item).root) {
      throw new Error("PI_SANDBOX_PLUGIN_ROOTS entries must be absolute, non-root paths");
    }
    return path.resolve(item);
  });
  const config = {
    host: env.HOST || "0.0.0.0",
    port: Number(env.PORT || 3210),
    token: secret(env.PI_DOCKER_GATEWAY_TOKEN, "PI_DOCKER_GATEWAY_TOKEN"),
    socketPath: env.PI_DOCKER_SOCKET || "/var/run/docker.sock",
    apiVersion: env.PI_DOCKER_API_VERSION || "v1.43",
    waitTimeoutMs: Number(env.PI_SANDBOX_GATEWAY_WAIT_TIMEOUT_MS || 2 * 60 * 60_000),
    policy: {
      image: required(env.PI_SANDBOX_IMAGE, "PI_SANDBOX_IMAGE"),
      network,
      hostRunsRoot: path.join(workspace, "runs"),
      hostProjectsRoot: path.join(workspace, "projects"),
      modelsFile: path.resolve(modelsInput),
      pluginRoots,
      maxPids: Number(env.PI_SANDBOX_MAX_PIDS || 256),
      maxMemory: Number(env.PI_SANDBOX_MAX_MEMORY_BYTES || 2 * 1024 * 1024 * 1024),
      maxNanoCpus: Number(env.PI_SANDBOX_MAX_NANO_CPUS || 1_500_000_000),
    },
  };
  integer(config.port, "PORT", 1, 65_535);
  integer(config.waitTimeoutMs, "PI_SANDBOX_GATEWAY_WAIT_TIMEOUT_MS", 60_000, 24 * 60 * 60_000);
  integer(config.policy.maxPids, "PI_SANDBOX_MAX_PIDS", 1, 4096);
  integer(config.policy.maxMemory, "PI_SANDBOX_MAX_MEMORY_BYTES", 64 * 1024 * 1024, 64 * 1024 * 1024 * 1024);
  integer(config.policy.maxNanoCpus, "PI_SANDBOX_MAX_NANO_CPUS", 1, 64_000_000_000);
  if (!/^v[0-9]+\.[0-9]+$/u.test(config.apiVersion)) throw new Error("PI_DOCKER_API_VERSION is invalid");
  return config;
}

export function createGateway(config) {
  const managed = new Set();
  const prefix = `/${config.apiVersion}`;
  return http.createServer(async (request, reply) => {
    try {
      const route = classifyGatewayRequest(request.method, request.url, config.apiVersion);
      if (route.kind === "health") return json(reply, 200, { status: "ok", service: "pigo-sandbox-gateway" });
      if (!authorizeGateway(request.headers, config.token)) return json(reply, 401, { error: "Unauthorized" });
      if (route.kind === "not_found") return json(reply, 404, { error: "Not found" });
      const { url } = route;

      if (route.kind === "ping") {
        const result = await dockerBuffer(config, "GET", `${prefix}/_ping`);
        if (result.status >= 400) return json(reply, 502, { error: "Docker ping failed" });
        reply.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        return reply.end("OK");
      }

      if (route.kind === "image") {
        const image = route.image;
        if (image !== config.policy.image) return json(reply, 403, { error: "Image is outside the sandbox allowlist" });
        const inspected = await dockerJson(config, "GET", `${prefix}/images/${encodeURIComponent(image)}/json`);
        return json(reply, 200, { Id: inspected.Id });
      }

      if (route.kind === "create") {
        const name = url.searchParams.get("name") ?? "";
        if (!NAME.test(name)) return json(reply, 400, { error: "Container name is invalid" });
        const raw = await readBody(request);
        let spec;
        try { spec = JSON.parse(raw.toString("utf8")); } catch { return json(reply, 400, { error: "Invalid JSON" }); }
        await validateSandboxSpec(spec, config.policy);
        const created = await dockerJson(config, "POST", `${prefix}/containers/create?name=${encodeURIComponent(name)}`, spec);
        if (!CONTAINER_ID.test(created.Id ?? "")) throw new Error("Docker returned an invalid container id");
        managed.add(created.Id);
        return json(reply, 201, { Id: created.Id });
      }

      if (route.kind !== "container") return json(reply, 404, { error: "Managed sandbox container not found" });
      if (!managed.has(route.id)) {
        if (!await recoverManagedSandbox(config, route.id)) return json(reply, 404, { error: "Managed sandbox container not found" });
        managed.add(route.id);
      }
      const { id, action } = route;
      if (request.method === "POST" && action === "start") {
        await dockerJson(config, "POST", `${prefix}/containers/${id}/start`);
        reply.writeHead(204, { "Cache-Control": "no-store" }); return reply.end();
      }
      if (request.method === "POST" && action === "wait") return proxyDocker(config, request, reply, `${prefix}/containers/${id}/wait`);
      if (request.method === "POST" && action === "kill") {
        const signal = url.searchParams.get("signal");
        if (signal !== "SIGTERM" && signal !== "SIGKILL") return json(reply, 400, { error: "Signal is not allowed" });
        await dockerJson(config, "POST", `${prefix}/containers/${id}/kill?signal=${signal}`);
        reply.writeHead(204, { "Cache-Control": "no-store" }); return reply.end();
      }
      if (request.method === "GET" && action === "logs") {
        if (url.search !== "?follow=1&stdout=1&stderr=1") return json(reply, 400, { error: "Log options are not allowed" });
        return proxyDocker(config, request, reply, `${prefix}/containers/${id}/logs${url.search}`);
      }
      if (request.method === "DELETE" && !action) {
        if (url.search !== "?force=true&v=true") return json(reply, 400, { error: "Remove options are not allowed" });
        await dockerJson(config, "DELETE", `${prefix}/containers/${id}?force=true&v=true`);
        managed.delete(id);
        reply.writeHead(204, { "Cache-Control": "no-store" }); return reply.end();
      }
      return json(reply, 405, { error: "Operation is not allowed" });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      return json(reply, status, { error: status >= 500 ? "Sandbox gateway failed" : error.message });
    }
  });
}

async function main() {
  const config = loadGatewayConfig();
  const server = createGateway(config);
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ level: "info", event: "sandbox_gateway.started", port: config.port })));
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main().catch((error) => { console.error(error.message); process.exit(1); });
