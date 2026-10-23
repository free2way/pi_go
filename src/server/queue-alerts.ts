import type { AlertManager } from "./alerts.js";
import type { JobRecord } from "./run-store-pg.js";

type PendingJob = Pick<JobRecord, "state" | "createdAt">;

/** Reconcile only a successful, bounded pending-jobs observation. */
export function syncQueueAlerts(
  alerts: AlertManager,
  jobs: readonly PendingJob[] | undefined,
  staleAfterMs: number,
  now = Date.now(),
): void {
  if (!jobs || !Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0
    || jobs.some((job) => !["queued", "claimed"].includes(job.state)
      || !Number.isFinite(Date.parse(job.createdAt)) || Date.parse(job.createdAt) > now)) return;
  // listPendingJobs supplies only queued jobs and claims with stale heartbeats.
  const stale = jobs.filter((job) => job.state === "claimed").length;
  if (stale > 0) {
    alerts.raise({ key: "queue_stale", severity: "warning", message: "存在因 Worker 中断而未完成的任务，正在等待重领", details: { count: stale } });
  } else {
    alerts.clear("queue_stale");
  }
  const queued = jobs.filter((job) => job.state === "queued");
  const oldestWaitMs = queued.reduce((max, job) => Math.max(max, now - Date.parse(job.createdAt)), 0);
  if (queued.length >= 20 || oldestWaitMs >= staleAfterMs) {
    alerts.raise({ key: "queue_backlog", severity: "warning", message: "任务队列积压，等待 Worker 领取", details: { sampledPending: queued.length, oldestWaitMs } });
  } else {
    alerts.clear("queue_backlog");
  }
}
