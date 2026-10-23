import type { AlertManager } from "./alerts.js";
import { syncStorageAlerts, type WorkspaceStorageStatus } from "./storage-alerts.js";

/** Detection must not depend on a browser, health probe or a healthy database. */
export function createInfrastructureAlertSweeper(options: {
  alerts: AlertManager;
  database: () => Promise<unknown>;
  worker: () => Promise<unknown>;
  storage: () => Promise<unknown>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;

  async function bounded<T>(observe: () => Promise<T>): Promise<T> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(observe),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Infrastructure observation timed out")), 5_000);
          deadline.unref?.();
        }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
  }

  async function sweep() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await Promise.all([
        bounded(options.database).then(() => {
          if (!stopped) options.alerts.clear("database_unavailable");
        }, () => {
          if (!stopped) options.alerts.raise({ key: "database_unavailable", severity: "critical", message: "数据库不可用，运行及事件读写暂停" });
        }),
        (async () => {
          try {
            const worker = await bounded(options.worker);
            if (!worker || typeof worker !== "object" || !("activeJobs" in worker)
              || !Number.isSafeInteger(worker.activeJobs) || Number(worker.activeJobs) < 0) throw new Error("Invalid Worker health");
            if (stopped) return;
            options.alerts.clear("worker_unreachable");
          } catch {
            if (!stopped) options.alerts.raise({ key: "worker_unreachable", severity: "critical", message: "无法连接 Worker，任务执行暂停" });
            return;
          }
          // Unknown storage is not healthy storage: preserve the last known
          // disk condition, but do not misclassify it as a Worker outage.
          try {
            const storage = await bounded(options.storage);
            if (!stopped) syncStorageAlerts(options.alerts, storage as WorkspaceStorageStatus);
          } catch { /* A failed observation cannot establish recovery. */ }
        })(),
      ]);
    } finally { inFlight = false; }
  }

  return {
    sweep,
    start() {
      if (timer || stopped) return;
      void sweep();
      timer = setInterval(() => { void sweep(); }, 60_000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
