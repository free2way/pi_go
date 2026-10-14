import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  JsonStateStore,
  authenticateWebhook,
  callbackTarget,
  createExecutor,
  loadConfig,
  pathWithin,
  postCallback,
  postProgress,
  prepareSmokeUrl,
  runDeploy,
  runReleaseRegistration,
  validatePayload,
} from "./server.mjs";

const token = "0123456789abcdef0123456789abcdef";
const digest = `sha256:${"d".repeat(64)}`;

test("webhook authentication requires both bearer token and raw-body HMAC", () => {
  const rawBody = Buffer.from('{"event":"run.release_requested"}');
  const signature = `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
  assert.equal(authenticateWebhook({ authorization: `Bearer ${token}`, signature, rawBody, token }), true);
  assert.equal(authenticateWebhook({ authorization: "Bearer wrong", signature, rawBody, token }), false);
  assert.equal(authenticateWebhook({ authorization: `Bearer ${token}`, signature: `${signature}0`, rawBody, token }), false);
});

test("run payload accepts safe workspace-relative repositories and requires a full commit", () => {
  const payload = validatePayload({
    event: "run.release_requested",
    environment: "staging",
    deliveryId: "release:run_1:staging",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/runs/run_1/release-result",
    repository: "order_check",
    commit: "a".repeat(40),
  }, "release:run_1:staging");
  assert.equal(payload.commit, "a".repeat(40));
  assert.throws(() => validatePayload({ ...payload, environment: "qa" }, payload.deliveryId), /unsupported environment/);
  assert.throws(() => validatePayload({ ...payload, commit: "abc" }, payload.deliveryId), /full SHA-1/);
  assert.throws(() => validatePayload({ ...payload, repository: "../outside" }, payload.deliveryId), /safe relative workspace path/);
  assert.throws(() => validatePayload({ ...payload, repository: "nested\\outside" }, payload.deliveryId), /safe relative workspace path/);
  assert.throws(() => validatePayload(payload, "different"), /header\/body mismatch/);
});

test("release payload keeps environment-scoped idempotency identity", () => {
  const payload = validatePayload({
    event: "release.published",
    environment: "production",
    deliveryId: "release-publish:rel_1:production",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/agile/releases/rel_1/release-result",
    releaseId: "rel_1",
    version: "v1.0.0",
    commits: ["a".repeat(40)],
    expectedImageDigest: digest,
  }, "release-publish:rel_1:production");
  assert.equal(payload.environment, "production");
  assert.equal(payload.releaseId, "rel_1");
  assert.equal(payload.expectedImageDigest, digest);
  assert.throws(() => validatePayload({ ...payload, expectedImageDigest: undefined }, payload.deliveryId), /requires expectedImageDigest/);
});

test("release registration requires every story commit in one deployed artifact", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-release-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", ["test", "example.invalid"].join("@")]);
  const commit = () => { git(["commit", "--allow-empty", "-m", "fixture"]); return git(["rev-parse", "HEAD"]); };
  const first = commit();
  git(["switch", "-c", "other"]);
  const divergent = commit();
  git(["switch", "main"]);
  // Distinct commit contents prevent identical empty commit IDs in the same second.
  await writeFile(path.join(directory, "source.txt"), "fixture");
  git(["add", "."]);
  const last = commit();
  const deployment = { event: "run.release_requested", environment: "staging", status: "succeeded", commit: last,
    repository: directory, imageDigest: digest, image: "local/test:fixture", finishedAt: "2026-10-13T00:00:00Z" };
  const store = new JsonStateStore(path.join(directory, "state.json"));
  store.value.deliveries = { deployment };
  const payload = { environment: "staging", commits: [first, last], version: "v1" };
  assert.equal((await runReleaseRegistration({ workspaceRoot: directory }, store, payload)).commit, last);
  await assert.rejects(() => runReleaseRegistration({ workspaceRoot: directory }, store, { ...payload, commits: [divergent, last] }), /no successful/);
  store.value.deliveries.deployment.commit = first;
  await assert.rejects(() => runReleaseRegistration({ workspaceRoot: directory }, store, payload), /no successful/);
  store.value.deliveries.deployment = { ...deployment, commit: last, environment: "production" };
  await assert.rejects(() => runReleaseRegistration({ workspaceRoot: directory }, store, { ...payload, environment: "production", expectedImageDigest: `sha256:${"f".repeat(64)}` }), /no successful/);
});

test("rollback payload is production-only and requires a reason plus immutable digest", () => {
  const payload = validatePayload({
    event: "run.rollback_requested",
    environment: "production",
    deliveryId: "rollback:run_1:production",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/runs/run_1/rollback-result",
    repository: "order_check",
    commit: "a".repeat(40),
    expectedImageDigest: digest,
    reason: "incident 42",
  }, "rollback:run_1:production");
  assert.equal(payload.reason, "incident 42");
  assert.equal(payload.expectedImageDigest, digest);
  assert.throws(() => validatePayload({ ...payload, environment: "staging" }, payload.deliveryId), /production-only/);
  assert.throws(() => validatePayload({ ...payload, reason: undefined }, payload.deliveryId), /reason is required/);
  assert.throws(() => validatePayload({ ...payload, expectedImageDigest: undefined }, payload.deliveryId), /requires expectedImageDigest/);
});

test("callback target allowlists origin and internal API path before rewriting", () => {
  assert.equal(
    callbackTarget(
      "https://pigo.example.com/api/internal/runs/run_1/release-result",
      "https://pigo.example.com",
      "http://127.0.0.1:3100",
    ),
    "http://127.0.0.1:3100/api/internal/runs/run_1/release-result",
  );
  assert.throws(() => callbackTarget("https://evil.example/api/internal/x", "https://pigo.example.com", ""), /origin/);
  assert.throws(() => callbackTarget("https://pigo.example.com/api/config/status", "https://pigo.example.com", ""), /path/);
});

test("workspace containment rejects siblings and prefix tricks", () => {
  assert.equal(pathWithin("/workspace", "/workspace/projects/order_check"), true);
  assert.equal(pathWithin("/workspace", "/workspace-evil/project"), false);
  assert.equal(pathWithin("/workspace", "/etc"), false);
});

test("configuration fails closed for missing origin, weak token and invalid ports", () => {
  const valid = {
    PIGO_EXECUTOR_TOKEN: token,
    PIGO_RELEASE_GATEWAY_TOKEN: `${token}-gateway`,
    PIGO_EXECUTOR_CALLBACK_ORIGIN: "https://pigo.example.com",
  };
  assert.equal(loadConfig(valid).port, 3300);
  assert.equal(loadConfig(valid).targetNetwork, "pigo-release-targets");
  assert.equal(loadConfig(valid).releaseGatewayUrl, "http://release-gateway:3310");
  assert.equal(loadConfig(valid).stagingPublicUrl, "");
  assert.equal(loadConfig({ ...valid, PIGO_EXECUTOR_STAGING_PUBLIC_URL: "https://staging.example.com/app" }).stagingPublicUrl, "https://staging.example.com/app");
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_CALLBACK_ORIGIN: "" }), /CALLBACK_ORIGIN is required/);
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_TOKEN: "too-short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...valid, PIGO_RELEASE_GATEWAY_TOKEN: "too-short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...valid, PIGO_RELEASE_GATEWAY_URL: "https://release-gateway.example" }), /HTTP origin/);
  assert.throws(() => loadConfig({ ...valid, PORT: "70000" }), /integer TCP port/);
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_TARGET_NETWORK: "unsafe/network" }), /TARGET_NETWORK is invalid/);
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_STAGING_PUBLIC_URL: "http://host.docker.internal:18080" }), /user's browser/);
});

test("host-gateway smoke URL resolves through the dedicated target network", async () => {
  const calls = [];
  let inspections = 0;
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "ps") return { stdout: "0123456789ab", stderr: "" };
    if (args[0] === "network") return { stdout: "", stderr: "" };
    inspections += 1;
    return {
      stdout: JSON.stringify([{
        NetworkSettings: {
          Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
          Networks: inspections === 1 ? {} : { "pigo-release-targets": { IPAddress: "203.0.113.4" } },
        },
      }]),
      stderr: "",
    };
  };
  const url = await prepareSmokeUrl({
    stagingUrl: "http://host.docker.internal:18080",
    productionUrl: "http://host.docker.internal:18081",
    stagingPort: 18080,
    productionPort: 18081,
    targetNetwork: "pigo-release-targets",
  }, "staging", run);
  assert.equal(url, "http://203.0.113.4:8080");
  assert.deepEqual(calls[2], ["docker", "network", "connect", "pigo-release-targets", "0123456789ab"]);
});

test("non-host smoke URL passes through without Docker network mutation", async () => {
  let called = false;
  const url = await prepareSmokeUrl({
    stagingUrl: "https://staging.example.com",
    productionUrl: "https://example.com",
    stagingPort: 18080,
    productionPort: 18081,
  }, "staging", async () => { called = true; });
  assert.equal(url, "https://staging.example.com");
  assert.equal(called, false);
});

test("run deployment delegates the fixed reviewed target to the isolated release gateway", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-executor-gateway-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "project-a");
  const app = path.join(repository, "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "Dockerfile"), "FROM scratch\n");
  const git = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", ["test", "example.invalid"].join("@")]);
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  let observed;
  const image = `local/app:${commit}`;
  const config = {
    workspaceRoot: root,
    appPath: "app",
    imageRepository: "local/app",
    releaseGatewayUrl: "http://release-gateway:3310",
    releaseGatewayToken: `${token}-gateway`,
    stagingUrl: "http://host.docker.internal:18080",
    productionUrl: "http://host.docker.internal:18081",
    stagingPort: 18080,
    productionPort: 18081,
    stagingPublicUrl: "",
    productionPublicUrl: "",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      const requested = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: "succeeded", event: "deploy", environment: "staging",
          repository: requested.repository, commit, image, imageDigest: digest,
        }),
      };
    },
  };
  const store = new JsonStateStore(path.join(root, "state.json"));
  const result = await runDeploy(config, store, {
    event: "run.release_requested", environment: "staging", repository, commit,
  });
  assert.equal(observed.url, "http://release-gateway:3310/v1/deploy");
  assert.equal(observed.options.headers.Authorization, `Bearer ${token}-gateway`);
  const requested = JSON.parse(observed.options.body);
  assert.equal(requested.event, "deploy");
  assert.equal(requested.environment, "staging");
  assert.equal(requested.commit, commit);
  assert.deepEqual(Object.keys(requested).sort(), ["commit", "environment", "event", "repository"]);
  assert.match(requested.repository, /project-a$/);
  assert.equal(result.imageDigest, digest);
});

test("run deployments emit authenticated, attempt-scoped progress callbacks", async () => {
  let observed;
  const config = {
    token,
    callbackPublicOrigin: "https://pigo.example.com",
    callbackInternalOrigin: "http://web:3100",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return { ok: true, status: 200 };
    },
  };
  const payload = {
    event: "run.release_requested",
    deliveryId: "release:run_1:staging",
    attempt: 3,
    callbackUrl: "https://pigo.example.com/api/internal/runs/run_1/release-result",
  };
  await postProgress(config, payload, "smoke", "functional checks started");
  assert.equal(observed.url, "http://web:3100/api/internal/runs/run_1/release-result");
  assert.equal(observed.options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(observed.options.body), {
    deliveryId: payload.deliveryId,
    attempt: 3,
    status: "progress",
    stage: "smoke",
    detail: "functional checks started",
  });

  observed = undefined;
  await postProgress(config, { ...payload, event: "release.published" }, "smoke", "ignored");
  assert.equal(observed, undefined);
});

test("successful callbacks carry immutable deployment evidence", async () => {
  let body;
  await postCallback({
    token,
    callbackPublicOrigin: "https://pigo.example.com",
    callbackInternalOrigin: "http://web:3100",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200 };
    },
  }, {
    deliveryId: "release:run_1:staging",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/runs/run_1/release-result",
  }, {
    status: "succeeded",
    detail: "staging verified",
    deploymentId: "deploy_1",
    commit: "a".repeat(40),
    image: "local/app:immutable",
    imageDigest: digest,
  });
  assert.deepEqual(body, {
    deliveryId: "release:run_1:staging",
    attempt: 1,
    status: "succeeded",
    detail: "staging verified",
    deploymentId: "deploy_1",
    commit: "a".repeat(40),
    image: "local/app:immutable",
    imageDigest: digest,
  });
});

test("rollback callbacks carry the previous and restored digests", async () => {
  let body;
  await postCallback({
    token,
    callbackPublicOrigin: "https://pigo.example.com",
    callbackInternalOrigin: "http://web:3100",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200 };
    },
  }, {
    deliveryId: "rollback:run_1:production",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/runs/run_1/rollback-result",
  }, {
    status: "succeeded",
    detail: "rollback verified",
    commit: "a".repeat(40),
    image: "local/app:immutable",
    imageDigest: digest,
    rolledBackFromCommit: "b".repeat(40),
    rolledBackFromDigest: `sha256:${"e".repeat(64)}`,
  });
  assert.equal(body.imageDigest, digest);
  assert.equal(body.rolledBackFromCommit, "b".repeat(40));
  assert.equal(body.rolledBackFromDigest, `sha256:${"e".repeat(64)}`);
});

test("host-gateway smoke resolution fails closed when the published port is ambiguous", async () => {
  await assert.rejects(() => prepareSmokeUrl({
    stagingUrl: "http://host.docker.internal:18080",
    productionUrl: "http://host.docker.internal:18081",
    stagingPort: 18080,
    productionPort: 18081,
  }, "staging", async () => ({ stdout: "0123456789ab\nabcdefabcdef", stderr: "" })), /exactly one/);
});

test("state recovery fails interrupted work and promotion lookup is repository/commit exact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-executor-state-"));
  const file = path.join(directory, "executions.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    deliveries: {
      pending: { status: "pending", callbackStatus: "pending" },
      good: {
        event: "run.release_requested",
        environment: "staging",
        status: "succeeded",
        repository: "/workspace/project-a",
        commit: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
        finishedAt: "2026-10-08T00:00:00.000Z",
      },
      productionOld: {
        event: "run.release_requested",
        environment: "production",
        status: "succeeded",
        repository: "/workspace/project-a",
        commit: "d".repeat(40),
        imageDigest: `sha256:${"d".repeat(64)}`,
        finishedAt: "2026-10-07T00:00:00.000Z",
      },
      productionNew: {
        event: "run.release_requested",
        environment: "production",
        status: "succeeded",
        repository: "/workspace/project-a",
        commit: "e".repeat(40),
        imageDigest: `sha256:${"e".repeat(64)}`,
        finishedAt: "2026-10-08T00:00:00.000Z",
      },
    },
    latestByEnvironment: { staging: "good", production: "productionNew" },
  }));
  try {
    const store = new JsonStateStore(file);
    await store.init();
    assert.equal(store.getDelivery("pending").status, "failed");
    assert.match(store.getDelivery("pending").detail, /restarted/);
    assert.equal(store.successfulDeployment("staging", "/workspace/project-a", "a".repeat(40))?.status, "succeeded");
    assert.equal(store.successfulDeployment("staging", "/workspace/project-b", "a".repeat(40)), undefined);
    assert.equal(store.successfulDeploymentsForCommits("staging", ["a".repeat(40)])[0]?.repository, "/workspace/project-a");
    assert.deepEqual(store.successfulDeploymentsForCommits("staging", ["c".repeat(40)]), []);
    assert.equal(store.latest("production")?.commit, "e".repeat(40));
    assert.equal(store.successfulDeployment("production", "/workspace/project-a", "d".repeat(40))?.imageDigest, `sha256:${"d".repeat(64)}`);
    assert.equal(JSON.parse(await readFile(file, "utf8")).deliveries.pending.status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP delivery is signed, asynchronous and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-executor-http-"));
  let callbackCount = 0;
  let callbackBody;
  const { server } = await createExecutor({
    config: {
      token,
      host: "127.0.0.1",
      port: 0,
      workspaceRoot: "/workspace",
      appPath: "apps/order-status-app",
      dataFile: path.join(directory, "executions.json"),
      callbackPublicOrigin: "https://pigo.example.com",
      callbackInternalOrigin: "http://127.0.0.1:3100",
      imageRepository: "local/order-status-app",
      stagingUrl: "http://127.0.0.1:18080",
      productionUrl: "http://127.0.0.1:18081",
      stagingPort: 18080,
      productionPort: 18081,
      fetchImpl: async (url, options) => {
        callbackCount += 1;
        callbackBody = JSON.parse(options.body);
        assert.equal(url, "http://127.0.0.1:3100/api/internal/agile/releases/rel_1/release-result");
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        return { ok: true, status: 200 };
      },
    },
  });
  const payload = {
    event: "release.published",
    environment: "staging",
    deliveryId: "release-publish:rel_1:staging",
    attempt: 1,
    callbackUrl: "https://pigo.example.com/api/internal/agile/releases/rel_1/release-result",
    releaseId: "rel_1",
    version: "v1.0.0",
    commits: ["a".repeat(40)],
  };
  const deliver = async (nextPayload, authorization = `Bearer ${token}`) => {
    const body = JSON.stringify(nextPayload);
    return new Promise((resolve, reject) => {
      const request = Readable.from([Buffer.from(body)]);
      request.method = "POST";
      request.url = "/hooks/pigo-release";
      request.headers = {
        "content-type": "application/json",
        authorization,
        "x-pigo-delivery-id": nextPayload.deliveryId,
        "x-pigo-signature": `sha256=${createHmac("sha256", token).update(body).digest("hex")}`,
      };
      const response = {
        status: 0,
        writeHead(status) { this.status = status; },
        end() { resolve({ status: this.status }); },
      };
      request.once("error", reject);
      server.emit("request", request, response);
    });
  };
  try {
    assert.equal((await deliver(payload, "Bearer wrong")).status, 401);
    assert.equal((await deliver(payload)).status, 202);
    for (let attempt = 0; callbackCount === 0 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(callbackCount, 1);
    assert.equal(callbackBody.status, "failed");
    const duplicate = await deliver(payload);
    assert.equal(duplicate.status, 409);
    assert.equal(callbackCount, 1);
    assert.equal((await deliver({ ...payload, version: "v2.0.0" })).status, 409);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
