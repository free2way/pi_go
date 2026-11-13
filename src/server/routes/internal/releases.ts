import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RunReleaseRecord, RunRollbackRecord } from "../../../shared/types.js";
import type { AgileService } from "../../agile.js";
import { releaseDiagnosticDetailSchema } from "../../release-diagnostics.js";
import { planReleaseDeployCallback } from "../../release-publish.js";
import type { RunStoreLike } from "../../store.js";

export function registerInternalReleaseRoutes(app: FastifyInstance, deps: {
  agile: AgileService;
  store: RunStoreLike;
  releaseTokens: () => readonly string[];
  agileErrorReply: (reply: FastifyReply, error: unknown) => FastifyReply;
}) {
  const { agile, store, agileErrorReply } = deps;
  const releaseDetailSchema = releaseDiagnosticDetailSchema(deps.releaseTokens);
  const releaseResultSchema = z.discriminatedUnion("status", [
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1).optional(),
      status: z.literal("progress"),
      stage: z.enum(["validating", "deploying", "networking", "smoke", "verifying"]),
      detail: releaseDetailSchema,
    }).strict(),
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1).optional(),
      status: z.literal("succeeded"),
      detail: releaseDetailSchema,
      deploymentId: z.string().trim().max(200).optional(),
      url: z.string().url().max(1_000).optional(),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      image: z.string().trim().min(1).max(500),
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1).optional(),
      status: z.literal("failed"),
      detail: releaseDetailSchema,
      deploymentId: z.string().trim().max(200).optional(),
      url: z.string().url().max(1_000).optional(),
    }).strict(),
  ]);
  const rollbackResultSchema = z.discriminatedUnion("status", [
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1),
      status: z.literal("progress"),
      stage: z.enum(["validating", "deploying", "networking", "smoke", "verifying"]),
      detail: releaseDetailSchema,
    }).strict(),
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1),
      status: z.literal("succeeded"),
      detail: releaseDetailSchema,
      deploymentId: z.string().trim().max(200).optional(),
      url: z.string().url().max(1_000).optional(),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      image: z.string().trim().min(1).max(500),
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      rolledBackFromCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
      rolledBackFromDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    }).strict(),
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1),
      status: z.literal("failed"),
      detail: releaseDetailSchema,
    }).strict(),
  ]);
  /** Final-status callback for an asynchronous agile release deploy. */
  const releaseDeployResultSchema = z.discriminatedUnion("status", [
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1).optional(),
      status: z.literal("succeeded"),
      detail: releaseDetailSchema,
      deploymentId: z.string().trim().max(200).optional(),
      url: z.string().url().max(1_000).optional(),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      image: z.string().trim().min(1).max(500),
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      reviewedCommits: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(200),
    }).strict(),
    z.object({
      deliveryId: z.string().trim().min(8).max(120),
      attempt: z.number().int().min(1).optional(),
      status: z.literal("failed"),
      detail: releaseDetailSchema,
      deploymentId: z.string().trim().max(200).optional(),
      url: z.string().url().max(1_000).optional(),
    }).strict(),
  ]);

  /**
   * Internal final-status callback for asynchronous (HTTP 202) release deploys,
   * mirroring `POST /api/internal/runs/:id/release-result`. Authenticated with the
   * deploy webhook token (or the internal token).
   *
   * The callback is matched against the **exact current attempt** (delivery id +
   * attempt + a still-`pending` record). Retries reuse the delivery id, so a late
   * callback for a previous attempt is rejected with `RELEASE_ATTEMPT_STALE` and an
   * audit row, and can never overwrite the newer attempt; a duplicate callback for
   * the current attempt stays idempotent (`{ ok: true }`, no write).
   */
  app.post<{ Params: { id: string } }>("/api/internal/agile/releases/:id/release-result", { config: { internalAuth: "release" } }, async (request, reply) => {
    const parsed = releaseDeployResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid release result", details: parsed.error.issues });
    const actorId = `deploy-system:${parsed.data.deliveryId}`;
    try {
      const release = await agile.getRelease([], request.params.id, true);
      const current = release.deploy ?? null;
      const plan = planReleaseDeployCallback({
        current,
        deliveryId: parsed.data.deliveryId,
        attempt: parsed.data.attempt,
        status: parsed.data.status,
        detail: parsed.data.detail,
        deploymentId: parsed.data.deploymentId,
        url: parsed.data.url,
        ...(parsed.data.status === "succeeded"
          ? {
              commit: parsed.data.commit,
              image: parsed.data.image,
              imageDigest: parsed.data.imageDigest,
              reviewedCommits: parsed.data.reviewedCommits,
            }
          : {}),
        now: new Date().toISOString(),
      });
      if (plan.kind === "reject") {
        // A stale/unsolicited callback is audited but changes no state.
        if (plan.audit && current) {
          await agile.recordReleaseDeployRejection({ releaseId: release.id, actorId, detail: plan.message, deploy: current });
        }
        return reply.code(plan.status).send({
          error: plan.message,
          code: plan.code,
          ...(plan.attempt === undefined ? {} : { attempt: plan.attempt }),
        });
      }
      if (plan.kind === "duplicate") return { ok: true, release };
      const settled = await agile.settleReleaseDeployResult({
        releaseId: release.id,
        action: plan.action,
        actorId,
        deploy: plan.deploy,
      });
      if (!settled.applied) {
        // A concurrent writer won the race. A stale attempt is rejected + audited;
        // a same-verdict winner is an idempotent duplicate. The stored record is
        // authoritative either way — it is never overwritten.
        const stored = settled.release.deploy ?? null;
        if (settled.rejected === "stale_attempt") {
          await agile.recordReleaseDeployRejection({ releaseId: release.id, actorId, detail: "部署回调因 attempt 已过期而被拒绝", deploy: stored ?? plan.deploy });
          return reply.code(409).send({
            error: "Release callback attempt is stale",
            code: "RELEASE_ATTEMPT_STALE",
            ...(stored?.attempt === undefined ? {} : { attempt: stored.attempt }),
          });
        }
        if (stored && stored.status === plan.deploy.status) return { ok: true, release: settled.release };
        return reply.code(409).send({ error: `Release deploy is already ${stored?.status ?? "unknown"}`, code: "RELEASE_ALREADY_FINAL" });
      }
      return { ok: true, release: settled.release };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  /** Authenticated progress/final callback for production rollback attempts. */
  app.post<{ Params: { id: string } }>("/api/internal/runs/:id/rollback-result", { config: { internalAuth: "release" } }, async (request, reply) => {
    const parsed = rollbackResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid rollback result", details: parsed.error.issues });
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const current = run.rollback;
    if (!current || current.deliveryId !== parsed.data.deliveryId) {
      return reply.code(409).send({ error: "Rollback delivery id does not match", code: "ROLLBACK_DELIVERY_MISMATCH" });
    }
    if (current.attempt !== parsed.data.attempt) {
      return reply.code(409).send({ error: "Rollback callback attempt is stale", code: "ROLLBACK_ATTEMPT_STALE", attempt: current.attempt });
    }
    if (parsed.data.status === "progress") {
      if (current.status !== "triggered" && current.status !== "publishing") {
        return reply.code(409).send({ error: `Rollback is already ${current.status}`, code: "ROLLBACK_ALREADY_FINAL" });
      }
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.rollback_progress",
        message: parsed.data.detail ?? parsed.data.stage,
        at: new Date().toISOString(),
        meta: { deliveryId: current.deliveryId, attempt: current.attempt, stage: parsed.data.stage },
      }, { deliveryId: `rollback-progress:${current.deliveryId}:${current.attempt}:${parsed.data.stage}` });
      return { ok: true, rollback: current, progress: parsed.data.stage };
    }
    if (current.status === parsed.data.status) return { ok: true, rollback: current };
    if (current.status !== "triggered" && current.status !== "publishing") {
      return reply.code(409).send({ error: `Rollback is already ${current.status}`, code: "ROLLBACK_ALREADY_FINAL" });
    }
    if (parsed.data.status === "succeeded"
      && (parsed.data.commit !== current.commit || parsed.data.imageDigest !== current.imageDigest)) {
      return reply.code(409).send({ error: "Rollback result does not match the immutable target", code: "ROLLBACK_DIGEST_MISMATCH" });
    }
    const rollback: RunRollbackRecord = {
      ...current,
      status: parsed.data.status,
      finishedAt: new Date().toISOString(),
      detail: parsed.data.detail,
      ...(parsed.data.status === "succeeded" ? {
        deploymentId: parsed.data.deploymentId,
        url: parsed.data.url,
        image: parsed.data.image,
        imageDigest: parsed.data.imageDigest,
        rolledBackFromCommit: parsed.data.rolledBackFromCommit,
        rolledBackFromDigest: parsed.data.rolledBackFromDigest,
      } : {}),
    };
    const result = await store.updateRunGuarded(run.id, (latest) => latest.rollback?.deliveryId === current.deliveryId
      && latest.rollback.attempt === current.attempt
      && (latest.rollback.status === "triggered" || latest.rollback.status === "publishing")
      ? { allow: true as const }
      : { allow: false as const, code: "ROLLBACK_STATE_CHANGED", message: "回滚状态已变化" }, { rollback });
    if (!result.ok) return reply.code(409).send({ error: result.message, code: result.code });
    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: rollback.status === "succeeded" ? "run.rollback_succeeded" : "run.rollback_failed",
      message: rollback.status === "succeeded" ? "production 回滚完成" : `回滚失败：${rollback.detail ?? "未知原因"}`,
      at: rollback.finishedAt!,
      meta: { ...rollback },
    }, { deliveryId: `rollback-callback:${rollback.deliveryId}:${rollback.attempt}` });
    return { ok: true, rollback };
  });

  /** Authenticated final-status callback for asynchronous (HTTP 202) publishers. */
  app.post<{ Params: { id: string } }>("/api/internal/runs/:id/release-result", { config: { internalAuth: "release" } }, async (request, reply) => {
    const parsed = releaseResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid release result", details: parsed.error.issues });
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const current = run.release;
    if (!current || current.deliveryId !== parsed.data.deliveryId) {
      return reply.code(409).send({ error: "Release delivery id does not match", code: "RELEASE_DELIVERY_MISMATCH" });
    }
    if ((parsed.data.attempt !== undefined && parsed.data.attempt !== current.attempt)
      || (parsed.data.attempt === undefined && current.attempt > 1)) {
      return reply.code(409).send({ error: "Release callback attempt is stale", code: "RELEASE_ATTEMPT_STALE", attempt: current.attempt });
    }
    if (parsed.data.status === "succeeded" && parsed.data.commit !== current.commit) {
      return reply.code(409).send({ error: "Release callback commit does not match the requested commit", code: "RELEASE_COMMIT_MISMATCH" });
    }
    if (parsed.data.status === "succeeded" && current.environment === "production"
      && (!current.expectedImageDigest || parsed.data.imageDigest !== current.expectedImageDigest)) {
      return reply.code(409).send({ error: "Production image digest does not match the staged digest", code: "RELEASE_DIGEST_MISMATCH" });
    }
    if (parsed.data.status === "progress") {
      if (current.status !== "triggered" && current.status !== "publishing") {
        return reply.code(409).send({ error: `Release is already ${current.status}`, code: "RELEASE_ALREADY_FINAL" });
      }
      const progressMessages: Record<typeof parsed.data.stage, string> = {
        validating: "正在校验工作区与审核提交",
        deploying: "正在执行受控部署脚本",
        networking: "正在准备隔离的冒烟检查网络",
        smoke: "正在执行健康检查与业务冒烟测试",
        verifying: "正在校验不可变镜像摘要",
      };
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.release_progress",
        message: progressMessages[parsed.data.stage],
        at: new Date().toISOString(),
        meta: {
          deliveryId: current.deliveryId,
          attempt: current.attempt,
          stage: parsed.data.stage,
          ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
        },
      }, { deliveryId: `release-progress:${current.deliveryId}:${current.attempt}:${parsed.data.stage}` });
      return { ok: true, release: current, progress: parsed.data.stage };
    }
    if (current.status === parsed.data.status) {
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: current.status === "succeeded" ? "run.release_succeeded" : "run.release_failed",
        message: current.status === "succeeded" ? `代码已发布到 ${current.environment}` : `发布失败：${current.detail ?? "未知原因"}`,
        at: current.finishedAt ?? new Date().toISOString(),
        meta: { ...current },
      }, { deliveryId: `release-callback:${current.deliveryId}` });
      return { ok: true, release: current };
    }
    if (current.status !== "triggered" && current.status !== "publishing") {
      return reply.code(409).send({ error: `Release is already ${current.status}`, code: "RELEASE_ALREADY_FINAL" });
    }
    const release: RunReleaseRecord = {
      ...current,
      status: parsed.data.status,
      finishedAt: new Date().toISOString(),
      detail: parsed.data.detail,
      ...(parsed.data.deploymentId ? { deploymentId: parsed.data.deploymentId } : {}),
      ...(parsed.data.url ? { url: parsed.data.url } : {}),
      ...(parsed.data.status === "succeeded"
        ? { image: parsed.data.image, imageDigest: parsed.data.imageDigest }
        : {}),
    };
    const result = await store.updateRunGuarded(run.id, (latest) => latest.release?.deliveryId === current.deliveryId
      && (latest.release.status === "triggered" || latest.release.status === "publishing")
      ? { allow: true as const }
      : { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "发布状态已变化" }, { release });
    if (!result.ok) return reply.code(409).send({ error: result.message, code: result.code });
    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: release.status === "succeeded" ? "run.release_succeeded" : "run.release_failed",
      message: release.status === "succeeded" ? `代码已发布到 ${release.environment}` : `发布失败：${release.detail ?? "未知原因"}`,
      at: release.finishedAt!,
      meta: { ...release },
    }, { deliveryId: `release-callback:${release.deliveryId}` });
    return { ok: true, release };
  });
}
