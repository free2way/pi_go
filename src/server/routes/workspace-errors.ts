import type { AlertManager } from "../alerts.js";
import { isStorageFailure } from "../request-errors.js";
import { serverDiagnosticMessage } from "../server-diagnostics.js";
import { WorkspaceError } from "../workspaces.js";

/** Maps a WorkspaceError / storage failure to an HTTP status + body (shared by
 * the workspace routes and the run-preflight, which must not touch `reply`). */
export function classifyWorkspaceError(error: unknown, alerts: Pick<AlertManager, "raise">): { status: number; body: Record<string, unknown> } {
  if (error instanceof WorkspaceError) return { status: error.status, body: { error: serverDiagnosticMessage(error.message), code: serverDiagnosticMessage(error.code) } };
  const raw = String((error as Error)?.message ?? error);
  const message = serverDiagnosticMessage(raw);
  // AT-REL-005: a database outage is reported as storage degradation, not as a
  // confusing workspace error.
  if (isStorageFailure(raw)) {
    alerts.raise({ key: "storage_failure", severity: "critical", message: "存储不可用：工作区操作无法完成", details: { error: message.slice(0, 200) } });
    return { status: 503, body: { error: `存储不可用：${message.slice(0, 200)}`, code: "STORAGE_UNAVAILABLE" } };
  }
  return { status: 503, body: { error: `Workspace operation failed: ${message}` } };
}
