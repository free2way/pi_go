import { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Workspace } from "../shared/types.js";
import { syncStorageAlerts, type WorkspaceStorageStatus } from "./storage-alerts.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { preflightRunModels } from "./model-catalog.js";
import { baseRealRun } from "./real-run.js";
import { conflictReplyFor } from "./request-errors.js";
import { appendHumanNote } from "./run-notes.js";
import { resumeDeadlinePatch } from "./run-deadline-base.js";
import { isActiveRelease } from "./run-release.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import { createRunSchema, type RealRunExtra, type RealRunResult } from "./routes/create-run-schema.js";
import { classifyWorkspaceError } from "./routes/workspace-errors.js";
import type { WebServices } from "./web-services.js";
import type { WebJobQueue } from "./web-job-queue.js";
import type { WorkspaceAgileRoutes } from "./workspace-agile-routes.js";

export function createRunAdmission(
  services: WebServices,
  queue: Pick<WebJobQueue, "dispatchJob">,
  workspace: Pick<WorkspaceAgileRoutes,
    "reconcileStoryForRun"
  >,
) {
  const {
    PIPELINE_VERSION, alerts, app, auth, credentialFingerprint, demoMode, identities, internalToken,
    modelCatalog, modelDefaults, ownerKeysFor, readRunBudget, realRunsEnabled, requestLocale,
    requireCredentials, runActions, runCreations, store, tooManyRequests, vault, vaultKeyFor,
    workerRequest, workspaces,
  } = services;
  const {
    dispatchJob,
  } = queue;
  const {
    reconcileStoryForRun,
  } = workspace;

  /**
   * Real-run creation core shared by `POST /api/runs` and
   * `POST /api/stories/:id/runs`: workspace preflight, model/credential checks,
   * idempotency, run persistence and worker dispatch. Pure refactor of the
   * previously inline route code; it returns a result instead of touching `reply`
   * so both routes render the same errors and the story route can still link a run
   * whose dispatch failed.
   */
  async function startRealRun(
    request: FastifyRequest,
    input: z.infer<typeof createRunSchema>,
    extra: RealRunExtra = {},
  ): Promise<RealRunResult> {
    const user = auth.user(request);
    // WS-008: real runs may only target the user's own registered, healthy workspaces.
    // B4: a read grant may start a run against a shared workspace, so the
    // preflight refresh is allowed for read access too (the general refresh route
    // still requires write).
    let workspace: Workspace;
    try {
      workspace = await workspaces.refresh(ownerKeysFor(request), input.workspaceId!, { isAdmin: await identities.isAdmin(user.id), allowRead: true });
    } catch (error) {
      const { status, body } = classifyWorkspaceError(error, alerts);
      return { ok: false, status, body };
    }
    if (workspace.git?.dirty) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "工作区存在未提交修改，请先提交或清理后再创建真实任务",
          code: "WORKSPACE_DIRTY",
          dirtyFiles: workspace.git.dirtyFiles,
        },
      };
    }
    if (!realRunsEnabled || !internalToken) return { ok: false, status: 503, body: { error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" } };

    // AT-REL-010: stop accepting new work when the workspace disk is critical.
    const storage = await workerRequest<WorkspaceStorageStatus>("/health/storage").catch(() => undefined);
    syncStorageAlerts(alerts, storage);
    if (storage && storage.state === "critical") {
      return {
        ok: false,
        status: 507,
        body: {
          error: `磁盘空间不足（剩余 ${Math.round(storage.freeBytes / 1024 / 1024)} MB），已停止接收新任务`,
          code: "DISK_FULL",
        },
      };
    }
    // AUD-08 / AT-MODEL-008 + AUD-09 / AT-MODEL-007: preflight the exact
    // provider/model combination for every role the run will use (planner and
    // developer share the developer selection; reviewer has its own) before
    // queueing. A single provider that serves both roles is enough.
    const availability = vault.providerAvailability(vaultKeyFor(request));
    const selections = {
      developer: input.developerModel ?? modelDefaults.developer,
      reviewer: input.reviewerModel ?? modelDefaults.reviewer,
    };
    const preflight = preflightRunModels(modelCatalog, selections, availability);
    if (!preflight.ok) return { ok: false, status: 422, body: { error: preflight.message, code: preflight.code, role: preflight.role } };
    const developerEntry = preflight.roles.developer;
    const reviewerEntry = preflight.roles.reviewer;

    const credentials = requireCredentials({
      developer: vault.get(vaultKeyFor(request), developerEntry.provider),
      reviewer: vault.get(vaultKeyFor(request), reviewerEntry.provider),
    });
    if (!credentials) {
      return { ok: false, status: 403, body: { error: "所选模型的 provider 凭据不完整，请在「模型与凭据」页配置", code: "PERSONAL_CREDENTIALS_REQUIRED" } };
    }
    // GAP-01 / AT-RUN-010: an idempotency key returns the existing run instead of
    // creating a duplicate.
    if (input.idempotencyKey) {
      const existing = store.listRuns(ownerKeysFor(request)).find((item) => item.idempotencyKey === input.idempotencyKey);
      if (existing) return { ok: true, created: false, run: existing };
    }
    const run = baseRealRun({
      ...input,
      repository: workspace.rootPath,
      workspaceId: workspace.id,
      developerModel: { provider: developerEntry.provider, model: developerEntry.model },
      reviewerModel: { provider: reviewerEntry.provider, model: reviewerEntry.model },
    }, user.id);
    // GAP-01: freeze the reproducible inputs with the run.
    run.baseSha = workspace.git?.head ?? undefined;
    run.budget = extra.budget ?? readRunBudget();
    run.pipelineVersion = PIPELINE_VERSION;
    run.credentialVersions = {
      developer: credentialFingerprint(vault.get(vaultKeyFor(request), developerEntry.provider)),
      reviewer: credentialFingerprint(vault.get(vaultKeyFor(request), reviewerEntry.provider)),
    };
    if (extra.storyId) run.storyId = extra.storyId;
    // 运行时文案语言 (docs/24-i18n.md §9): the run remembers the locale it was
    // created in, so the worker writes its guard/stop text and prompts in the
    // requester's language. Additive — omitted reads as Chinese.
    run.locale = requestLocale(request);
    if (extra.maxParallel !== undefined) run.maxParallel = extra.maxParallel;
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "真实任务已创建，正在交给隔离 Pi Worker", at: new Date().toISOString() });
    try {
      await dispatchJob(run, input.checks, {}, credentials);
      credentials.developer = "";
      credentials.reviewer = "";
      return { ok: true, created: true, run };
    } catch (error) {
      const message = serverDiagnosticMessage(error, { credentials: Object.values(credentials) });
      credentials.developer = "";
      credentials.reviewer = "";
      await store.updateRun(run.id, { state: "failed", summary: message });
      await store.appendEvent({ runId: run.id, round: 1, source: "system", type: "run.failed", message: `Worker 拒绝任务：${message}`, at: new Date().toISOString() });
      return { ok: false, status: 503, body: { error: message, runId: run.id }, run };
    }
  }


  function registerRunAdmissionRoutes() {
    app.post("/api/runs", async (request, reply) => {
      const parsed = createRunSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const user = auth.user(request);
      const creationLimit = runCreations.check(user.id);
      if (!creationLimit.allowed) return tooManyRequests(reply, creationLimit.retryAfterMs);
      if (parsed.data.mode === "real") {
        const result = await startRealRun(request, parsed.data);
        if (!result.ok) return reply.code(result.status).send(result.body);
        return reply.code(result.created ? 201 : 200).send(store.getRun(result.run.id, user.id));
      }
      if (!demoMode) return reply.code(403).send({ error: "Demo mode is disabled" });
      const run = baseDemoRun(parsed.data, user.id);
      // 运行时文案语言 (docs/24-i18n.md §9): demo runs record the requester's locale too.
      run.locale = requestLocale(request);
      await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "演示任务已创建；所有 Agent 活动均为可视化演示数据", at: new Date().toISOString() });
      void runDemo(store, run.id);
      return reply.code(201).send(run);
    });

    app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
      const cancelLimit = runActions.check(auth.user(request).id);
      if (!cancelLimit.allowed) return tooManyRequests(reply, cancelLimit.retryAfterMs);
      const run = store.getRun(request.params.id, ownerKeysFor(request));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (["completed", "failed", "cancelled"].includes(run.state)) return reply.code(409).send({ error: `Cannot cancel run in ${run.state}` });
      if (run.mode === "real") await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
      try {
        await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
      } catch (error) {
        // NEW-05/NEW-08: a lost CAS race (concurrent worker callback or cancel) is a
        // clean 409, never a 500.
        const conflict = conflictReplyFor(error);
        if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
        throw error;
      }
      await store.appendEvent({ runId: run.id, round: run.round, source: "system", type: "run.cancelled", message: "任务已取消", at: new Date().toISOString() });
      await reconcileStoryForRun(run.id);
      return store.getRun(run.id, ownerKeysFor(request));
    });

    app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
      const run = store.getRun(request.params.id, ownerKeysFor(request));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (isActiveRelease(run)) return reply.code(409).send({ error: "发布仍在进行，不能删除任务", code: "RELEASE_IN_PROGRESS" });
      if (!["completed", "failed", "cancelled", "needs_human"].includes(run.state)) {
        return reply.code(409).send({ error: `Cannot delete a run in ${run.state}; cancel it first` });
      }
      await store.deleteRun(run.id);
      return reply.code(204).send();
    });

    // GAP-04 / AT-RUN-009: explicit human approval or rejection of a delivered
    // worktree. Approval carries two distinct intents: continue development for
    // another round, or accept the delivery. Accepting a run that still has open
    // review findings requires an explicit acknowledgement (RUN-006).
  }

  const resumeSchema = z.object({
    instruction: z.string().trim().max(2_000).optional(),
  });

  /** RUN-006: human-in-the-loop actions for runs stopped at needs_human. */
  async function dispatchFollowupJob(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    options: { kind: "resume"; instruction?: string } | { kind: "retry-review" },
  ) {
    const actionLimit = runActions.check(auth.user(request).id);
    if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
    const run = store.getRun(request.params.id, ownerKeysFor(request));
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (run.mode !== "real") return reply.code(409).send({ error: "只有真实任务支持人工恢复", code: "RUN_NOT_RESUMABLE" });
    if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以执行该操作", code: "RUN_NOT_RESUMABLE" });
    if (!realRunsEnabled || !internalToken) return reply.code(503).send({ error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" });
    const developerKey = vault.get(vaultKeyFor(request), run.developer.provider);
    const reviewerKey = vault.get(vaultKeyFor(request), run.reviewer.provider);
    if (!developerKey || !reviewerKey) {
      return reply.code(403).send({ error: "该任务所用模型的 provider 凭据缺失，请在「模型与凭据」页配置", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    }
    const credentials = { developer: developerKey, reviewer: reviewerKey };

    const instruction = options.kind === "resume" ? options.instruction?.trim() : undefined;
    const round = options.kind === "resume" ? run.round + 1 : run.round;
    const noteAt = new Date().toISOString();
    const updated = await store.updateRun(run.id, options.kind === "resume"
      ? {
          state: "queued",
          round,
          maxRounds: Math.max(run.maxRounds, round),
          summary: "人工恢复：等待 Worker 接收",
          // RESUME: fresh deadline window for the resumed round (see run-deadline-base).
          ...resumeDeadlinePatch(noteAt),
          // 需求历史: the resume instruction is the operator's written requirement.
          ...(instruction
            ? { humanNotes: appendHumanNote(run.humanNotes, { at: noteAt, kind: "resume", note: instruction, by: auth.user(request).id }) }
            : {}),
        }
      : {
          state: "reviewing",
          summary: "人工触发：重新审核中",
          // 同一类问题：窗口已过的任务重试审核时也会秒超时，一并给新窗口。
          ...resumeDeadlinePatch(noteAt),
        });
    await store.appendEvent({
      runId: run.id,
      round,
      source: "system",
      type: options.kind === "resume" ? "run.resumed" : "run.review_retry",
      message: options.kind === "resume"
        ? `工作区所有者恢复执行（第 ${round} 轮）`
        : "工作区所有者触发重新审核",
      at: new Date().toISOString(),
    });
    if (instruction) {
      await store.appendEvent({ runId: run.id, round, source: "system", type: "run.resume_instruction", message: `人工指令：${instruction.slice(0, 500)}`, at: new Date().toISOString() });
    }

    try {
      await dispatchJob(
        updated,
        run.checks.map((check) => check.command),
        options.kind === "resume" ? { resume: { instruction } } : { retryReview: true },
        credentials,
      );
      credentials.developer = "";
      credentials.reviewer = "";
      return reply.code(201).send(store.getRun(run.id, ownerKeysFor(request)));
    } catch (error) {
      const message = serverDiagnosticMessage(error, { credentials: Object.values(credentials) });
      credentials.developer = "";
      credentials.reviewer = "";
      await store.updateRun(run.id, { state: "needs_human", summary: "Worker 拒绝任务，保持人工处理" });
      await store.appendEvent({
        runId: run.id,
        round,
        source: "system",
        type: options.kind === "resume" ? "run.resume_failed" : "run.review_retry_failed",
        message: `Worker 拒绝任务：${message}`,
        at: new Date().toISOString(),
      });
      return reply.code(503).send({ error: message });
    }
  }


  function registerRunFollowupRoutes() {
    app.post<{ Params: { id: string } }>("/api/runs/:id/resume", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const parsed = resumeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      return dispatchFollowupJob(request, reply, { kind: "resume", instruction: parsed.data.instruction });
    });

    app.post<{ Params: { id: string } }>("/api/runs/:id/retry-review", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      return dispatchFollowupJob(request, reply, { kind: "retry-review" });
    });

  }

  return { startRealRun, registerRunAdmissionRoutes, registerRunFollowupRoutes };
}

export type RunAdmission = ReturnType<typeof createRunAdmission>;
