import { readRun } from "./store.js";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { releasesStoryBlocks, storyBlockReleaseNote } from "../shared/run-state.js";
import { AgileError } from "./agile.js";
import { planRemoteSyncGate, type RemoteCommitEvidence } from "./scm-release-gate.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import { registerAgileRoutes } from "./routes/agile.js";
import { classifyWorkspaceError } from "./routes/workspace-errors.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import type { WebServices } from "./web-services.js";
import type { RunAdmission } from "./run-admission.js";

export function createWorkspaceAgileRoutes(services: WebServices) {
  const {
    agile, alerts, app, auth, db, demoMode, effectiveReleaseConfig, identities, ownerKeysFor,
    realRunsEnabled, requestLocale, runActions, runCreations, store, tooManyRequests, workerRequest,
    workspaces, workspacesEnabled,
  } = services;

  function workspaceErrorReply(reply: FastifyReply, error: unknown) {
    const { status, body } = classifyWorkspaceError(error, alerts);
    return reply.code(status).send(body);
  }

  async function productionRemoteGate(
    request: FastifyRequest,
    targets: Array<{ workspaceId?: string | null; commit?: string | null }>,
    isAdmin: boolean,
  ) {
    const evidence: RemoteCommitEvidence[] = [];
    for (const target of targets) {
      const workspaceId = target.workspaceId ?? "";
      const commit = target.commit ?? "";
      if (!workspaceId || !commit) {
        evidence.push({ workspaceId, commit, error: "缺少工作区或合并提交" });
        continue;
      }
      try {
        const status = await workspaces.remoteStatus(ownerKeysFor(request), workspaceId, { isAdmin, requiredCommit: commit });
        evidence.push({ workspaceId, commit, status });
      } catch (error) {
        evidence.push({ workspaceId, commit, error: serverDiagnosticMessage(error, { limit: 300 }) });
      }
    }
    return planRemoteSyncGate(evidence);
  }


  function registerWorkspaceApi() {
    registerWorkspaceRoutes(app, {
      currentUser: (request) => auth.user(request),
      ownerKeysFor,
      isAdmin: (userId) => identities.isAdmin(userId),
      workspaces,
      workerRequest,
      realRunsEnabled,
      workspacesEnabled,
      runActions,
      tooManyRequests,
      workspaceErrorReply,
    });
  }

  function agileErrorReply(reply: FastifyReply, error: unknown) {
    if (error instanceof AgileError) return reply.code(error.status).send({ error: error.message, code: error.code });
    return workspaceErrorReply(reply, error);
  }

  /**
   * Sprint 3 write-back helper: after a run mutation, converge the derived status
   * of every story linked to it. A run that just reached a terminal state also
   * releases any run-level story block it held (a terminal run must not deadlock
   * the board) and records why as a run event. Never throws — a planning-table
   * hiccup must not break the run route that triggered it.
   */
  async function reconcileStoryForRun(runId: string) {
    try {
      const run = await readRun(store, runId);
      if (run && releasesStoryBlocks(run.state)) {
        const released = await agile.releaseStoryBlocksForTerminalRun(runId, run.state);
        if (released.length > 0) {
          await store.appendEvent({
            runId,
            round: run.round,
            source: "system",
            type: "run.story_blocks_released",
            message: storyBlockReleaseNote(run.state),
            at: new Date().toISOString(),
            meta: { state: run.state, storyIds: released },
          });
        }
      }
      await agile.reconcileRun(runId);
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error), runId }, "story status reconcile failed");
    }
  }

  function registerAgileApi(startRealRun: RunAdmission["startRealRun"]) {

    registerAgileRoutes(app, {
      currentUser: (request) => auth.user(request),
      ownerKeysFor,
      isAdmin: (userId) => identities.isAdmin(userId),
      agile,
      db,
      workspaces,
      store,
      demoMode,
      runCreations,
      tooManyRequests,
      agileErrorReply,
      requestLocale,
      startRealRun,
      productionRemoteGate,
      effectiveReleaseConfig,
    });
  }

  return { registerWorkspaceApi, registerAgileApi, agileErrorReply, productionRemoteGate, reconcileStoryForRun };
}

export type WorkspaceAgileRoutes = ReturnType<typeof createWorkspaceAgileRoutes>;
