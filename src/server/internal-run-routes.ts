import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Run, RunEvent } from "../shared/types.js";
import { internalUpdateRejection } from "../shared/run-state.js";
import { saveInternalRunArtifact } from "./artifact-api.js";
import { conflictReplyFor } from "./request-errors.js";
import type { PostgresRunStore } from "./run-store-pg.js";
import type { RunStoreLike } from "./store.js";

export const INTERNAL_RUN_ROUTE_CONTRACT = [
  { method: "POST", url: "/api/internal/runs/:id/update", bodyLimit: 4 * 1024 * 1024, auth: "internal" },
  { method: "POST", url: "/api/internal/runs/:id/artifacts", bodyLimit: 8 * 1024 * 1024, auth: "internal" },
] as const;

export interface InternalRunUpdateData {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "runId" | "at" | "seq">;
  deliveryId?: string;
  jobId?: string;
  workerId?: string;
}

export interface InternalArtifactData {
  artifactId: string;
  kind: string;
  content: string;
  baseSha?: string;
  ownerId?: string;
}

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: unknown } };

type DeliveryQueue = Pick<PostgresRunStore, "applyDelivery">;

export interface InternalRunRouteDependencies {
  authorized: (request: FastifyRequest) => boolean;
  store: RunStoreLike;
  jobQueue?: DeliveryQueue;
  parseUpdate: (input: unknown) => ParseResult<InternalRunUpdateData>;
  parseArtifact: (input: unknown) => ParseResult<InternalArtifactData>;
  persistTerminalDiffArtifact: (run: Run | undefined) => Promise<void>;
  reconcileStoryForRun: (runId: string) => Promise<void>;
  readArtifactCredentials: (run: Run) => Promise<readonly string[]>;
  environment?: NodeJS.ProcessEnv;
}

/** Internal Worker callbacks and artifact uploads behind one plugin auth gate. */
export function registerInternalRunRoutes(app: FastifyInstance, deps: InternalRunRouteDependencies): void {
  void app.register(async (internal) => {
    internal.addHook("preHandler", async (request, reply) => {
      if (!deps.authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    });

    internal.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
      const parsed = deps.parseUpdate(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid internal update", details: parsed.error.issues });
      const run = deps.store.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const rejection = internalUpdateRejection(run);
      if (rejection) return reply.code(409).send({ error: rejection });
      const { patch, event, deliveryId, jobId, workerId } = parsed.data;
      if ((jobId && !workerId) || (!jobId && workerId) || ((jobId || workerId) && !deliveryId)) {
        return reply.code(400).send({ error: "jobId, workerId and deliveryId must be supplied together" });
      }
      try {
        if (deliveryId && deps.jobQueue) {
          const result = await deps.jobQueue.applyDelivery({
            runId: run.id,
            deliveryId,
            patch,
            event: event ? { ...event, runId: run.id, at: new Date().toISOString() } : undefined,
            ...(jobId && workerId ? { lease: { jobId, workerId } } : {}),
          });
          if (result.applied) await deps.persistTerminalDiffArtifact(deps.store.getRun(run.id));
          if (result.applied) await deps.reconcileStoryForRun(run.id);
          return { ok: true, applied: result.applied, seq: result.seq };
        }
        if (patch) await deps.store.updateRun(run.id, patch);
        if (event) await deps.store.appendEvent({ ...event, runId: run.id, at: new Date().toISOString() });
        if (patch) await deps.persistTerminalDiffArtifact(deps.store.getRun(run.id));
        if (patch) await deps.reconcileStoryForRun(run.id);
        return { ok: true, applied: true };
      } catch (error) {
        if ((error as { code?: unknown }).code === "JOB_LEASE_LOST") {
          return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
        }
        const conflict = conflictReplyFor(error);
        if (conflict) {
          if (conflict.code === "INVALID_STATE_TRANSITION") {
            await deps.store.appendEvent({
              runId: run.id,
              round: run.round,
              source: "system",
              type: "run.transition_rejected",
              message: `拒绝非法状态转移：${conflict.message}`,
              at: new Date().toISOString(),
            }).catch(() => undefined);
          }
          return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
        }
        throw error;
      }
    });

    internal.post<{ Params: { id: string } }>("/api/internal/runs/:id/artifacts", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
      const parsed = deps.parseArtifact(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid artifact upload", details: parsed.error.issues });
      const result = await saveInternalRunArtifact(
        deps.store,
        { runId: request.params.id, ...parsed.data },
        deps.environment ?? process.env,
        deps.readArtifactCredentials,
      );
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { ok: true, artifact: result.artifact };
    });
  });
}
