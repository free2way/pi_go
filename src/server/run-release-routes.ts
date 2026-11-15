import { type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Run, RunReleaseRecord, RunRollbackRecord } from "../shared/types.js";
import { newId } from "./db.js";
import { mergeRestoreFields, type MergeResult } from "../shared/merge.js";
import { buildDeployHookPayload } from "./run-merge.js";
import { coordinateApprovedMerge } from "./merge-approval.js";
import { planReleaseStart, sameReleaseAttempt } from "./run-release.js";
import { buildRollbackPayload, planRollbackStart, sameRollbackAttempt } from "./run-rollback.js";
import { executeRelease } from "./release-execution.js";
import type { WebServices } from "./web-services.js";
import type { WorkspaceAgileRoutes } from "./workspace-agile-routes.js";

export function registerRunReleaseRoutes(
  services: WebServices,
  workspace: Pick<WorkspaceAgileRoutes,
    "productionRemoteGate"
  >,
) {
  const {
    acceptanceSnapshotFor, app, auth, effectiveReleaseConfig, identities, ownerKeysFor, runActions,
    store, tooManyRequests, workerRequest, workspaces,
  } = services;
  const {
    productionRemoteGate,
  } = workspace;

  const completedMergeSchema = z.object({ confirm: z.literal(true), note: z.string().trim().max(2_000).optional() });
  const releaseSchema = z.object({
    environment: z.enum(["staging", "production"]),
    confirm: z.literal(true),
    retry: z.boolean().optional(),
  });
  const rollbackSchema = z.object({
    confirm: z.literal(true),
    reason: z.string().trim().min(3).max(2_000),
    retry: z.boolean().optional(),
  }).strict();
  async function mergeCompletedRun(request: FastifyRequest, run: Run, userId: string, note?: string) {
    const now = new Date().toISOString();
    const acceptance = await acceptanceSnapshotFor(run, {
      acceptedAt: now,
      acceptedBy: userId,
      note,
      acknowledgedOpenFindings: false,
    });
    const targetBranch = run.workspaceId
      ? await workspaces.get(ownerKeysFor(request), run.workspaceId, { isAdmin: true }).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
      : undefined;
    return coordinateApprovedMerge(store, {
      run,
      token: newId("mergetok"),
      targetBranch: targetBranch ?? null,
      startedAt: now,
      approval: {
        acceptedAt: now,
        acceptedBy: userId,
        summary: note ? `管理员批准合并：${note}` : "管理员批准合并审核通过的代码",
        note: note ?? null,
        acceptance,
      },
      callWorker: (branch) =>
        workerRequest<MergeResult>(`/runs/${encodeURIComponent(run.id)}/merge`, {
          method: "POST",
          body: JSON.stringify({ ownerId: run.ownerId, repository: run.repository, branch: run.branch, targetBranch: branch ?? undefined, message: note }),
        }),
    });
  }

  /**
   * REL-PUBLISH: explicit merge gate for a normally completed run. This avoids
   * forcing a successful run through `reopen -> needs_human` merely to merge it.
   */
  app.post<{ Params: { id: string } }>("/api/runs/:id/merge", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const actionLimit = runActions.check(auth.user(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const parsed = completedMergeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const user = auth.user(request);
    if (!(await identities.isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以合并审核通过的代码", code: "ADMIN_REQUIRED" });
    if (run.state !== "completed") return reply.code(409).send({ error: "只有审核完成的任务可以进入合并步骤", code: "RUN_NOT_MERGE_READY" });
    if (run.mode !== "real") return reply.code(409).send({ error: "演示任务没有可合并的真实工作区", code: "REAL_RUN_REQUIRED" });
    if (run.merge) return run;

    const outcome = await mergeCompletedRun(request, run, user.id, parsed.data.note?.trim());
    if (outcome.kind === "conflict") return reply.code(outcome.status).send({ error: outcome.message, code: outcome.code });
    if (outcome.kind === "worker-error") {
      const restore = mergeRestoreFields(outcome);
      return reply.code(outcome.status).send({
        error: outcome.error,
        code: outcome.code,
        ...(outcome.conflictingPaths ? { conflictingPaths: outcome.conflictingPaths } : {}),
        ...restore,
      });
    }
    if (outcome.kind === "record-failed") {
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code, merge: outcome.merge });
    }
    return outcome.run;
  });

  /**
   * REL-PUBLISH: explicit, durable release. The `publishing` record is committed
   * before the hook call; retries reuse its delivery id so the receiver can
   * safely de-duplicate a request whose original response was lost.
   */
  app.post<{ Params: { id: string } }>("/api/runs/:id/publish", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const actionLimit = runActions.check(auth.user(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const parsed = releaseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "发布需要有效环境名和 confirm=true", code: "RELEASE_CONFIRM_REQUIRED", details: parsed.error.issues });
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const user = auth.user(request);
    const isAdmin = await identities.isAdmin(user.id);
    if (!isAdmin) return reply.code(403).send({ error: "仅管理员可以发布代码", code: "ADMIN_REQUIRED" });

    if (parsed.data.environment === "production") {
      const remoteGate = await productionRemoteGate(request, [{ workspaceId: run.workspaceId, commit: run.merge?.commit }], isAdmin);
      if (remoteGate.kind === "blocked") {
        return reply.code(409).send({ error: remoteGate.message, code: remoteGate.code, blocked: remoteGate.blocked });
      }
    }

    const releaseRuntime = effectiveReleaseConfig(parsed.data.environment);
    const deployPlan = releaseRuntime.deployPlan;
    if (!deployPlan.configured) return reply.code(409).send({ error: deployPlan.reason, code: "RELEASE_NOT_CONFIGURED" });
    if (deployPlan.kind === "unsupported") return reply.code(409).send({ error: deployPlan.reason, code: "RELEASE_CONFIG_INVALID" });
    if (deployPlan.kind === "webhook" && !releaseRuntime.webhookToken) {
      return reply.code(409).send({ error: "Webhook 发布必须在发布设置或环境变量中配置 Token", code: "RELEASE_AUTH_NOT_CONFIGURED" });
    }
    if (deployPlan.kind === "webhook" && !releaseRuntime.callbackOrigin) {
      return reply.code(409).send({ error: "Webhook 发布必须配置 PiGO 公网地址以接收异步结果回调", code: "RELEASE_CALLBACK_NOT_CONFIGURED" });
    }

    const decision = planReleaseStart({
      run,
      environment: parsed.data.environment,
      requestedBy: user.id,
      now: new Date().toISOString(),
      kind: deployPlan.kind,
      retry: parsed.data.retry,
    });
    if (decision.kind === "conflict") return reply.code(decision.status).send({ error: decision.message, code: decision.code });
    if (decision.kind === "already-succeeded") return run;

    const previous = run.release;
    const claim = await store.updateRunGuarded(run.id, (current) => {
      if (current.state !== "completed" || current.merge?.commit !== run.merge?.commit) {
        return { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "任务或合并 commit 已变化，请刷新后重试" };
      }
      if (!previous && current.release) return { allow: false as const, code: "RELEASE_IN_PROGRESS", message: "已有其他发布请求" };
      if (previous && (
        current.release?.deliveryId !== previous.deliveryId
        || current.release?.attempt !== previous.attempt
        || current.release?.status !== previous.status
      )) return { allow: false as const, code: "RELEASE_IN_PROGRESS", message: "发布状态已由其他请求更新" };
      return { allow: true as const };
    }, { release: decision.release });
    if (!claim.ok) return reply.code(409).send({ error: claim.message, code: claim.code });

    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: "run.release_started",
      message: `开始发布 ${decision.release.commit.slice(0, 10)} 到 ${decision.release.environment}`,
      at: decision.release.startedAt,
      meta: { ...decision.release },
    }, { deliveryId: `release-start:${decision.release.deliveryId}:${decision.release.attempt}` }).catch(() => undefined);

    const callbackUrl = releaseRuntime.callbackOrigin
      ? `${releaseRuntime.callbackOrigin.replace(/\/$/, "")}/api/internal/runs/${encodeURIComponent(run.id)}/release-result`
      : undefined;
    const execution = await executeRelease(
      deployPlan,
      buildDeployHookPayload({ run, merge: run.merge!, release: decision.release, callbackUrl }),
      { deliveryId: decision.release.deliveryId, webhookToken: releaseRuntime.webhookToken || undefined },
    );
    const finishedAt = new Date().toISOString();
    const release: RunReleaseRecord = {
      ...decision.release,
      status: execution.status === "succeeded" ? "succeeded" : execution.status === "triggered" ? "triggered" : "failed",
      detail: execution.detail,
      ...(execution.httpStatus === undefined ? {} : { httpStatus: execution.httpStatus }),
      ...(execution.status === "triggered" ? {} : { finishedAt }),
    };
    const finalized = await store.updateRunGuarded(run.id, (current) => sameReleaseAttempt(current, decision.release)
      ? { allow: true as const }
      : { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "发布执行完成，但记录已被其他请求更新" }, { release });
    if (!finalized.ok) {
      // A fast asynchronous publisher may POST its callback before the original
      // HTTP 202 response reaches us. Never overwrite or report that valid final
      // result as a failure merely because the callback won the CAS race.
      const latest = store.getRun(run.id);
      if (latest?.release?.deliveryId === release.deliveryId
        && (latest.release.status === "succeeded" || latest.release.status === "failed")) return latest;
      return reply.code(503).send({ error: finalized.message, code: finalized.code, deliveryId: release.deliveryId });
    }

    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: release.status === "failed" ? "run.release_failed" : release.status === "triggered" ? "run.release_triggered" : "run.release_succeeded",
      message: release.status === "failed"
        ? `发布失败：${release.detail ?? "未知原因"}`
        : release.status === "triggered"
          ? "部署系统已接收发布请求，等待最终结果"
          : `代码已发布到 ${release.environment}`,
      at: finishedAt,
      meta: { ...release },
    }, { deliveryId: `release-result:${release.deliveryId}:${release.attempt}` }).catch(() => undefined);
    return finalized.run;
  });

  /**
   * DEVOPS-ROLLBACK: restore a previously verified production artifact. The
   * request names only the run; commit/image/digest are copied from that run's
   * successful production release and revalidated by the executor.
   */
  app.post<{ Params: { id: string } }>("/api/runs/:id/rollback", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const actionLimit = runActions.check(auth.user(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const parsed = rollbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "回滚需要原因和 confirm=true", code: "ROLLBACK_CONFIRM_REQUIRED", details: parsed.error.issues });
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const user = auth.user(request);
    if (!(await identities.isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以回滚 production", code: "ADMIN_REQUIRED" });

    const releaseRuntime = effectiveReleaseConfig("production");
    const deployPlan = releaseRuntime.deployPlan;
    if (!deployPlan.configured) return reply.code(409).send({ error: deployPlan.reason, code: "RELEASE_NOT_CONFIGURED" });
    if (deployPlan.kind !== "webhook") return reply.code(409).send({ error: "受控回滚只支持 Webhook Executor", code: "ROLLBACK_EXECUTOR_REQUIRED" });
    if (!releaseRuntime.webhookToken || !releaseRuntime.callbackOrigin) {
      return reply.code(409).send({ error: "回滚需要配置 Webhook Token 和 PiGO 回调地址", code: "RELEASE_AUTH_NOT_CONFIGURED" });
    }

    const decision = planRollbackStart({
      run,
      requestedBy: user.id,
      reason: parsed.data.reason,
      now: new Date().toISOString(),
      retry: parsed.data.retry,
    });
    if (decision.kind === "conflict") return reply.code(decision.status).send({ error: decision.message, code: decision.code });

    const previous = run.rollback;
    const claim = await store.updateRunGuarded(run.id, (current) => {
      if (current.release?.status !== "succeeded"
        || current.release.environment !== "production"
        || current.release.commit !== decision.rollback.commit
        || current.release.imageDigest !== decision.rollback.imageDigest) {
        return { allow: false as const, code: "ROLLBACK_TARGET_CHANGED", message: "目标 production 发布证据已变化，请刷新后重试" };
      }
      if (!previous && current.rollback) return { allow: false as const, code: "ROLLBACK_IN_PROGRESS", message: "已有其他回滚请求" };
      if (previous && (current.rollback?.deliveryId !== previous.deliveryId
        || current.rollback?.attempt !== previous.attempt
        || current.rollback?.status !== previous.status)) {
        return { allow: false as const, code: "ROLLBACK_IN_PROGRESS", message: "回滚状态已由其他请求更新" };
      }
      return { allow: true as const };
    }, { rollback: decision.rollback });
    if (!claim.ok) return reply.code(409).send({ error: claim.message, code: claim.code });

    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: "run.rollback_started",
      message: `开始回滚 production 到 ${decision.rollback.commit.slice(0, 10)}`,
      at: decision.rollback.startedAt,
      meta: { ...decision.rollback },
    }, { deliveryId: `rollback-start:${decision.rollback.deliveryId}:${decision.rollback.attempt}` }).catch(() => undefined);

    const callbackUrl = `${releaseRuntime.callbackOrigin.replace(/\/$/, "")}/api/internal/runs/${encodeURIComponent(run.id)}/rollback-result`;
    const execution = await executeRelease(
      deployPlan,
      buildRollbackPayload({ run, rollback: decision.rollback, callbackUrl }),
      { deliveryId: decision.rollback.deliveryId, webhookToken: releaseRuntime.webhookToken },
    );
    const finishedAt = new Date().toISOString();
    const rollback: RunRollbackRecord = {
      ...decision.rollback,
      status: execution.status === "succeeded" ? "succeeded" : execution.status === "triggered" ? "triggered" : "failed",
      detail: execution.detail,
      ...(execution.httpStatus === undefined ? {} : { httpStatus: execution.httpStatus }),
      ...(execution.status === "triggered" ? {} : { finishedAt }),
    };
    const finalized = await store.updateRunGuarded(run.id, (current) => sameRollbackAttempt(current, decision.rollback)
      ? { allow: true as const }
      : { allow: false as const, code: "ROLLBACK_STATE_CHANGED", message: "回滚执行完成，但记录已被其他请求更新" }, { rollback });
    if (!finalized.ok) {
      const latest = store.getRun(run.id);
      if (latest?.rollback?.deliveryId === rollback.deliveryId
        && (latest.rollback.status === "succeeded" || latest.rollback.status === "failed")) return latest;
      return reply.code(503).send({ error: finalized.message, code: finalized.code, deliveryId: rollback.deliveryId });
    }
    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: rollback.status === "failed" ? "run.rollback_failed" : rollback.status === "triggered" ? "run.rollback_triggered" : "run.rollback_succeeded",
      message: rollback.status === "failed" ? `回滚失败：${rollback.detail ?? "未知原因"}` : rollback.status === "triggered" ? "执行器已接收回滚请求" : "production 回滚完成",
      at: finishedAt,
      meta: { ...rollback },
    }, { deliveryId: `rollback-result:${rollback.deliveryId}:${rollback.attempt}` }).catch(() => undefined);
    return finalized.run;
  });

}
