import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("actual Worker gates metrics, reports configured capacity and suppresses secret version labels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-worker-metrics-")), token = randomBytes(32).toString("hex"), readToken = randomBytes(32).toString("hex");
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const address = reserve.address(); if (!address || typeof address === "string") throw Error("port reservation");
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const url = `http://127.0.0.1:${address.port}`;
  const worker = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], { env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "test", PORT: String(address.port), HOST: "127.0.0.1", PI_WORKSPACE_ROOT: root, PI_INTERNAL_TOKEN: token, PI_METRICS_TOKEN: readToken, PI_WORKER_VERSION: token, PI_MAX_ACTIVE_JOBS: "99", PI_MIN_FREE_DISK_MB: "64" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; worker.stdout.on("data", b => { logs += b; }); worker.stderr.on("data", b => { logs += b; });
  try {
    await vi.waitFor(async () => { expect(worker.exitCode, logs).toBeNull(); expect((await fetch(url + "/health")).ok).toBe(true); }, { timeout: 15000 });
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${token}` }] as Record<string, string>[]) expect((await fetch(url + "/metrics", { headers })).status).toBe(401);
    expect((await fetch(url + "/jobs", { method: "POST", headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const response = await fetch(url + "/metrics", { headers: { authorization: `Bearer ${readToken}` } });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text(); expect(text).not.toContain(token); expect(text).not.toContain(readToken); expect(text).not.toContain(root);
    expect(text).toContain('pigo_worker_active_jobs{service="pigo-worker",environment="test",version="unknown"} 0');
    expect(text).toContain('pigo_worker_capacity{service="pigo-worker",environment="test",version="unknown"} 4');
  } finally {
    if (worker.exitCode === null) { const ended = once(worker, "exit"); worker.kill("SIGTERM"); await ended; }
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
