import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  authorizeReleaseGateway,
  createReleaseGateway,
  ensureImage,
  loadReleaseGatewayConfig,
  validateManagedReleaseContainer,
  validateReleaseRequest,
} from "./release-gateway.mjs";

const token = "0123456789abcdef0123456789abcdef";
const digest = `sha256:${"d".repeat(64)}`;

test("release gateway authenticates with an independent bearer secret", () => {
  assert.equal(authorizeReleaseGateway({ authorization: `Bearer ${token}` }, token), true);
  assert.equal(authorizeReleaseGateway({ authorization: "Bearer wrong" }, token), false);
  assert.equal(authorizeReleaseGateway({}, token), false);
});

test("release gateway accepts only fixed high-level deployment fields", () => {
  const staging = validateReleaseRequest({
    event: "deploy",
    environment: "staging",
    repository: "/workspace/project-a",
    commit: "a".repeat(40),
  });
  assert.equal(staging.environment, "staging");
  assert.throws(() => validateReleaseRequest({ ...staging, command: "docker run --privileged" }), /not allowed/);
  assert.throws(() => validateReleaseRequest({ ...staging, repository: "../project-a" }), /absolute workspace path/);
  assert.throws(() => validateReleaseRequest({ ...staging, expectedImageDigest: digest }), /staging must not/);
  assert.throws(() => validateReleaseRequest({ ...staging, environment: "production" }), /expectedImageDigest/);
  assert.throws(() => validateReleaseRequest({ ...staging, event: "rollback" }), /production-only/);
  assert.equal(validateReleaseRequest({ ...staging, environment: "production", expectedImageDigest: digest }).expectedImageDigest, digest);
});

test("release gateway configuration fails closed", () => {
  const valid = { PIGO_RELEASE_GATEWAY_TOKEN: token };
  assert.equal(loadReleaseGatewayConfig(valid).port, 3310);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_RELEASE_GATEWAY_TOKEN: "short" }), /between 32 and 4096/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_WORKSPACE_ROOT: "/" }), /non-root/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_APP_PATH: "../outside" }), /safe relative/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_TARGET_NETWORK: "host" }), /invalid/);
});

test("staging always rebuilds the reviewed commit while production only reuses its approved digest", async () => {
  const commit = "a".repeat(40);
  const image = `local/app:${commit}`;
  const config = { imageRepository: "local/app" };
  const target = { appDirectory: "/workspace/project-a/apps/order-status-app" };
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "build") return { stdout: "", stderr: "" };
    if (args.at(-1) === "{{.Id}}") return { stdout: digest, stderr: "" };
    return { stdout: commit, stderr: "" };
  };

  const staging = await ensureImage(config, { environment: "staging", commit }, target, runCommand);
  assert.deepEqual(staging, { image, imageDigest: digest });
  assert.deepEqual(calls[0].args, [
    "build", "--label", `org.opencontainers.image.revision=${commit}`, "--tag", image, ".",
  ]);
  assert.equal(calls[0].options.cwd, target.appDirectory);

  calls.length = 0;
  const production = await ensureImage(config, {
    environment: "production", commit, expectedImageDigest: digest,
  }, target, runCommand);
  assert.deepEqual(production, { image, imageDigest: digest });
  assert.equal(calls.some(({ args }) => args[0] === "build"), false);
});

test("managed release policy rejects host takeover primitives", () => {
  const policy = {
    name: "pigo-release-order-status-staging",
    image: `local/app:${"a".repeat(40)}`,
    environment: "staging",
    commit: "a".repeat(40),
    network: "pigo-release-targets",
    hostPort: 18080,
    containerPort: 8080,
  };
  const container = {
    Name: `/${policy.name}`,
    Config: {
      Image: policy.image,
      User: "1000:1000",
      Labels: {
        "pigo.release.gateway": "1",
        "pigo.release.environment": "staging",
        "org.opencontainers.image.revision": policy.commit,
      },
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: "pigo-release-targets",
      PidsLimit: 128,
      Memory: 268435456,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=67108864" },
      PidMode: "",
      IpcMode: "",
      Binds: null,
      Devices: [],
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
    },
    Mounts: [],
  };
  assert.equal(validateManagedReleaseContainer(container, policy), true);
  for (const mutate of [
    (value) => { value.HostConfig.Privileged = true; },
    (value) => { value.HostConfig.NetworkMode = "host"; },
    (value) => { value.HostConfig.PidMode = "host"; },
    (value) => { value.HostConfig.IpcMode = "host"; },
    (value) => { value.HostConfig.Binds = ["/:/host:rw"]; },
    (value) => { value.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }]; },
    (value) => { value.Mounts = [{ Type: "bind", Source: "/", Destination: "/host" }]; },
    (value) => { value.Config.Volumes = { "/data": {} }; },
    (value) => { value.Config.User = "0"; },
    (value) => { value.HostConfig.ReadonlyRootfs = false; },
    (value) => { value.HostConfig.PidsLimit = 1024; },
    (value) => { value.HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"; },
  ]) {
    const malicious = structuredClone(container);
    mutate(malicious);
    assert.equal(validateManagedReleaseContainer(malicious, policy), false);
  }
});

test("release gateway HTTP surface exposes no generic Docker route", async () => {
  let executions = 0;
  const gateway = createReleaseGateway({ token }, async (_config, payload) => {
    executions += 1;
    return { ...payload, status: "succeeded", image: `local/app:${payload.commit}`, imageDigest: digest };
  });
  const request = async ({ url = "/v1/deploy", authorization = `Bearer ${token}`, body = {} } = {}) => new Promise((resolve, reject) => {
    const input = Readable.from([Buffer.from(JSON.stringify(body))]);
    input.method = "POST";
    input.url = url;
    input.headers = { "content-type": "application/json", authorization };
    const output = {
      status: 0,
      chunks: [],
      writeHead(status) { this.status = status; },
      end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); resolve({ status: this.status, body: Buffer.concat(this.chunks).toString("utf8") }); },
    };
    input.once("error", reject);
    gateway.emit("request", input, output);
  });
  const payload = { event: "deploy", environment: "staging", repository: "/workspace/project-a", commit: "a".repeat(40) };
  assert.equal((await request({ authorization: "Bearer wrong", body: payload })).status, 401);
  assert.equal((await request({ url: "/v1.43/containers/create", body: payload })).status, 404);
  assert.equal((await request({ body: { ...payload, privileged: true } })).status, 400);
  assert.equal((await request({ body: payload })).status, 200);
  assert.equal(executions, 1);
});

test("compose keeps Docker socket only on the internal release gateway", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const compose = await readFile(path.join(directory, "compose.yaml"), "utf8");
  const gatewayStart = compose.indexOf("\n  release-gateway:\n");
  const executor = compose.slice(compose.indexOf("  executor:"), gatewayStart);
  const gateway = compose.slice(gatewayStart, compose.indexOf("\nvolumes:"));
  assert.doesNotMatch(executor, /docker\.sock|DOCKER_GID|group_add/);
  assert.match(executor, /release-control/);
  assert.match(gateway, /\/var\/run\/docker\.sock/);
  assert.match(gateway, /release-control/);
  assert.doesNotMatch(gateway, /^\s+- release-targets$/mu);
  assert.doesNotMatch(gateway, /ports:/);
});

test("automated release gateway never executes repository ops scripts or Compose", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.join(directory, "release-gateway.mjs"), "utf8");
  assert.doesNotMatch(source, /target\.(?:deployScript|smokeScript)/);
  assert.doesNotMatch(source, /["']compose["']/);
  assert.match(source, /"container", "create"/);
  assert.match(source, /"--cap-drop", "ALL"/);
  assert.match(source, /"--security-opt", "no-new-privileges:true"/);
  assert.match(source, /"--read-only"/);
});
