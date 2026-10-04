/**
 * B6 — pure formatting for the cleanup UI. The v0.22 mismatch was a wording bug:
 * the batch confirmation promised "worktree 保留" while the server deleted the
 * run directory. Keeping the confirmation text and the outcome labels here (and
 * tested without React) makes the UI state exactly what the request will do.
 */

export type CleanupStorage = "removed" | "kept";

/** Confirmation for the batch cleanup action; mirrors the `deleteRunDirectory` intent. */
export function batchCleanupConfirmMessage(input: { count: number; deleteRunDirectory: boolean }): string {
  const heading = `清理选中的 ${input.count} 个已结束任务？`;
  return input.deleteRunDirectory
    ? `${heading}\n\n将删除：运行记录与制品；同时删除服务器上的运行目录/worktree。`
    : `${heading}\n\n将删除：运行记录与制品；服务器上的运行目录/worktree 将保留。`;
}

/** Confirmation for the sidebar "cleanup finished runs" action. */
export function cleanupFinishedConfirmMessage(input: { olderThanDays: number; deleteRunDirectory: boolean }): string {
  const heading = `清理 ${input.olderThanDays} 天前已结束（通过/失败/取消/需人工）的任务？`;
  return input.deleteRunDirectory
    ? `${heading}\n\n将删除：运行记录、事件与制品；同时删除服务器上的运行目录/worktree。`
    : `${heading}\n\n将删除：运行记录、事件与制品；服务器上的运行目录/worktree 将保留。`;
}

/** Per-run label for the post-action summary. */
export function cleanupStorageLabel(storage?: CleanupStorage): string {
  if (storage === "removed") return "已删除运行目录";
  if (storage === "kept") return "保留运行目录";
  return "运行目录状态未知";
}

/** Aggregate line for the post-action summary. */
export function summarizeCleanupStorage(results: Array<{ storage?: CleanupStorage }>): string {
  const removed = results.filter((result) => result.storage === "removed").length;
  const kept = results.filter((result) => result.storage === "kept").length;
  return `运行目录：已删除 ${removed} 个，保留 ${kept} 个`;
}

/** Per-run detail lines, bounded so a 50-run batch alert stays readable. */
export function cleanupStorageDetailLines(results: Array<{ runId: string; storage?: CleanupStorage }>, limit = 10): string[] {
  return results
    .slice(0, limit)
    .map((result) => `${result.runId.slice(0, 12)}：${cleanupStorageLabel(result.storage)}`);
}
