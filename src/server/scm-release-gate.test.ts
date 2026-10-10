import { describe, expect, it } from "vitest";
import { planRemoteSyncGate } from "./scm-release-gate.js";

const status = (present: boolean) => ({
  provider: "github" as const,
  remote: "https://github.com/org/repo.git",
  branch: "main",
  localHead: "local",
  remoteHead: "remote",
  relation: "ahead" as const,
  ahead: 1,
  behind: 0,
  checkedAt: "now",
  requiredCommit: "merge",
  requiredCommitPresent: present,
});

describe("production remote sync gate", () => {
  it("allows a required merge commit already reachable from remote even if newer local work is ahead", () => {
    expect(planRemoteSyncGate([{ workspaceId: "ws", commit: "merge", status: status(true) }])).toEqual({ kind: "ready" });
  });

  it("blocks missing, unreachable, and failed remote evidence", () => {
    const result = planRemoteSyncGate([
      { workspaceId: "a", commit: "one", status: status(false) },
      { workspaceId: "b", commit: "two", error: "origin unavailable" },
    ]);
    expect(result).toMatchObject({ kind: "blocked", code: "SCM_REMOTE_SYNC_REQUIRED" });
    if (result.kind === "blocked") expect(result.blocked).toHaveLength(2);
  });
});
