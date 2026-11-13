import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Run } from "../../../shared/types.js";
import { PostgresRunStore, type JobRecord } from "../../run-store-pg.js";
import type { RunStoreLike } from "../../store.js";
import type { ModelCredentials } from "../../credential-vault.js";

const checkpointSchema = z.object({
  stageKey: z.string().trim().min(1).max(120),
  status: z.enum(["running", "completed", "failed"]),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export function registerInternalJobRoutes(app: FastifyInstance, deps: {
  store: RunStoreLike;
  jobQueue: PostgresRunStore | undefined;
  staleAfterMs: number;
  jobCredentialsFor: (run: Run) => Promise<ModelCredentials | undefined>;
}) {
  const { store, jobQueue, staleAfterMs, jobCredentialsFor } = deps;

  async function workerPayloadsForJobs(
    entries: Array<{ job: JobRecord; wasStarted: boolean }>,
    workerId: string,
    mutate: boolean,
  ) {
    const payloads: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      const { job } = entry;
      // Multi-process safety: a run written by another web instance (rolling
      // deploy, ops tooling) is hydrated here before the job payload is built, so
      // the worker never receives a job it cannot resolve.
      const run = store instanceof PostgresRunStore
        ? await store.hydrate(job.runId)
        : store.getRun(job.runId);
      if (!run) {
        if (mutate) {
          const ageMs = Date.now() - Date.parse(job.createdAt);
          if (ageMs > 15 * 60_000) await jobQueue!.finishJobAsSystem(job.id, "failed", "Run missing");
          else await jobQueue!.releaseReservation(job.id, workerId, "Run missing (等待运行记录可见)");
        }
        continue;
      }
      if (["completed", "failed", "cancelled", "needs_human"].includes(run.state)) {
        if (mutate) await jobQueue!.finishJobAsSystem(job.id, "done", `Run already ${run.state}`);
        continue;
      }
      const credentials = await jobCredentialsFor(run);
      if (!credentials) {
        if (mutate) {
          await jobQueue!.finishJobAsSystem(job.id, "failed", "Credentials unavailable for the pinned providers");
          await store.updateRun(run.id, { state: "needs_human", summary: "恢复执行失败：该任务所用模型的 provider 凭据不可用，请在「模型与凭据」页检查" }).catch(() => undefined);
          await store.appendEvent({
            runId: run.id,
            round: run.round,
            source: "system",
            type: "run.recovery_blocked",
            message: "Worker 重启后无法恢复：缺少该任务 provider 的凭据（任务未丢失，可在配置凭据后重新恢复）",
            at: new Date().toISOString(),
          }).catch(() => undefined);
        }
        continue;
      }
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      // AUD-05: the durable job payload decides what the worker executes: a job
      // that never started must create the run directory, only a started one is a
      // recovery; human resume/retry intent survives a queue wait or a crash.
      payloads.push({
        jobId: job.id,
        kind: job.kind,
        run,
        checks: Array.isArray(payload.checks) ? payload.checks : [],
        credentials,
        wasStarted: entry.wasStarted,
        ...(payload.resume ? { resume: payload.resume } : {}),
        ...(payload.retryReview ? { retryReview: true } : {}),
      });
    }
    return payloads;
  }

  app.get<{ Querystring: { workerId?: string } }>("/api/internal/jobs/pending", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    reply.header("Deprecation", "true");
    // Old workers ignore a failed asynchronous claim. Returning candidate rows
    // here would therefore preserve the duplicate-execution race during a rolling
    // upgrade. Keep the endpoint read-only and empty for one compatibility window;
    // new workers use the atomic POST /jobs/lease endpoint.
    return { jobs: [] };
  });

  app.post("/api/internal/jobs/lease", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    const parsed = z.object({
      workerId: z.string().trim().min(1).max(120),
      capacity: z.number().int().min(1).max(4),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid lease request", details: parsed.error.issues });
    const leased = await jobQueue.leaseJobs({ ...parsed.data, staleAfterMs: staleAfterMs });
    return { jobs: await workerPayloadsForJobs(leased, parsed.data.workerId, true) };
  });

  app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/claim", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
    const job = await jobQueue.claimJob(request.params.id, workerId, staleAfterMs);
    if (!job) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
    return { ok: true, job };
  });

  app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/heartbeat", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
    if (!await jobQueue.heartbeatJob(request.params.id, workerId)) {
      return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/release", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    const body = (request.body ?? {}) as { workerId?: unknown; reason?: unknown };
    const workerId = String(body.workerId ?? "unknown").slice(0, 120);
    const released = await jobQueue.releaseReservation(request.params.id, workerId, String(body.reason ?? "Worker deferred job").slice(0, 500));
    if (!released) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/finish", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
    const body = (request.body ?? {}) as { workerId?: unknown; state?: unknown; error?: unknown };
    const workerId = String(body.workerId ?? "unknown").slice(0, 120);
    const state = body.state === "failed" || body.state === "cancelled" ? body.state : "done";
    const result = await jobQueue.finishJob(request.params.id, workerId, state, body.error === undefined ? undefined : String(body.error).slice(0, 500));
    if (!result.ok) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
    return { ok: true, idempotent: result.idempotent };
  });

  app.get<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return { checkpoints: await jobQueue.listCheckpoints(run.id) };
  });

  app.post<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
    if (!jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
    const parsed = checkpointSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid checkpoint", details: parsed.error.issues });
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    await jobQueue.saveCheckpoint({
      runId: run.id,
      stageKey: parsed.data.stageKey,
      status: parsed.data.status,
      payload: parsed.data.payload,
      idempotencyKey: parsed.data.idempotencyKey ?? `${run.id}:${parsed.data.stageKey}`,
    });
    return { ok: true };
  });
}
