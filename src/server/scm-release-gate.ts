import type { WorkspaceRemoteStatus } from "../shared/types.js";

export interface RemoteCommitEvidence {
  workspaceId: string;
  commit: string;
  status?: WorkspaceRemoteStatus;
  error?: string;
}

export type RemoteSyncGate =
  | { kind: "ready" }
  | { kind: "blocked"; code: "SCM_REMOTE_SYNC_REQUIRED"; message: string; blocked: RemoteCommitEvidence[] };

/** Production only consumes commits proven reachable from the remote default branch. */
export function planRemoteSyncGate(evidence: RemoteCommitEvidence[]): RemoteSyncGate {
  const blocked = evidence.filter((item) => item.status?.requiredCommitPresent !== true);
  if (blocked.length === 0) return { kind: "ready" };
  return {
    kind: "blocked",
    code: "SCM_REMOTE_SYNC_REQUIRED",
    message: "production 发布前必须先把所有合并提交推送到远程默认分支",
    blocked,
  };
}
