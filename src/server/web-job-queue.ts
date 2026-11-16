import { notifyQueuedJob } from "./job-notification.js";
import type { Run } from "../shared/types.js";
import { newId } from "./db.js";
import { workerRefusalDisposition } from "./worker-refusal.js";
import { RELEASE_DEPLOY_STALE_MS } from "./release-publish.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import { readReleaseTimeoutObservation, syncReleaseTimeoutAlerts } from "./release-timeout-alerts.js";
import type { WebServices } from "./web-services.js";

export function createWebJobQueue(services: WebServices) {
  const {
    JOB_STALE_MS,
    agile, alerts, app, db, identities, jobQueue, requireCredentials, store, vault, workerRequest,
  } = services;

  // ---------------------------------------------------------------- job queue (REL-002)


  /**
   * Credentials for a run outside a request context (job recovery has no session).
   * Credentials may live under the internal user id or its legacy owner key, so
   * both are tried before giving up (AT-REL-002).
   */
  async function jobCredentialsFor(run: Run): Promise<{ developer: string; reviewer: string } | undefined> {
    const candidates = [run.ownerId];
    const legacy = await identities.legacyOwnerFor(run.ownerId).catch(() => undefined);
    if (legacy) candidates.push(legacy);
    for (const key of candidates) {
      const credentials = requireCredentials({
        developer: vault.get(key, run.developer.provider),
        reviewer: vault.get(key, run.reviewer.provider),
      });
      if (credentials) return credentials;
    }
    return undefined;
  }

  /** Persist first; a notification makes the Worker drain durable jobs in order. */
  async function dispatchJob(
    run: Run,
    checks: string[],
    payload: Record<string, unknown>,
    credentials: { developer: string; reviewer: string },
  ) {
    if (!jobQueue) throw new Error("Job queue unavailable (PostgreSQL store required)");
    const jobId = newId("job");
    const kind = "run";
    await jobQueue.createJob({ id: jobId, runId: run.id, kind, payload: { ...payload, checks } });
    await store.appendEvent({
      runId: run.id, round: run.round, source: "system", type: "run.queued",
      message: "任务已进入持久队列，等待 Worker 按顺序领取", at: new Date().toISOString(),
    });
    try {
      await notifyQueuedJob({
        wake: () => workerRequest("/jobs/wake", { method: "POST", body: "{}" }),
        legacyPush: async () => {
          await jobQueue!.reserveJob(jobId);
          return workerRequest("/jobs", {
            method: "POST",
            body: JSON.stringify({ run, checks, credentials, jobId, ...payload }),
          });
        },
      });
      return { jobId, accepted: true as const };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (workerRefusalDisposition(error) === "queue") {
        // REL-002 / AUD-05: stay queued instead of failing the run, and release the
        // reservation right away so the job can be claimed as soon as a slot frees.
        await jobQueue.releaseReservation(jobId, "web-dispatch", String(code));
        await store.appendEvent({
          runId: run.id,
          round: run.round,
          source: "system",
          type: "run.queued",
          message: "Worker 当前繁忙，任务保持在队列中等待领取",
          at: new Date().toISOString(),
        });
        return { jobId, accepted: false as const };
      }
      await jobQueue.finishJobAsSystem(jobId, "failed", serverDiagnosticMessage(error, { credentials: Object.values(credentials), limit: 500 }));
      throw error;
    }
  }

  /** Re-queues jobs whose worker stopped heartbeating (worker restart, AT-REL-002/003). */
  async function requeueStaleJobs() {
    if (!jobQueue) return;
    try {
      const requeued = await jobQueue.requeueStaleJobs(JOB_STALE_MS);
      if (requeued.length > 0) {
        app.log.warn({ requeued }, "re-queued stale jobs after worker heartbeat loss");
        alerts.raise({
          key: "jobs_requeued",
          severity: "warning",
          message: "Worker 心跳超时，未完成任务已重新入队等待领取",
          details: { count: requeued.length, jobs: requeued.slice(0, 10) },
        });
      }
    } catch (error) {
      app.log.error({ error: serverDiagnosticMessage(error) }, "stale job requeue failed");
    }
  }

  /**
   * AUD-P1 bounded verification: an asynchronous release deploy whose callback
   * never arrived is marked `failed` after the timeout, so the operator can see
   * the real outcome and explicitly retry instead of waiting forever.
   */
  async function expireStaleReleaseDeploys() {
    try {
      const expired = await agile.expireStaleReleaseDeploys({ timeoutMs: RELEASE_DEPLOY_STALE_MS });
      if (expired.length > 0) {
        app.log.warn({ expired }, "release deploy callback timed out; attempt marked failed and retryable");
      }
      try {
        syncReleaseTimeoutAlerts(alerts, await readReleaseTimeoutObservation(db));
      } catch (error) {
        // A failed aggregate read cannot erase the positive expiry evidence.
        if (expired.length > 0) syncReleaseTimeoutAlerts(alerts, { outstanding: expired.length });
        throw error;
      }
    } catch (error) {
      app.log.error({ error: serverDiagnosticMessage(error) }, "stale release deploy expiry failed");
    }
  }


  return { jobCredentialsFor, dispatchJob, requeueStaleJobs, expireStaleReleaseDeploys };
}

export type WebJobQueue = ReturnType<typeof createWebJobQueue>;
