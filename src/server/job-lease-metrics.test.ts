import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "./db.js";
import type { Run } from "../shared/types.js";
import type { RunStoreLike } from "./store.js";
import type { PostgresRunStore } from "./run-store-pg.js";
import { registerInternalAuthorization } from "./routes/internal/auth.js";
import { registerInternalJobRoutes } from "./routes/internal/jobs.js";
import { registerInternalRunRoutes } from "./routes/internal/runs.js";
import { registerOperationalMetrics } from "./operational-metrics.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const app = Fastify(); apps.push(app);
  const token = randomBytes(32).toString("hex"), readToken = randomBytes(32).toString("hex");
  registerInternalAuthorization(app, { worker: h => h === `Bearer ${token}`, release: () => false, metrics: h => h === `Bearer ${readToken}` });
  const run = { id: "private-run-id", state: "queued", mode: "real", round: 1 } as Run;
  const store = { getRun: () => run } as unknown as RunStoreLike;
  const job = { id: "private-job-id", runId: run.id, payload: {}, kind: "run" };
  const queue = { leaseJobs: vi.fn(async () => [] as { job: typeof job; wasStarted: boolean }[]), claimJob: vi.fn(async () => job as typeof job | undefined),
    heartbeatJob: vi.fn(async () => true), releaseReservation: vi.fn(async () => true), finishJob: vi.fn(async () => ({ ok: true, idempotent: true })),
    applyDelivery: vi.fn(async () => ({ applied: false, seq: 0 })) };
  registerInternalJobRoutes(app, { store, jobQueue: queue as unknown as PostgresRunStore, staleAfterMs: 40000,
    jobCredentialsFor: async () => ({ developer: "DUMMY_DEVELOPER", reviewer: "DUMMY_REVIEWER" }) });
  registerInternalRunRoutes(app, { store, jobQueue: queue as unknown as PostgresRunStore,
    persistTerminalDiffArtifact: async () => {}, reconcileStoryForRun: async () => {}, readArtifactCredentials: async () => [] });
  const rows = [...["calls", "tokens", "estimated_cost_usd", "unknown_calls", "failures"].map(bucket => ({ family: "usage", bucket, value: "0" })), { family: "queue", bucket: "oldest_wait_seconds", value: "0" }];
  const db: Db = { query: async () => ({ rows }), withTransaction: async fn => fn(db) };
  registerOperationalMetrics(app, { db, pool: { totalCount: 0, idleCount: 0, waitingCount: 0 }, version: "fixture" });
  const post = (path: string, payload: object = { workerId: "private-worker-id" }) => app.inject({ method: "POST", url: "/api/internal/" + path, headers: { authorization: `Bearer ${token}` }, payload });
  const scrape = async () => (await app.inject({ url: "/api/internal/metrics", headers: { authorization: `Bearer ${readToken}` } })).body;
  return { app, queue, job, post, scrape, token, readToken };
}

it("observes actual route outcomes, excludes unauthenticated requests and keeps Web instances separate", async () => {
  const f = fixture();
  for (const headers of [{}, { authorization: `Bearer ${f.readToken}` }]) expect((await f.app.inject({ method: "POST", url: "/api/internal/jobs/lease", headers, payload: { workerId: "private", capacity: 1 } })).statusCode).toBe(401);
  expect(f.queue.leaseJobs).not.toHaveBeenCalled();
  expect((await f.post("jobs/lease", { workerId: "private", capacity: 1 })).statusCode).toBe(200);
  f.queue.leaseJobs.mockResolvedValueOnce([{ job: f.job, wasStarted: false }]);
  expect((await f.post("jobs/lease", { workerId: "private", capacity: 1 })).statusCode).toBe(200);
  for (const operation of ["claim", "heartbeat", "release", "finish"] as const) {
    expect((await f.post(`jobs/${f.job.id}/${operation}`)).statusCode).toBe(200);
  }
  f.queue.claimJob.mockResolvedValueOnce(undefined); f.queue.heartbeatJob.mockResolvedValueOnce(false);
  f.queue.releaseReservation.mockResolvedValueOnce(false); f.queue.finishJob.mockResolvedValueOnce({ ok: false, idempotent: false });
  for (const operation of ["claim", "heartbeat", "release", "finish"]) expect((await f.post(`jobs/${f.job.id}/${operation}`)).statusCode).toBe(409);
  const text = await f.scrape();
  for (const operation of ["claim", "heartbeat", "release", "finish"]) {
    expect(text).toMatch(new RegExp(`pigo_job_lease_operations_total\\{operation="${operation}",outcome="conflict",[^\\n]+\\} 1`));
    expect(text).toMatch(new RegExp(`pigo_job_lease_lost_total\\{operation="${operation}",[^\\n]+\\} 1`));
  }
  expect(text).toMatch(/operation="lease",outcome="empty",[^\n]+\} 1/);
  expect(text).toMatch(/operation="lease",outcome="success",[^\n]+\} 1/);
  expect(text).not.toMatch(/private-run-id|private-job-id|private-worker-id|DUMMY_|job_id|run_id/);
  expect(text).not.toContain(f.token); expect(text).not.toContain(f.readToken);
  expect(await fixture().scrape()).toMatch(/operation="claim",outcome="conflict",[^\n]+\} 0/);
});

it("counts fenced callback lease loss while preserving rejection and idempotent delivery semantics", async () => {
  const f = fixture(), body = { jobId: f.job.id, workerId: "private-worker", deliveryId: "private-delivery", patch: { state: "preparing" } };
  f.queue.applyDelivery.mockRejectedValueOnce(Object.assign(new Error("DUMMY_PRIVATE"), { code: "JOB_LEASE_LOST" }));
  expect((await f.post("runs/private-run-id/update", body)).statusCode).toBe(409);
  expect((await f.post("runs/private-run-id/update", body)).statusCode).toBe(200);
  const text = await f.scrape();
  expect(text).toMatch(/operation="callback",outcome="success",[^\n]+\} 1/);
  expect(text).toMatch(/pigo_job_lease_lost_total\{operation="callback",[^\n]+\} 1/);
  expect(text).not.toContain("DUMMY_PRIVATE");
});
