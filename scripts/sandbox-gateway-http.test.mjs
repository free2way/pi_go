import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createGateway, loadGatewayConfig } from "../deploy/docker/sandbox-gateway.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), worktree = path.join(workspace, "runs", "owner", "run-1"), models = path.join(root, "models.json");
  await mkdir(worktree, { recursive: true }); await writeFile(models, "{}");
  const key = randomBytes(32).toString("hex");
  const config = loadGatewayConfig({ PI_HOST_WORKSPACE_ROOT: workspace, PI_SANDBOX_MODELS_FILE: models,
    PI_DOCKER_GATEWAY_TOKEN: key, PI_SANDBOX_IMAGE: "sandbox@sha256:" + "a".repeat(64),
    PI_SANDBOX_NETWORK: "test-network", PI_DOCKER_SOCKET: path.join(root, "docker.sock"), PI_DOCKER_REQUIRE_ROOTLESS: "0" });
  const calls = [], id = "a".repeat(64), foreign = "b".repeat(64);
  const docker = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === `/v1.43/containers/${foreign}/json`) { response.end(JSON.stringify({ Name: "/database", Config: { Image: "database" } })); }
    else if (request.url.startsWith("/v1.43/containers/create?")) { response.writeHead(201); response.end(JSON.stringify({ Id: id })); }
    else if (request.url.endsWith("/wait")) response.end(JSON.stringify({ StatusCode: 0 }));
    else if (request.url.includes("/logs?")) response.end("sandbox-output");
    else if (request.url.endsWith("/_ping")) response.end("OK");
    else if (request.url.startsWith("/v1.43/images/")) response.end(JSON.stringify({ Id: "sha256:" + "c".repeat(64) }));
    else { response.writeHead(204); response.end(); }
  });
  docker.listen(config.socketPath); await once(docker, "listening");
  t.after(() => new Promise(resolve => docker.close(resolve)));
  const gateway = createGateway(config); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const request = (method, url, body, token = config.token) => fetch(base + url, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const spec = { Image: config.policy.image, Cmd: ["pi", "--mode", "json"], Env: [], User: "node", WorkingDir: "/workspace/runs/owner/run-1",
    HostConfig: { Binds: [`${worktree}:/workspace/runs/owner/run-1:rw`, `${models}:/home/node/.pi/agent/models.json:ro`],
      NetworkMode: "none", AutoRemove: false, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "size=512m,mode=1777", "/run": "size=16m,mode=755", "/home/node/.cache": "size=64m,mode=700,uid=1000,gid=1000" },
      PidsLimit: 256, Memory: 2 * 1024 ** 3, NanoCpus: 1_500_000_000 }, Labels: { "pigo.sandbox": "1", "pigo.label": "developer" } };
  return { request, calls, id, foreign, spec, config, base };
}

test("HTTP authentication and denied Docker capabilities never reach the daemon", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/v1.43/_ping")).status, 401);
  assert.equal((await f.request("POST", "/v1.43/containers/create?name=pigo-task-test1234", f.spec, "wrong")).status, 401);
  for (const [method, url] of [
    ["POST", `/v1.43/containers/${f.foreign}/exec`], ["POST", `/v1.43/exec/${f.foreign}/start`],
    ["POST", "/v1.43/swarm/init"], ["GET", "/v1.43/volumes"], ["POST", "/v1.43/volumes/create"],
    ["GET", "/v1.43/containers/json"], ["GET", "/v1.43/info"], ["POST", "/v1.43/build"], ["POST", "/v1.43/images/create"],
  ]) assert.equal((await f.request(method, url)).status, 403, `${method} ${url}`);
  assert.equal(f.calls.length, 0);
  for (const mutate of [
    v => { v.HostConfig.Privileged = true; }, v => { v.HostConfig.Binds.push("/:/host:rw"); },
    v => { v.HostConfig.NetworkMode = "host"; }, v => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    v => { v.Image = "other"; }, v => { v.User = "root"; }, v => { v.Env.push("DOCKER_HOST=unix:///var/run/docker.sock"); },
  ]) {
    const attack = structuredClone(f.spec); mutate(attack);
    assert.equal((await f.request("POST", "/v1.43/containers/create?name=pigo-task-test1234", attack)).status, 403);
  }
  assert.equal((await f.request("POST", "/v1.43/containers/create?name=pigo-task-test1234", "{")).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request("POST", `/v1.43/containers/${f.foreign}/start`)).status, 403);
  assert.deepEqual(f.calls.map(v => `${v.method} ${v.url}`), [`GET /v1.43/containers/${f.foreign}/json`]);
});

test("HTTP gateway forwards the constrained create/start/log/wait/kill/remove lifecycle", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("GET", "/v1.43/_ping")).status, 200);
  assert.equal((await f.request("GET", `/v1.43/images/${encodeURIComponent(f.config.policy.image)}/json`)).status, 200);
  assert.equal((await f.request("POST", "/v1.43/containers/create?name=pigo-task-test1234", f.spec)).status, 201);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), f.spec);
  const container = `/v1.43/containers/${f.id}`;
  assert.equal((await f.request("POST", container + "/start")).status, 204);
  assert.equal(await (await f.request("GET", container + "/logs?follow=1&stdout=1&stderr=1")).text(), "sandbox-output");
  assert.deepEqual(await (await f.request("POST", container + "/wait")).json(), { StatusCode: 0 });
  assert.equal((await f.request("POST", container + "/kill?signal=SIGTERM")).status, 204);
  assert.equal((await f.request("DELETE", container + "?force=true&v=true")).status, 204);
  assert.equal(f.calls.length, 8);
  assert.ok(f.calls.every(v => !v.url.includes("/json") || v.url.includes("/images/")));
});
