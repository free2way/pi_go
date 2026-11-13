import type { FastifyInstance } from "fastify";
import { internalUpdateRejection } from "../../../shared/run-state.js";
import type { Run } from "../../../shared/types.js";
import { saveInternalRunArtifact } from "../../artifact-api.js";
import { conflictReplyFor } from "../../request-errors.js";
import type { PostgresRunStore } from "../../run-store-pg.js";
import type { RunStoreLike } from "../../store.js";
import { INTERNAL_ARTIFACT_BODY_LIMIT, internalArtifactSchema, internalUpdateSchema } from "./run-schemas.js";

export function registerInternalRunRoutes(app: FastifyInstance, deps: {
  store: RunStoreLike;
  jobQueue: PostgresRunStore | undefined;
  persistTerminalDiffArtifact: (run: Run | undefined) => Promise<void>;
  reconcileStoryForRun: (runId: string) => Promise<void>;
  readArtifactCredentials: (run: Run) => Promise<readonly string[]>;
}) {
  const { store, jobQueue, persistTerminalDiffArtifact, reconcileStoryForRun, readArtifactCredentials } = deps;
  app.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const parsed = internalUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid internal update", details: parsed.error.issues });
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    // Chat/状态抑制：终态运行（例如用户刚取消）不再接受任何 worker 内部更新，
    // 否则迟到的 chat.message 会追加在 run.cancelled 之后并覆盖终态。
    const rejection = internalUpdateRejection(run);
    if (rejection) return reply.code(409).send({ error: rejection });
    const { patch, event, deliveryId, jobId, workerId } = parsed.data;
    if ((jobId && !workerId) || (!jobId && workerId) || ((jobId || workerId) && !deliveryId)) {
      return reply.code(400).send({ error: "jobId, workerId and deliveryId must be supplied together" });
    }
    try {
      if (deliveryId && jobQueue) {
        // AUD-15: patch + event + delivery record commit in one transaction, so a
        // duplicated internal call can neither double count nor rewind state.
        const result = await jobQueue.applyDelivery({
          runId: run.id,
          deliveryId,
          patch: patch as Partial<Run> | undefined,
          event: event ? { ...event, runId: run.id, at: new Date().toISOString() } : undefined,
          ...(jobId && workerId ? { lease: { jobId, workerId } } : {}),
        });
        // AUD-16: the terminal callback carries the run diff; persist it in full.
        if (result.applied) await persistTerminalDiffArtifact(store.getRun(run.id));
        if (result.applied) await reconcileStoryForRun(run.id);
        return { ok: true, applied: result.applied, seq: result.seq };
      }
      if (patch) await store.updateRun(run.id, patch as Partial<Run>);
      if (event) await store.appendEvent({ ...event, runId: run.id, at: new Date().toISOString() });
      if (patch) await persistTerminalDiffArtifact(store.getRun(run.id));
      if (patch) await reconcileStoryForRun(run.id);
      return { ok: true, applied: true };
    } catch (error) {
      if ((error as { code?: unknown }).code === "JOB_LEASE_LOST") {
        return reply.code(409).send({ error: "Job lease lost", code: "JOB_LEASE_LOST" });
      }
      const conflict = conflictReplyFor(error);
      if (conflict) {
        if (conflict.code === "INVALID_STATE_TRANSITION") {
          await store.appendEvent({
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

  // NEW-07 / AUD-16: internal artifact upload. The worker persists a full diff here
  // (beyond the 3 MiB inline callback budget) and references the returned artifact
  // id/hash/bytes in the callback, so the browser download is the complete body.
  app.post<{ Params: { id: string } }>("/api/internal/runs/:id/artifacts", { bodyLimit: INTERNAL_ARTIFACT_BODY_LIMIT }, async (request, reply) => {
    const parsed = internalArtifactSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid artifact upload", details: parsed.error.issues });
    const result = await saveInternalRunArtifact(store, { runId: request.params.id, ...parsed.data }, process.env, readArtifactCredentials);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { ok: true, artifact: result.artifact };
  });
}
