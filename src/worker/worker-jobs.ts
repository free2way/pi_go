import { workspaceKeyFor } from "./workspace-lock.js";
import { createQueueWake } from "./queue-wake.js";
import {
  active, workspaceLocks, workspaceLockStaleMs, diagnosticMessage, shuttingDown, maxActiveJobs,
  storageStatus,
} from "./worker-runtime.js";
import type { JobInput } from "./worker-runtime.js";
import { jobApi, activeJobLeases, postUpdate, workspaceLockHeartbeatMs } from "./worker-web-client.js";
import type { PendingJob } from "./worker-web-client.js";
import { clearModelCredentials, hasRequiredCredentials } from "../shared/run-roles.js";

export function createWorkerJobs(executeJob: (input: JobInput, controller: AbortController) => Promise<void>) {
  /**
   * GAP-05 / AT-RUN-012: jobs that could not start because another run holds the
   * workspace lock. They are not failed — they stay queued locally and are
   * retried as soon as the holder releases or its lock goes stale. The durable
   * job row is never finished here, so a worker restart re-delivers it too.
   */
  const deferredJobs = new Map<string, { input: JobInput; reason: string }>();
  let drainingDeferred = false;

  async function dispatchJob(input: JobInput, controller: AbortController) {
    if (input.jobId) {
      try {
        await jobApi.claim(input.jobId);
        activeJobLeases.set(input.run.id, input.jobId);
      } catch (error) {
        if ((error as { code?: unknown }).code === "JOB_LEASE_LOST" || (error as { status?: unknown }).status === 409) {
          active.delete(input.run.id);
          deferredJobs.delete(input.run.id);
          clearModelCredentials(input.credentials);
          console.warn(`[jobs] refusing ${input.run.id}: durable lease is held by another worker`);
          return false;
        }
        throw error;
      }
    }
    const key = workspaceKeyFor(input.run);
    let result;
    try {
      result = await workspaceLocks.acquire(key, input.run.id);
    } catch (error) {
      if (input.jobId) {
        await jobApi.release(input.jobId, "Workspace lock acquisition failed").catch(() => undefined);
        activeJobLeases.delete(input.run.id);
      }
      throw error;
    }
    if (!result.acquired) {
      // Do not run, do not finish the job: leave it for the drain loop / durable
      // requeue. `active` is cleared so capacity accounting stays honest.
      active.delete(input.run.id);
      const holder = result.holder;
      const reason = holder
        ? `工作区「${key}」正被运行 ${holder.runId} 占用（心跳 ${new Date(holder.heartbeatAt).toISOString()}）`
        : `工作区「${key}」已被占用`;
      deferredJobs.set(input.run.id, { input, reason });
      await postUpdate(input.run.id, {
        event: {
          round: input.run.round,
          source: "system",
          type: "workspace.locked",
          message: `保持排队：${reason}。等待其结束或锁过期（约 ${Math.round(workspaceLockStaleMs / 1000)} 秒）后自动重试。`,
          meta: { workspace: key, holderRunId: holder?.runId, holderWorkerId: holder?.workerId, staleSeconds: Math.round(workspaceLockStaleMs / 1000) },
        },
      }).catch((error) => console.warn(`[jobs] could not record workspace.locked for ${input.run.id}: ${diagnosticMessage(error, Object.values(input.credentials))}`));
      if (input.jobId) {
        await jobApi.release(input.jobId, reason).catch((error) => console.warn(`[jobs] could not release deferred lease: ${diagnosticMessage(error, Object.values(input.credentials))}`));
        activeJobLeases.delete(input.run.id);
      }
      console.warn(`[jobs] deferring ${input.run.id}: ${diagnosticMessage(reason, Object.values(input.credentials))}`);
      return false;
    }

    deferredJobs.delete(input.run.id);
    if (result.reclaimedStale) {
      await postUpdate(input.run.id, {
        event: {
          round: input.run.round,
          source: "system",
          type: "workspace.lock_reclaimed",
          message: `工作区「${key}」上一个持有者（运行 ${result.reclaimedStale.runId}）的锁已过期，本次运行已接管。`,
          meta: { workspace: key, staleRunId: result.reclaimedStale.runId, staleWorkerId: result.reclaimedStale.workerId },
        },
      }).catch(() => undefined);
    }
    const touch = setInterval(() => { void result.handle.touch().catch(() => undefined); }, workspaceLockHeartbeatMs);
    touch.unref?.();
    try {
      await executeJob(input, controller);
    } finally {
      clearInterval(touch);
      await result.handle.release().catch(() => undefined);
      activeJobLeases.delete(input.run.id);
      void drainDeferredJobs();
      pendingJobWake.wake();
    }
    return true;
  }

  /** Retries locally deferred jobs whose workspace lock has freed up. */
  async function drainDeferredJobs() {
    // P1: a shutting-down worker never starts deferred work either.
    if (shuttingDown) return 0;
    if (drainingDeferred || deferredJobs.size === 0) return 0;
    drainingDeferred = true;
    let started = 0;
    try {
      for (const [runId, entry] of [...deferredJobs]) {
        if (active.has(runId)) { deferredJobs.delete(runId); continue; }
        if (active.size >= maxActiveJobs) break;
        if (workspaceLocks.isHeld(workspaceKeyFor(entry.input.run))) continue;
        const controller = new AbortController();
        active.set(runId, controller);
        deferredJobs.delete(runId);
        started += 1;
        void dispatchJob(entry.input, controller).catch((error) => {
          active.delete(runId);
          console.error(`[jobs] deferred dispatch failed for ${runId}: ${diagnosticMessage(error, Object.values(entry.input.credentials))}`);
        });
      }
    } finally {
      drainingDeferred = false;
    }
    if (started > 0) console.warn(`[jobs] resumed ${started} deferred job(s) after the workspace lock freed up`);
    return started;
  }

  /** Picks up jobs that were never delivered or whose worker died mid-run (REL-002). */
  async function reclaimPendingJobs() {
    // P1: a shutting-down worker never claims new work.
    if (shuttingDown) return 0;
    if (active.size >= maxActiveJobs) return 0;
    const storage = await storageStatus();
    if (storage.state === "critical" || storage.state === "unknown") {
      console.warn(`[jobs] storage ${storage.state}; skipping reclaim until inspection succeeds`);
      return 0;
    }
    let jobs: PendingJob[] = [];
    try {
      jobs = await jobApi.lease(maxActiveJobs - active.size);
    } catch (error) {
      console.warn(`[jobs] reclaim failed: ${diagnosticMessage(error)}`);
      return 0;
    }
    let started = 0;
    for (const job of jobs) {
      if (shuttingDown || active.size >= maxActiveJobs) break;
      if (active.has(job.run.id)) continue;
      if (!hasRequiredCredentials(job.run, job.credentials)) {
        console.warn(`[jobs] skipping ${job.jobId}: credentials unavailable`);
        continue;
      }
      const controller = new AbortController();
      active.set(job.run.id, controller);
      started += 1;
      // AUD-05: only a job that actually started is a recovery; a queued job that
      // never ran begins normally (and creates its clone).
      void dispatchJob({
        run: job.run,
        checks: job.checks,
        credentials: job.credentials,
        jobId: job.jobId,
        recovery: job.wasStarted,
        ...(job.resume ? { resume: job.resume } : {}),
        ...(job.retryReview ? { retryReview: true } : {}),
      }, controller).catch((error) => {
        active.delete(job.run.id);
        console.error(`[jobs] reclaimed job ${job.jobId} failed to start: ${diagnosticMessage(error, Object.values(job.credentials))}`);
      });
    }
    if (started > 0) console.warn(`[jobs] admitted ${started} durable queue job(s)`);
    return started;
  }

  const pendingJobWake = createQueueWake(reclaimPendingJobs, (error) => {
    console.warn(`[jobs] queue notification failed: ${diagnosticMessage(error)}`);
  });

  return { dispatchJob, drainDeferredJobs, pendingJobWake };
}

export type WorkerJobs = ReturnType<typeof createWorkerJobs>;
