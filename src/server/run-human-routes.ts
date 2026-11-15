import { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { ReviewScope, Run } from "../shared/types.js";
import { newId } from "./db.js";
import { cleanupRunDirectory, keptRunStorageOutcome } from "./run-cleanup.js";
import { type ApprovePlan, approveEventMeta, planApprove } from "./approve.js";
import { conflictReplyFor } from "./request-errors.js";
import { appendHumanNote } from "./run-notes.js";
import { resumeDeadlinePatch } from "./run-deadline-base.js";
import { batchItemFailure, batchItemSuccess, parseBatchRunIds, summarizeBatch, MAX_BATCH_RUN_IDS, type BatchItemOutcome } from "./batch-runs.js";
import { mergeConflictReply, mergeRestoreFields, type MergeResult } from "../shared/merge.js";
import { planMergeGate, type MergeRecord } from "./run-merge.js";
import { coordinateApprovedMerge } from "./merge-approval.js";
import { planReopen, reopenEventMeta } from "./run-reopen.js";
import { isActiveRelease } from "./run-release.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import { runStateSchema } from "./routes/internal/run-schemas.js";
import type { WebServices } from "./web-services.js";
import type { WebJobQueue } from "./web-job-queue.js";
import type { WorkspaceAgileRoutes } from "./workspace-agile-routes.js";

export function createRunHumanRoutes(
  services: WebServices,
  queue: Pick<WebJobQueue, "dispatchJob">,
  workspace: Pick<WorkspaceAgileRoutes,
    "reconcileStoryForRun"
  >,
) {
  const {
    TERMINAL_RUN_STATES, acceptanceSnapshotFor, app, auth, db, identities, internalToken, ownerKeysFor,
    realRunsEnabled, runActions, runDirectoryCleaner, store, tooManyRequests, vault, vaultKeyFor,
    workerRequest, workspaces,
  } = services;
  const {
    dispatchJob,
  } = queue;
  const {
    reconcileStoryForRun,
  } = workspace;

  const approveSchema = z.object({
    mode: z.enum(["continue", "accept"]).optional(),
    note: z.string().trim().max(2_000).optional(),
    acknowledgeOpenFindings: z.boolean().optional(),
    // Review scope for the continued round: "blocking" records medium/low findings
    // without letting them block completion; absent keeps the run's current value.
    reviewScope: z.enum(["all", "blocking"]).optional(),
    // A2: admin option — merge the run branch into the workspace default branch
    // before completing. Absent/`false` keeps the plain accept behavior unchanged.
    mergeIntoWorkspace: z.boolean().optional(),
  });
  const rejectSchema = z.object({ reason: z.string().trim().max(2_000).optional() });

  /**
   * RUN-006: `mode: "continue"` sends a run stopped at needs_human back to
   * development for another round using the existing human-resume job intent
   * (AUD-05 `payload.resume`), so the six open findings are actually worked on
   * instead of being silently accepted. Mirrors the worker/credentials guards of
   * `dispatchFollowupJob`; on a rejected job the run returns to needs_human.
   *
   * A2/B3: the core is extracted from the HTTP adapter so the batch route can run
   * it per run and shape an individual outcome (no Fastify reply involved).
   */
  type ContinueResult =
    | { ok: true; run: Run }
    | { ok: false; status: number; code?: string; error: string };

  async function startContinue(
    run: Run,
    options: { note?: string; plan: Extract<ApprovePlan, { decision: "continue" }>; userId: string; vaultKey: string; reviewScope?: ReviewScope },
  ): Promise<ContinueResult> {
    if (run.mode !== "real") return { ok: false, status: 409, code: "RUN_NOT_RESUMABLE", error: "只有真实任务支持「继续开发」" };
    if (!realRunsEnabled || !internalToken) return { ok: false, status: 503, code: "REAL_RUNNER_NOT_AVAILABLE", error: "Real agent execution is disabled" };
    const developerKey = vault.get(options.vaultKey, run.developer.provider);
    const reviewerKey = vault.get(options.vaultKey, run.reviewer.provider);
    if (!developerKey || !reviewerKey) {
      return { ok: false, status: 403, code: "PERSONAL_CREDENTIALS_REQUIRED", error: "该任务所用模型的 provider 凭据缺失，请在「模型与凭据」页配置" };
    }
    const credentials = { developer: developerKey, reviewer: reviewerKey };

    const now = new Date().toISOString();
    const round = run.round + 1;
    const summary = options.note ? `人工选择继续开发：${options.note}` : `人工选择继续开发：第 ${round} 轮处理未解决意见`;
    let updated: Run;
    try {
      updated = await store.updateRun(run.id, {
        state: "developing",
        round,
        maxRounds: Math.max(run.maxRounds, round),
        summary,
        // RESUME: fresh deadline window so the continued round is not aborted
        // against the run's original createdAt window.
        ...resumeDeadlinePatch(now),
        // 需求历史: keep the operator's written requirement, not just the event meta.
        ...(options.note
          ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_continue", note: options.note, by: options.userId }) }
          : {}),
        // Review scope: only written when the operator chose one; absent keeps the
        // run's existing value (default "all").
        ...(options.reviewScope ? { reviewScope: options.reviewScope } : {}),
      });
    } catch (error) {
      const conflict = conflictReplyFor(error);
      if (conflict) return { ok: false, status: conflict.status, code: conflict.code, error: conflict.message };
      throw error;
    }
    await store.appendEvent({
      runId: run.id,
      round,
      source: "system",
      type: "run.approved",
      message: summary,
      at: now,
      meta: {
        ...approveEventMeta(options.plan, options.userId),
        ...(options.reviewScope ? { reviewScope: options.reviewScope } : {}),
      },
    });

    try {
      await dispatchJob(updated, run.checks.map((check) => check.command), { resume: { instruction: options.note } }, credentials);
      credentials.developer = "";
      credentials.reviewer = "";
      return { ok: true, run: store.getRun(run.id) ?? updated };
    } catch (error) {
      const message = serverDiagnosticMessage(error, { credentials: Object.values(credentials) });
      credentials.developer = "";
      credentials.reviewer = "";
      await store.updateRun(run.id, { state: "needs_human", summary: "Worker 拒绝任务，保持人工处理" });
      await store.appendEvent({
        runId: run.id,
        round,
        source: "system",
        type: "run.resume_failed",
        message: `Worker 拒绝任务：${message}`,
        at: new Date().toISOString(),
      });
      return { ok: false, status: 503, error: message };
    }
  }

  async function dispatchContinueJob(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    run: Run,
    options: { note?: string; plan: Extract<ApprovePlan, { decision: "continue" }>; userId: string; reviewScope?: ReviewScope },
  ) {
    const openFindings = options.plan.openFindings;
    const result = await startContinue(run, { ...options, vaultKey: vaultKeyFor(request) });
    if (!result.ok) return reply.code(result.status).send({ error: result.error, ...(result.code ? { code: result.code } : {}) });
    return reply.code(201).send({ ...result.run, openFindings });
  }


  function registerRunApprovalRoute() {

    app.post<{ Params: { id: string } }>("/api/runs/:id/approve", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const actionLimit = runActions.check(auth.user(request).id);
      if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
      const parsed = approveSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const run = store.getRun(request.params.id, ownerKeysFor(request));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以审批", code: "RUN_NOT_APPROVABLE" });
      const user = auth.user(request);
      const note = parsed.data.note?.trim();
      const plan = planApprove({
        mode: parsed.data.mode,
        acknowledgeOpenFindings: parsed.data.acknowledgeOpenFindings,
        findings: run.findings,
      });

      // RUN-006: never silently accept open findings — make the operator acknowledge.
      if (plan.decision === "conflict") {
        return reply.code(plan.status).send({ error: plan.message, code: plan.code, openFindings: plan.openFindings });
      }
      if (plan.decision === "continue") {
        return dispatchContinueJob(request, reply, run, { note, plan, userId: user.id, reviewScope: parsed.data.reviewScope });
      }

      const now = new Date().toISOString();
      // A2: optional admin merge. When the flag is absent nothing changes.
      const mergeGate = planMergeGate({ requested: parsed.data.mergeIntoWorkspace === true, isAdmin: await identities.isAdmin(user.id) });
      if (mergeGate.kind === "forbidden") return reply.code(403).send({ error: mergeGate.message, code: mergeGate.code });

      // B2: durable acceptance snapshot (findings, diff identity, checks, usage).
      const acceptance = await acceptanceSnapshotFor(run, { acceptedAt: now, acceptedBy: user.id, note, acknowledgedOpenFindings: plan.acknowledged });
      const summary = note ? `人工审批通过：${note}` : "人工审批通过，交付已确认";

      let merge: MergeRecord | undefined;
      let updated: Run;
      if (mergeGate.kind === "ready") {
        // B1: two-phase, idempotent approve-and-merge. Git is only touched after the
        // merge is durably claimed (phase 1 CAS), and a DB failure while recording
        // the result is compensated by a replay on later reads (phase 2).
        const targetBranch = run.workspaceId
          ? await workspaces.get(ownerKeysFor(request), run.workspaceId).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
          : undefined;
        const outcome = await coordinateApprovedMerge(store, {
          run,
          token: newId("mergetok"),
          targetBranch: targetBranch ?? null,
          startedAt: now,
          approval: { acceptedAt: now, acceptedBy: user.id, summary, note: note ?? null, acceptance },
          callWorker: (branch) =>
            workerRequest<MergeResult>(`/runs/${encodeURIComponent(run.id)}/merge`, {
              method: "POST",
              body: JSON.stringify({ ownerId: run.ownerId, repository: run.repository, branch: run.branch, targetBranch: branch ?? undefined, message: note }),
            }),
        });
        if (outcome.kind === "conflict") return reply.code(outcome.status).send({ error: outcome.message, code: outcome.code });
        if (outcome.kind === "worker-error") {
          // R: forward the workspace-restore state (`restored`/`restoreError`) on
          // every merge failure, not just conflicts, so the UI can tell the operator
          // whether the workspace is back on its pre-merge branch or needs manual care.
          if (outcome.code === "MERGE_CONFLICT") {
            const restore = mergeRestoreFields(outcome);
            const conflict = mergeConflictReply(outcome.conflictingPaths ?? [], restore);
            return reply.code(conflict.status).send({
              error: conflict.message,
              code: conflict.code,
              conflictingPaths: conflict.conflictingPaths,
              ...restore,
            });
          }
          return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code, ...mergeRestoreFields(outcome) });
        }
        if (outcome.kind === "record-failed") {
          // The worker already merged: the durable `committed_unrecorded` intent
          // makes a later read converge the record instead of staying silent.
          return reply.code(outcome.status).send({
            error: `工作区已合并，但合并记录写入失败，将在后续读取时自动补偿：${outcome.error}`,
            code: outcome.code,
            merge: outcome.merge,
          });
        }
        merge = outcome.merge;
        updated = outcome.run;
      } else {
        try {
          updated = await store.updateRun(run.id, {
            state: "completed",
            approvedAt: now,
            approvedBy: user.id,
            summary,
            acceptance,
            ...(note
              ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_accept", note, by: user.id }) }
              : {}),
          });
        } catch (error) {
          const conflict = conflictReplyFor(error);
          if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
          throw error;
        }
      }

      // The `run.merged` event is appended (idempotently, keyed by the commit) by
      // the merge coordinator; only the approval event is appended here.
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.approved",
        message: summary,
        at: now,
        meta: { ...approveEventMeta(plan, user.id), acceptance, ...(merge ? { merge } : {}) },
      });

      // Publishing is deliberately not implicit here. A separate administrator
      // action records a durable release attempt before invoking any external hook.
      await reconcileStoryForRun(run.id);
      return { ...updated, acceptedOpenFindings: plan.openFindings, acceptance, ...(merge ? { merge } : {}) };
    });

  }

  function registerRunManagementRoutes() {
    app.post<{ Params: { id: string } }>("/api/runs/:id/reject", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const actionLimit = runActions.check(auth.user(request).id);
      if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
      const parsed = rejectSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const run = store.getRun(request.params.id, ownerKeysFor(request));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以拒绝", code: "RUN_NOT_REJECTABLE" });
      const user = auth.user(request);
      const now = new Date().toISOString();
      const reason = parsed.data.reason?.trim();
      let updated: Run;
      try {
        updated = await store.updateRun(run.id, {
          state: "cancelled",
          summary: reason ? `人工拒绝交付：${reason}` : "人工拒绝交付，任务已终止",
          ...(reason
            ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "reject", note: reason, by: user.id }) }
            : {}),
        });
      } catch (error) {
        const conflict = conflictReplyFor(error);
        if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
        throw error;
      }
      if (run.mode === "real") await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.rejected",
        message: reason ? `人工拒绝交付：${reason}` : "人工拒绝交付，任务已终止",
        at: now,
        meta: { rejectedBy: user.id },
      });
      return updated;
    });

    /**
     * B1: reopen a delivered run. Moves `completed` back to `needs_human` (guarded
     * state-machine edge), records `run.reopened` plus the operator's note, and
     * leaves the run branch/worktree intact. Admins may reopen any run; the owner
     * must pass `confirm: true`.
     */
    const reopenSchema = z.object({
      note: z.string().trim().max(2_000).optional(),
      confirm: z.boolean().optional(),
    });

    app.post<{ Params: { id: string } }>("/api/runs/:id/reopen", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const actionLimit = runActions.check(auth.user(request).id);
      if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
      const parsed = reopenSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const user = auth.user(request);
      const isAdminUser = await identities.isAdmin(user.id);
      let run = store.getRun(request.params.id, ownerKeysFor(request));
      const isOwner = Boolean(run);
      // Admins may reopen a run they do not own.
      if (!run && isAdminUser) run = store.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "Run not found" });

      if (isActiveRelease(run)) return reply.code(409).send({ error: "发布仍在进行，不能重新打开任务", code: "RELEASE_IN_PROGRESS" });
      if (run.merge || run.release) {
        return reply.code(409).send({ error: "已进入合并/发布链路的任务不可重新开发；请基于新需求创建新的 Run", code: "RELEASED_RUN_IMMUTABLE" });
      }

      const plan = planReopen({ state: run.state, isAdmin: isAdminUser, isOwner, confirm: parsed.data.confirm });
      if (!plan.allowed) return reply.code(plan.status).send({ error: plan.message, code: plan.code });

      const now = new Date().toISOString();
      const note = parsed.data.note?.trim();
      const summary = note ? `重新打开任务：${note}` : "任务已重新打开，等待人工处理";
      let updated: Run;
      try {
        updated = await store.updateRun(run.id, {
          state: plan.targetState,
          summary,
          reopenedAt: now,
          reopenedBy: user.id,
          ...(note
            ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "reopen", note, by: user.id }) }
            : {}),
        });
      } catch (error) {
        const conflict = conflictReplyFor(error);
        if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
        throw error;
      }
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.reopened",
        message: summary,
        at: now,
        meta: reopenEventMeta({ reopenedBy: user.id, reason: plan.reason, note }),
      });
      await reconcileStoryForRun(run.id);
      return updated;
    });

    // GAP-04: owner-scoped (admins may pass scope=all) cleanup of finished runs and
    // their artifacts/events. Active runs are never touched.
    const cleanupSchema = z.object({
      runIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
      states: z.array(runStateSchema).max(9).optional(),
      olderThanDays: z.number().min(0).max(3_650).optional(),
      scope: z.enum(["own", "all"]).default("own"),
      dryRun: z.boolean().default(false),
      // B6: explicit on-disk intent. Defaults to true because that has been the
      // server behavior since v0.22 (the UI wording was the stale part).
      deleteRunDirectory: z.boolean().default(true),
    });

    app.post("/api/runs/cleanup", async (request, reply) => {
      const actionLimit = runActions.check(auth.user(request).id);
      if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
      const parsed = cleanupSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const user = auth.user(request);
      if (parsed.data.scope === "all" && !(await identities.isAdmin(user.id))) {
        return reply.code(403).send({ error: "仅管理员可以清理全部任务", code: "ADMIN_REQUIRED" });
      }
      let candidates: Run[];
      if (parsed.data.scope === "all") {
        const owners = (await db.query("SELECT DISTINCT owner_id FROM runs")).rows.map((row) => String(row.owner_id));
        candidates = owners.flatMap((owner) => store.listRuns(owner));
      } else {
        candidates = store.listRuns(ownerKeysFor(request));
      }
      const allowedStates = new Set(parsed.data.states ?? []);
      const idFilter = parsed.data.runIds ? new Set(parsed.data.runIds) : undefined;
      const cutoff = parsed.data.olderThanDays === undefined ? undefined : Date.now() - parsed.data.olderThanDays * 86_400_000;
      const matched = candidates.filter((run) => {
        if (!TERMINAL_RUN_STATES.has(run.state)) return false;
        if (isActiveRelease(run)) return false;
        if (allowedStates.size > 0 && !allowedStates.has(run.state)) return false;
        if (idFilter && !idFilter.has(run.id)) return false;
        if (cutoff !== undefined && new Date(run.updatedAt).getTime() > cutoff) return false;
        return true;
      });
      if (parsed.data.dryRun) {
        const storage = parsed.data.deleteRunDirectory
          ? await Promise.all(matched.map((run) => cleanupRunDirectory(run, { dryRun: true, cleaner: runDirectoryCleaner })))
          : matched.map((run) => keptRunStorageOutcome(run.id, "未请求删除运行目录（deleteRunDirectory=false）"));
        return { dryRun: true, deleteRunDirectory: parsed.data.deleteRunDirectory, matched: matched.length, runIds: matched.map((run) => run.id), storage };
      }
      const deleted: string[] = [];
      const storage: Awaited<ReturnType<typeof cleanupRunDirectory>>[] = [];
      for (const run of matched) {
        try {
          await store.deleteRun(run.id);
          deleted.push(run.id);
        } catch (error) {
          app.log.warn({ runId: run.id, error: serverDiagnosticMessage(error) }, "cleanup: failed to delete run");
          storage.push(keptRunStorageOutcome(run.id, `database deletion failed: ${serverDiagnosticMessage(error)}`));
          continue;
        }
        // Best-effort on-disk cleanup after the records are gone: a worker that is
        // unreachable (or refuses an unsafe path) only marks the run as kept.
        storage.push(parsed.data.deleteRunDirectory
          ? await cleanupRunDirectory(run, { dryRun: false, cleaner: runDirectoryCleaner })
          : keptRunStorageOutcome(run.id, "未请求删除运行目录（deleteRunDirectory=false）"));
      }
      if (deleted.length > 0) app.log.info({ actor: user.id, deleted }, "cleaned up finished runs");
      return { dryRun: false, deleteRunDirectory: parsed.data.deleteRunDirectory, deleted: deleted.length, runIds: deleted, matched: matched.length, storage };
    });

    /**
     * B3: batch continue/accept/cleanup over an explicit, bounded list of runs.
     * Owner scoped; every run gets its own outcome and partial failures are reported
     * individually. Accept requires the same open-findings acknowledgement as the
     * single-run path, and cleanup reuses the existing terminal-only semantics.
     */
    const batchSchema = z.object({
      action: z.enum(["continue", "accept", "cleanup"]),
      runIds: z.array(z.string().trim().min(1).max(120)).max(MAX_BATCH_RUN_IDS),
      note: z.string().trim().max(2_000).optional(),
      acknowledgeOpenFindings: z.boolean().optional(),
      // B6: explicit on-disk intent for cleanup. Defaults to true (today's behavior);
      // `false` keeps the run directory/worktree on the server.
      deleteRunDirectory: z.boolean().default(true),
    });

    app.post("/api/runs/batch", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const actionLimit = runActions.check(auth.user(request).id);
      if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
      const parsed = batchSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      const ids = parseBatchRunIds(parsed.data.runIds);
      if (!ids.ok) return reply.code(400).send({ error: ids.message, code: "BATCH_INVALID" });
      const user = auth.user(request);
      const note = parsed.data.note?.trim();
      const outcomes: BatchItemOutcome[] = [];

      for (const id of ids.ids) {
        const run = store.getRun(id, ownerKeysFor(request));
        if (!run) {
          outcomes.push(batchItemFailure(id, 404, "RUN_NOT_FOUND", "Run not found"));
          continue;
        }
        if (parsed.data.action === "cleanup") {
          if (!TERMINAL_RUN_STATES.has(run.state)) {
            outcomes.push(batchItemFailure(id, 409, "RUN_ACTIVE", `无法清理状态为 ${run.state} 的任务`));
            continue;
          }
          if (isActiveRelease(run)) {
            outcomes.push(batchItemFailure(id, 409, "RELEASE_IN_PROGRESS", "发布仍在进行，不能清理任务"));
            continue;
          }
          try {
            await store.deleteRun(run.id);
          } catch (error) {
            // Records could not be removed, so the directory was never touched.
            outcomes.push(batchItemFailure(id, 500, undefined, serverDiagnosticMessage(error), "kept"));
            continue;
          }
          const storage = parsed.data.deleteRunDirectory
            ? (await cleanupRunDirectory(run, { dryRun: false, cleaner: runDirectoryCleaner })).outcome
            : "kept";
          outcomes.push(batchItemSuccess(id, run.state, storage));
          continue;
        }

        if (run.state !== "needs_human") {
          outcomes.push(batchItemFailure(id, 409, "RUN_NOT_APPROVABLE", "仅「需要人工处理」的任务可以审批"));
          continue;
        }
        const plan = planApprove({
          mode: parsed.data.action === "continue" ? "continue" : "accept",
          acknowledgeOpenFindings: parsed.data.acknowledgeOpenFindings,
          findings: run.findings,
        });
        if (plan.decision === "conflict") {
          outcomes.push(batchItemFailure(id, plan.status, plan.code, plan.message));
          continue;
        }
        if (plan.decision === "continue") {
          const result = await startContinue(run, { note, plan, userId: user.id, vaultKey: vaultKeyFor(request) });
          outcomes.push(result.ok ? batchItemSuccess(id, result.run.state) : batchItemFailure(id, result.status, result.code, result.error));
          continue;
        }

        const now = new Date().toISOString();
        try {
          const acceptance = await acceptanceSnapshotFor(run, { acceptedAt: now, acceptedBy: user.id, note, acknowledgedOpenFindings: plan.acknowledged });
          await store.updateRun(run.id, {
            state: "completed",
            approvedAt: now,
            approvedBy: user.id,
            summary: note ? `人工审批通过：${note}` : "批量审批通过，交付已确认",
            acceptance,
            ...(note ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_accept", note, by: user.id }) } : {}),
          });
          await store.appendEvent({
            runId: run.id,
            round: run.round,
            source: "system",
            type: "run.approved",
            message: "批量审批通过",
            at: now,
            meta: { ...approveEventMeta(plan, user.id), acceptance, batch: true },
          });
          outcomes.push(batchItemSuccess(id, "completed"));
        } catch (error) {
          const conflict = conflictReplyFor(error);
          outcomes.push(batchItemFailure(id, conflict?.status ?? 500, conflict?.code, serverDiagnosticMessage(conflict?.message ?? error)));
        }
      }
      return summarizeBatch(parsed.data.action, outcomes);
    });

  }

  return { registerRunApprovalRoute, registerRunManagementRoutes };
}
