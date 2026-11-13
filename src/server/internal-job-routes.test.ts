import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../shared/types.js";
import { INTERNAL_JOB_ROUTE_CONTRACT, registerInternalJobRoutes } from "./internal-job-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(authorized: boolean) {
  const app = Fastify();
  apps.push(app);
  const queue = {
    leaseJobs: vi.fn(async () => []),
    claimJob: vi.fn(async () => ({ id: "job-1", runId: "run-1" })),
    heartbeatJob: vi.fn(async () => true),
    releaseReservation: vi.fn(async () => true),
    finishJob: vi.fn(async () => ({ ok: true, idempotent: false })),
    listCheckpoints: vi.fn(async () => []),
    saveCheckpoint: vi.fn(async () => undefined),
  };
  const run = { id: "run-1" } as Run;
  const store = { getRun: vi.fn(() => run) };
  const payloadsForJobs = vi.fn(async () => []);
  registerInternalJobRoutes(app, {
    authorized: () => authorized,
    jobQueue: queue as never,
    store,
    staleAfterMs: 120_000,
    payloadsForJobs,
  });
  return { app, queue, store, payloadsForJobs };
}

describe("internal job route contract", () => {
  it("registers the exact method and URL snapshot", async () => {
    const app = Fastify();
    apps.push(app);
    const observed: Array<{ method: string; url: string; auth: "internal" }> = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === "HEAD") continue;
        if (route.url.startsWith("/api/internal/jobs/") || route.url.endsWith("/checkpoints")) {
          observed.push({ method, url: route.url, auth: "internal" });
        }
      }
    });
    registerInternalJobRoutes(app, {
      authorized: () => false,
      store: { getRun: vi.fn() },
      staleAfterMs: 120_000,
      payloadsForJobs: vi.fn(async () => []),
    });
    await app.ready();
    expect(observed).toEqual(INTERNAL_JOB_ROUTE_CONTRACT);
  });

  it("rejects every route before any store or queue handler executes", async () => {
    const { app, queue, store, payloadsForJobs } = fixture(false);
    const requests = [
      { method: "GET", url: "/api/internal/jobs/pending" },
      { method: "POST", url: "/api/internal/jobs/lease", payload: { workerId: "worker-a", capacity: 1 } },
      { method: "POST", url: "/api/internal/jobs/job-1/claim", payload: { workerId: "worker-a" } },
      { method: "POST", url: "/api/internal/jobs/job-1/heartbeat", payload: { workerId: "worker-a" } },
      { method: "POST", url: "/api/internal/jobs/job-1/release", payload: { workerId: "worker-a" } },
      { method: "POST", url: "/api/internal/jobs/job-1/finish", payload: { workerId: "worker-a", state: "done" } },
      { method: "GET", url: "/api/internal/runs/run-1/checkpoints" },
      { method: "POST", url: "/api/internal/runs/run-1/checkpoints", payload: { stageKey: "review", status: "completed" } },
    ] as const;
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
    }
    for (const operation of Object.values(queue)) expect(operation).not.toHaveBeenCalled();
    expect(store.getRun).not.toHaveBeenCalled();
    expect(payloadsForJobs).not.toHaveBeenCalled();
  });

  it("preserves lease, compatibility and checkpoint behavior behind the guard", async () => {
    const { app, queue, store, payloadsForJobs } = fixture(true);
    const headers = { authorization: "Bearer fixture" };

    const pending = await app.inject({ method: "GET", url: "/api/internal/jobs/pending", headers });
    expect(pending.statusCode).toBe(200);
    expect(pending.headers.deprecation).toBe("true");
    expect(pending.json()).toEqual({ jobs: [] });

    const lease = await app.inject({ method: "POST", url: "/api/internal/jobs/lease", headers, payload: { workerId: "worker-a", capacity: 2 } });
    expect(lease.statusCode).toBe(200);
    expect(queue.leaseJobs).toHaveBeenCalledWith({ workerId: "worker-a", capacity: 2, staleAfterMs: 120_000 });
    expect(payloadsForJobs).toHaveBeenCalledWith([], "worker-a", true);

    expect((await app.inject({ method: "POST", url: "/api/internal/jobs/job-1/claim", headers, payload: { workerId: "worker-a" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/internal/jobs/job-1/heartbeat", headers, payload: { workerId: "worker-a" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/internal/jobs/job-1/release", headers, payload: { workerId: "worker-a", reason: "retry" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/internal/jobs/job-1/finish", headers, payload: { workerId: "worker-a", state: "done" } })).statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/internal/runs/run-1/checkpoints", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ checkpoints: [] });
    const saved = await app.inject({ method: "POST", url: "/api/internal/runs/run-1/checkpoints", headers, payload: { stageKey: "review", status: "completed" } });
    expect(saved.statusCode).toBe(200);
    expect(store.getRun).toHaveBeenCalledTimes(2);
    expect(queue.saveCheckpoint).toHaveBeenCalledWith({
      runId: "run-1",
      stageKey: "review",
      status: "completed",
      payload: undefined,
      idempotencyKey: "run-1:review",
    });
  });
});
