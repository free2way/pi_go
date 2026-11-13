import type { AlertManager } from "./alerts.js";

export interface WorkspaceStorageStatus {
  state: "ok" | "low" | "critical" | "unknown";
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
}

/** Reconcile mutually exclusive disk conditions from a successful observation. */
export function syncStorageAlerts(alerts: AlertManager, storage: WorkspaceStorageStatus | undefined): void {
  // A failed probe is not evidence of recovery. Preserve the known condition.
  if (!storage) return;
  if (storage.state === "unknown") {
    alerts.raise({
      key: "disk_unknown",
      severity: "critical",
      message: "无法确认工作区磁盘状态，已停止接收新任务",
      details: {},
    });
    return;
  }
  if (!Number.isFinite(storage.freeBytes) || storage.freeBytes < 0
    || !Number.isFinite(storage.totalBytes) || storage.totalBytes <= 0
    || !Number.isFinite(storage.freePercent) || storage.freePercent < 0 || storage.freePercent > 100
    || !["ok", "low", "critical"].includes(storage.state)) return;
  alerts.clear("disk_unknown");
  if (storage.state !== "low") alerts.clear("disk_low");
  if (storage.state !== "critical") alerts.clear("disk_critical");
  if (storage.state === "ok") return;
  alerts.raise({
    key: `disk_${storage.state}`,
    severity: storage.state === "critical" ? "critical" : "warning",
    message: storage.state === "critical" ? "工作区磁盘空间严重不足，已停止接收新任务" : "工作区磁盘空间偏低",
    details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
  });
}
