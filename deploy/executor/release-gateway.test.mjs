import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertRequiredDockerSecurity,
  authorizeReleaseGateway,
  createReleaseGateway,
  deployManagedContainer,
  ensureImage,
  ensureTargetNetwork,
  isRootlessDockerSecurityOptions,
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
  assert.equal(loadReleaseGatewayConfig(valid).requireRootless, true);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_RELEASE_GATEWAY_TOKEN: "short" }), /between 32 and 4096/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_WORKSPACE_ROOT: "/" }), /non-root/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_APP_PATH: "../outside" }), /safe relative/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_EXECUTOR_TARGET_NETWORK: "host" }), /invalid/);
  assert.throws(() => loadReleaseGatewayConfig({ ...valid, PIGO_RELEASE_REQUIRE_ROOTLESS: "true" }), /literal 0 or 1/);
  assert.equal(loadReleaseGatewayConfig({ ...valid, PIGO_RELEASE_REQUIRE_ROOTLESS: "1" }).requireRootless, true);
  assert.equal(loadReleaseGatewayConfig({ ...valid, PIGO_RELEASE_REQUIRE_ROOTLESS: "0" }).requireRootless, false);
});

test("release gateway verifies a required rootless execution daemon before listening", async () => {
  assert.equal(isRootlessDockerSecurityOptions(["name=seccomp,profile=builtin", "name=rootless"]), true);
  assert.equal(isRootlessDockerSecurityOptions(["name=seccomp,profile=builtin"]), false);
  const config = { requireRootless: true };
  await assertRequiredDockerSecurity(config, async (_command, args) => {
    assert.deepEqual(args, ["info", "--format", "{{json .SecurityOptions}}"]);
    return { stdout: JSON.stringify(["name=rootless"]), stderr: "" };
  });
  await assert.rejects(
    () => assertRequiredDockerSecurity(config, async () => ({ stdout: JSON.stringify(["name=seccomp"]), stderr: "" })),
    /configured Docker engine is not rootless/,
  );
  await assert.rejects(
    () => assertRequiredDockerSecurity(config, async () => ({ stdout: "not-json", stderr: "" })),
    /invalid security options/,
  );
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

test("release gateway creates and verifies a dedicated loopback-bound target bridge", async () => {
  const calls = [];
  const config = { targetNetwork: "pigo-release-targets" };
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "ls") return { stdout: "", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: JSON.stringify([{
        Name: config.targetNetwork,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        Ingress: false,
        Labels: { "pigo.release.gateway": "1" },
        Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
      }]), stderr: "" };
    }
    return { stdout: config.targetNetwork, stderr: "" };
  };
  await ensureTargetNetwork(config, "staging", runCommand);
  assert.deepEqual(calls[1], [
    "network", "create",
    "--driver", "bridge",
    "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
    "--label", "pigo.release.gateway=1",
    config.targetNetwork,
  ]);

  const incompatible = async (_command, args) => args[1] === "ls"
    ? { stdout: config.targetNetwork, stderr: "" }
    : { stdout: JSON.stringify([{
      Name: config.targetNetwork,
      Driver: "bridge",
      Internal: true,
      Attachable: false,
      Ingress: false,
      Labels: { "pigo.release.gateway": "1" },
      Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
    }]), stderr: "" };
  await assert.rejects(() => ensureTargetNetwork(config, "staging", incompatible), /fixed release policy/);
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
      IpcMode: "private",
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

test("failed smoke restores the previous managed container", async () => {
  const commit = "a".repeat(40);
  const previousCommit = "b".repeat(40);
  const config = {
    imageRepository: "local/app",
    targetNetwork: "pigo-release-targets",
    stagingPort: 18080,
    productionPort: 18081,
  };
  const payload = { event: "deploy", environment: "staging", commit };
  const artifact = { image: `local/app:${commit}`, imageDigest: digest };
  const container = (name, image, revision) => ({
    Name: `/${name}`,
    Image: digest,
    Config: {
      Image: image,
      User: "1000:1000",
      Labels: {
        "pigo.release.gateway": "1",
        "pigo.release.environment": "staging",
        "org.opencontainers.image.revision": revision,
      },
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: config.targetNetwork,
      PidsLimit: 128,
      Memory: 268435456,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=67108864" },
      PidMode: "",
      IpcMode: "private",
      Binds: null,
      Devices: [],
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
    },
    Mounts: [],
  });
  const name = "pigo-release-order-status-staging";
  const backup = `${name}-previous`;
  let active = container(name, `local/app:${previousCommit}`, previousCommit);
  let saved;
  const calls = [];
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "ls") return { stdout: config.targetNetwork, stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { stdout: JSON.stringify([{
      Name: config.targetNetwork,
      Driver: "bridge",
      Internal: false,
      Attachable: false,
      Ingress: false,
      Labels: { "pigo.release.gateway": "1" },
      Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
    }]), stderr: "" };
    if (args[0] === "container" && args[1] === "ls") {
      const requested = args[4].slice("name=^/".length, -1);
      return { stdout: requested === name ? active ? name : "" : saved ? backup : "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const value = args[2] === name ? active : saved;
      return { stdout: JSON.stringify([value]), stderr: "" };
    }
    if (args[0] === "container" && args[1] === "rename" && args[2] === name) {
      saved = { ...active, Name: `/${backup}` };
      active = undefined;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "rename" && args[2] === backup) {
      active = { ...saved, Name: `/${name}` };
      saved = undefined;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "create") {
      active = container(name, artifact.image, commit);
      return { stdout: "candidate", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "rm" && args.at(-1) === name) {
      active = undefined;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "exec") throw new Error("fixed functional smoke check failed");
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    () => deployManagedContainer(config, payload, artifact, { runCommand }),
    /fixed functional smoke check failed/,
  );
  assert.equal(active.Config.Labels["org.opencontainers.image.revision"], previousCommit);
  assert.equal(saved, undefined);
  assert.equal(calls.some((args) => args[1] === "rename" && args[2] === name && args[3] === backup), true);
  assert.equal(calls.some((args) => args[1] === "rename" && args[2] === backup && args[3] === name), true);
  assert.equal(calls.some((args) => args[1] === "rm" && args.at(-1) === name), true);
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
  assert.match(gateway, /\$\{PIGO_RELEASE_DOCKER_SOCKET:-\/var\/run\/docker\.sock\}:\/var\/run\/docker\.sock/);
  assert.match(gateway, /PIGO_RELEASE_REQUIRE_ROOTLESS: \$\{PIGO_RELEASE_REQUIRE_ROOTLESS:-1\}/);
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

test("outer executor contains no direct Docker command path", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const executor = await readFile(path.join(directory, "server.mjs"), "utf8");
  assert.doesNotMatch(executor, /(?:command|runCommand)\("docker"/);
});

test("outer executor contains no Docker inspection or network mutation path", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const executor = await readFile(path.join(directory, "server.mjs"), "utf8");
  assert.doesNotMatch(executor, /NetworkSettings|docker\.sock|"network", "connect"/);
});

test("outer executor contains no repository deployment script path", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const executor = await readFile(path.join(directory, "server.mjs"), "utf8");
  assert.doesNotMatch(executor, /deployScript|smokeScript|ops\/deploy\.sh|ops\/smoke\.sh/);
});
