import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  postProgress,
  prepareSmokeUrl,
  validatePayload,
} from "./server.mjs";

const token = "0123456789abcdef0123456789abcdef";

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
  }, "release-publish:rel_1:production");
  assert.equal(payload.environment, "production");
  assert.equal(payload.releaseId, "rel_1");
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
    PIGO_EXECUTOR_CALLBACK_ORIGIN: "https://pigo.example.com",
  };
  assert.equal(loadConfig(valid).port, 3300);
  assert.equal(loadConfig(valid).targetNetwork, "pigo-release-targets");
  assert.equal(loadConfig(valid).stagingPublicUrl, "");
  assert.equal(loadConfig({ ...valid, PIGO_EXECUTOR_STAGING_PUBLIC_URL: "https://staging.example.com/app" }).stagingPublicUrl, "https://staging.example.com/app");
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_CALLBACK_ORIGIN: "" }), /CALLBACK_ORIGIN is required/);
  assert.throws(() => loadConfig({ ...valid, PIGO_EXECUTOR_TOKEN: "too-short" }), /at least 32/);
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
          Networks: inspections === 1 ? {} : { "pigo-release-targets": { IPAddress: "172.30.0.4" } },
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
  assert.equal(url, "http://172.30.0.4:8080");
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
    },
    latestByEnvironment: { staging: "good" },
  }));
  try {
    const store = new JsonStateStore(file);
    await store.init();
    assert.equal(store.getDelivery("pending").status, "failed");
    assert.match(store.getDelivery("pending").detail, /restarted/);
    assert.equal(store.successfulDeployment("staging", "/workspace/project-a", "a".repeat(40))?.status, "succeeded");
    assert.equal(store.successfulDeployment("staging", "/workspace/project-b", "a".repeat(40)), undefined);
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
