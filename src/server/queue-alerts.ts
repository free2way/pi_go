import type { AlertManager } from "./alerts.js";
import type { Queryable } from "./db.js";

export interface QueueObservation {
  pending: number;
  stale: number;
  queued: number;
  oldestQueuedAt: string | null;
}

/** Aggregate in the database: a limited mixed sample could hide a condition. */
export async function readQueueObservation(db: Queryable, staleAfterMs: number, now = Date.now()): Promise<QueueObservation> {
  const cutoff = new Date(now - staleAfterMs).toISOString();
  const row = (await db.query(`SELECT COUNT(*) AS pending,
    COUNT(CASE WHEN state = 'claimed' THEN 1 END) AS stale,
    COUNT(CASE WHEN state = 'queued' THEN 1 END) AS queued,
    MIN(CASE WHEN state = 'queued' THEN created_at END) AS oldest_queued_at
    FROM jobs WHERE attempts < 5 AND (state = 'queued'
      OR (state = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < $1)))`, [cutoff])).rows[0];
  if (!row || [row.pending, row.stale, row.queued].some((value) =>
    !["number", "string"].includes(typeof value) || String(value).trim() === "")) throw new Error("Invalid queue observation");
  const result = { pending: Number(row.pending), stale: Number(row.stale), queued: Number(row.queued), oldestQueuedAt: row.oldest_queued_at as string | null };
  if (!validObservation(result, now)) throw new Error("Invalid queue observation");
  return result;
}

function validObservation(queue: QueueObservation | undefined, now: number): queue is QueueObservation {
  return Boolean(queue && [queue.pending, queue.stale, queue.queued].every((n) => Number.isSafeInteger(n) && n >= 0)
    && queue.pending === queue.stale + queue.queued
    && (queue.queued === 0 ? queue.oldestQueuedAt === null : typeof queue.oldestQueuedAt === "string"
      && Number.isFinite(Date.parse(queue.oldestQueuedAt)) && Date.parse(queue.oldestQueuedAt) <= now));
}

/** Reconcile only a successful aggregate observation. */
export function syncQueueAlerts(
  alerts: AlertManager,
  queue: QueueObservation | undefined,
  staleAfterMs: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || !validObservation(queue, now)) return;
  const stale = queue.stale;
  if (stale > 0) {
    alerts.raise({ key: "queue_stale", severity: "warning", message: "存在因 Worker 中断而未完成的任务，正在等待重领", details: { count: stale } });
  } else {
    alerts.clear("queue_stale");
  }
  const oldestWaitMs = queue.oldestQueuedAt === null ? 0 : now - Date.parse(queue.oldestQueuedAt);
  if (queue.queued >= 20 || oldestWaitMs >= staleAfterMs) {
    alerts.raise({ key: "queue_backlog", severity: "warning", message: "任务队列积压，等待 Worker 领取", details: { pending: queue.queued, oldestWaitMs } });
  } else {
    alerts.clear("queue_backlog");
  }
}
