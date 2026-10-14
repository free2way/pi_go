import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  authorizeGateway,
  classifyGatewayRequest,
  isManagedSandboxInspection,
  loadGatewayConfig,
  validateSandboxSpec,
} from "../deploy/docker/sandbox-gateway.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-gateway-"));
  const workspace = path.join(root, "workspace");
  const worktree = path.join(workspace, "runs", "owner", "run-1");
  const state = path.join(workspace, "runs", "owner", "run-1.state");
  const git = path.join(workspace, "projects", "order-check", ".git");
  const models = path.join(root, "pi-models.json");
  await Promise.all([
    mkdir(worktree, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(git, { recursive: true }),
    writeFile(models, "{}\n"),
  ]);
  const policy = {
    image: "registry.example/pigo-sandbox@sha256:" + "a".repeat(64),
    network: "pi-agent-network",
    hostRunsRoot: path.join(workspace, "runs"),
    hostProjectsRoot: path.join(workspace, "projects"),
    modelsFile: models,
    pluginRoots: [],
    maxPids: 256,
    maxMemory: 2 * 1024 * 1024 * 1024,
    maxNanoCpus: 1_500_000_000,
  };
  const spec = {
    Image: policy.image,
    Cmd: ["pi", "--mode", "json"],
    Env: ["OPENAI_API_KEY=secret"],
    WorkingDir: "/workspace/runs/owner/run-1",
    User: "node",
    HostConfig: {
      Binds: [
        `${worktree}:/workspace/runs/owner/run-1:rw`,
        `${git}:/workspace/projects/order-check/.git:rw`,
        `${models}:/home/node/.pi/agent/models.json:ro`,
        `${state}:/home/node/.pi:rw`,
      ],
      NetworkMode: policy.network,
      AutoRemove: false,
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "size=512m,mode=1777",
        "/run": "size=16m,mode=755",
        "/home/node/.cache": "size=64m,mode=700,uid=1000,gid=1000",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 256,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
    },
    Labels: { "pigo.sandbox": "1", "pigo.label": "developer" },
  };
  return { root, policy, spec };
}

test("policy accepts only the bounded sandbox shape used by worker", async (t) => {
  const { root, policy, spec } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await validateSandboxSpec(spec, policy), spec);
});

test("policy rejects host takeover primitives before Docker is called", async (t) => {
  const { root, policy, spec } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const mutate of [
    (value) => { value.HostConfig.Privileged = true; },
    (value) => { value.HostConfig.Binds.push("/:/host:rw"); },
    (value) => { value.HostConfig.NetworkMode = "host"; },
    (value) => { value.HostConfig.CapDrop = []; },
    (value) => { value.User = "root"; },
    (value) => { value.Env.push("DOCKER_HOST=unix:///var/run/docker.sock"); },
  ]) {
    const attack = structuredClone(spec);
    mutate(attack);
    await assert.rejects(validateSandboxSpec(attack, policy));
  }
});

test("config fails closed for missing secrets and invalid numeric limits", () => {
  const base = {
    PI_HOST_WORKSPACE_ROOT: "/tmp/workspace",
    PI_SANDBOX_IMAGE: "sandbox@sha256:" + "a".repeat(64),
    PI_SANDBOX_NETWORK: "pi-agent-network",
    PI_SANDBOX_MODELS_FILE: "/tmp/pi-models.json",
  };
  assert.throws(() => loadGatewayConfig(base), /PI_DOCKER_GATEWAY_TOKEN is required/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: "short" }), /between 32 and 4096 bytes/);
  const token = "x".repeat(32);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PORT: "0" }), /PORT/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PI_SANDBOX_MAX_PIDS: "NaN" }), /PI_SANDBOX_MAX_PIDS/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PI_SANDBOX_GATEWAY_WAIT_TIMEOUT_MS: "100" }), /WAIT_TIMEOUT/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PI_SANDBOX_NETWORK: "host" }), /non-host/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PI_HOST_WORKSPACE_ROOT: "/" }), /non-root/);
  assert.throws(() => loadGatewayConfig({ ...base, PI_DOCKER_GATEWAY_TOKEN: token, PI_SANDBOX_PLUGIN_ROOTS: "/" }), /non-root/);
});

test("gateway authentication is exact and fail-closed", () => {
  assert.equal(authorizeGateway({}, "gateway-secret"), false);
  assert.equal(authorizeGateway({ authorization: "Basic gateway-secret" }, "gateway-secret"), false);
  assert.equal(authorizeGateway({ authorization: "Bearer wrong" }, "gateway-secret"), false);
  assert.equal(authorizeGateway({ authorization: "Bearer gateway-secret" }, "gateway-secret"), true);
});

test("gateway route allowlist does not classify generic Docker API operations", () => {
  const id = "a".repeat(64);
  for (const [method, url, kind] of [
    ["GET", "/healthz", "health"],
    ["GET", "/v1.43/_ping", "ping"],
    ["GET", "/v1.43/images/sandbox%40sha256%3Aabc/json", "image"],
    ["POST", "/v1.43/containers/create?name=pigo-task-12345678", "create"],
    ["POST", `/v1.43/containers/${id}/start`, "container"],
  ]) {
    assert.equal(classifyGatewayRequest(method, url, "v1.43").kind, kind);
  }
  for (const [method, url] of [
    ["GET", "/v1.43/containers/json"],
    ["GET", "/v1.43/info"],
    ["POST", "/v1.43/images/create"],
    ["POST", "/v1.43/networks/create"],
    ["POST", "/v1.43/volumes/create"],
    ["DELETE", "/v1.43/images/sha256:abc"],
  ]) {
    assert.equal(classifyGatewayRequest(method, url, "v1.43").kind, "not_found", `${method} ${url}`);
  }
});

test("restart recovery accepts only a constrained PiGO sandbox inspection", async (t) => {
  const { root, policy } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const inspection = {
    Name: "/pigo-task-12345678",
    Config: { Image: policy.image, User: "node", Labels: { "pigo.sandbox": "1" } },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: policy.network,
      PidMode: "",
      IpcMode: "",
      Devices: [],
    },
  };
  assert.equal(isManagedSandboxInspection(inspection, policy), true);
  for (const mutate of [
    (value) => { value.Name = "/database"; },
    (value) => { value.Config.Image = "other"; },
    (value) => { value.Config.User = "root"; },
    (value) => { value.Config.Labels = {}; },
    (value) => { value.HostConfig.Privileged = true; },
    (value) => { value.HostConfig.ReadonlyRootfs = false; },
    (value) => { value.HostConfig.NetworkMode = "host"; },
    (value) => { value.HostConfig.PidMode = "host"; },
    (value) => { value.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]; },
  ]) {
    const attack = structuredClone(inspection);
    mutate(attack);
    assert.equal(isManagedSandboxInspection(attack, policy), false);
  }
});
