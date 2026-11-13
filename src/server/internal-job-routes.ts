import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JobRecord, PostgresRunStore } from "./run-store-pg.js";
import type { RunStoreLike } from "./store.js";

export const INTERNAL_JOB_ROUTE_CONTRACT = [
  { method: "GET", url: "/api/internal/jobs/pending", auth: "internal" },
  { method: "POST", url: "/api/internal/jobs/lease", auth: "internal" },
  { method: "POST", url: "/api/internal/jobs/:id/claim", auth: "internal" },
  { method: "POST", url: "/api/internal/jobs/:id/heartbeat", auth: "internal" },
  { method: "POST", url: "/api/internal/jobs/:id/release", auth: "internal" },
  { method: "POST", url: "/api/internal/jobs/:id/finish", auth: "internal" },
  { method: "GET", url: "/api/internal/runs/:id/checkpoints", auth: "internal" },
  { method: "POST", url: "/api/internal/runs/:id/checkpoints", auth: "internal" },
] as const;

const leaseSchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(1).max(4),
}).strict();

const checkpointSchema = z.object({
  stageKey: z.string().trim().min(1).max(120),
  status: z.enum(["running", "completed", "failed"]),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

type InternalJobQueue = Pick<PostgresRunStore,
  | "leaseJobs"
  | "claimJob"
  | "heartbeatJob"
  | "releaseReservation"
  | "finishJob"
  | "listCheckpoints"
  | "saveCheckpoint"
>;

export interface InternalJobRouteDependencies {
  authorized: (request: FastifyRequest) => boolean;
  jobQueue?: InternalJobQueue;
  store: Pick<RunStoreLike, "getRun">;
  staleAfterMs: number;
  payloadsForJobs: (
    entries: Array<{ job: JobRecord; wasStarted: boolean }>,
    workerId: string,
    mutate: boolean,
  ) => Promise<Array<Record<string, unknown>>>;
}

/**
 * Internal durable-job and checkpoint API.
 *
 * The encapsulated preHandler is the single authentication boundary for every
 * route in `INTERNAL_JOB_ROUTE_CONTRACT`; handlers are unreachable when the
 * bearer token is absent or invalid.
 */
export function registerInternalJobRoutes(app: FastifyInstance, deps: InternalJobRouteDependencies): void {
  void app.register(async (internal) => {
    internal.addHook("preHandler", async (request, reply) => {
      if (!deps.authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    });

    internal.get<{ Querystring: { workerId?: string } }>("/api/internal/jobs/pending", async (_request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      reply.header("Deprecation", "true");
      // Old workers ignore a failed asynchronous claim. Returning candidate
      // rows would preserve the duplicate-execution race during a rolling
      // upgrade, so this compatibility endpoint stays read-only and empty.
      return { jobs: [] };
    });

    internal.post("/api/internal/jobs/lease", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      const parsed = leaseSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid lease request", details: parsed.error.issues });
      const leased = await deps.jobQueue.leaseJobs({ ...parsed.data, staleAfterMs: deps.staleAfterMs });
      return { jobs: await deps.payloadsForJobs(leased, parsed.data.workerId, true) };
    });

    internal.post<{ Params: { id: string } }>("/api/internal/jobs/:id/claim", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
      const job = await deps.jobQueue.claimJob(request.params.id, workerId, deps.staleAfterMs);
      if (!job) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
      return { ok: true, job };
    });

    internal.post<{ Params: { id: string } }>("/api/internal/jobs/:id/heartbeat", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
      if (!await deps.jobQueue.heartbeatJob(request.params.id, workerId)) {
        return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
      }
      return { ok: true };
    });

    internal.post<{ Params: { id: string } }>("/api/internal/jobs/:id/release", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      const body = (request.body ?? {}) as { workerId?: unknown; reason?: unknown };
      const workerId = String(body.workerId ?? "unknown").slice(0, 120);
      const released = await deps.jobQueue.releaseReservation(request.params.id, workerId, String(body.reason ?? "Worker deferred job").slice(0, 500));
      if (!released) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
      return { ok: true };
    });

    internal.post<{ Params: { id: string } }>("/api/internal/jobs/:id/finish", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
      const body = (request.body ?? {}) as { workerId?: unknown; state?: unknown; error?: unknown };
      const workerId = String(body.workerId ?? "unknown").slice(0, 120);
      const state = body.state === "failed" || body.state === "cancelled" ? body.state : "done";
      const result = await deps.jobQueue.finishJob(request.params.id, workerId, state, body.error === undefined ? undefined : String(body.error).slice(0, 500));
      if (!result.ok) return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
      return { ok: true, idempotent: result.idempotent };
    });

    internal.get<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
      const run = deps.store.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      return { checkpoints: await deps.jobQueue.listCheckpoints(run.id) };
    });

    internal.post<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
      if (!deps.jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
      const parsed = checkpointSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid checkpoint", details: parsed.error.issues });
      const run = deps.store.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      await deps.jobQueue.saveCheckpoint({
        runId: run.id,
        stageKey: parsed.data.stageKey,
        status: parsed.data.status,
        payload: parsed.data.payload,
        idempotencyKey: parsed.data.idempotencyKey ?? `${run.id}:${parsed.data.stageKey}`,
      });
      return { ok: true };
    });
  });
}
