import type {
  ScmAuthMode,
  ScmProvider,
  WorkspacePushResult,
  WorkspaceRemoteRelation,
  WorkspaceRemoteStatus,
} from "../shared/types.js";
import { inspectExportHistory, type ExportFinding } from "../shared/repository-export-policy.mjs";
import { redactWorkerDiagnostic } from "./diagnostic-redaction.js";

export interface WorkspaceScmCredentialInput {
  provider?: ScmProvider;
  authMode?: ScmAuthMode;
  username?: string | null;
  token?: string | null;
}

export interface ScmGitResult { code: number; stdout: string; stderr: string }
export type ScmGitExec = (args: string[], env?: Record<string, string>) => Promise<ScmGitResult>;

export class WorkspaceScmError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export type WorkspacePushPolicyViolation = ExportFinding;

/** The push and CI paths share one fail-closed history scanner. */
export async function inspectWorkspacePushPolicy(input: {
  before: WorkspaceRemoteStatus;
  git: ScmGitExec;
  credentials?: readonly string[];
}): Promise<WorkspacePushPolicyViolation[]> {
  try {
    return await inspectExportHistory({ git: input.git, head: input.before.localHead, base: input.before.remoteHead, credentials: input.credentials });
  } catch {
    throw new WorkspaceScmError("SCM_EXPORT_POLICY_FAILED", "Unable to scan complete export history; push is blocked");
  }
}

export function redactRemoteUrl(value: string, secrets: readonly string[] = []): string {
  try {
    const parsed = new URL(value);
    const hadCredentials = Boolean(parsed.username || parsed.password);
    parsed.username = "";
    parsed.password = "";
    const safe = redactWorkerDiagnostic(parsed.toString(), secrets);
    return hadCredentials ? safe.replace(`${parsed.protocol}//`, `${parsed.protocol}//***@`) : safe;
  } catch {
    return redactWorkerDiagnostic(value.replace(/\/\/[^@/\s]*@/g, "//***@"), secrets);
  }
}

export function detectScmProvider(remote: string): ScmProvider {
  const lower = remote.toLowerCase();
  if (/(^|[.@/:])github\.com(?=[:/]|$)/.test(lower)) return "github";
  if (/(^|[.@/:])gitlab\.com(?=[:/]|$)/.test(lower) || /(^|[.@/:])gitlab(?=[:/.-]|$)/.test(lower)) return "gitlab";
  return "generic";
}

function cleanHttpRemote(remote: string): string | undefined {
  try {
    const parsed = new URL(remote);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isHttpRemote(remote: string): boolean {
  return cleanHttpRemote(remote) !== undefined;
}

/**
 * A non-interactive worker cannot fall back to Git's username/password prompt.
 * Fail before the export scan/push with an actionable product error instead of
 * leaking Git's low-level "terminal prompts disabled" message to the UI.
 */
function requirePushAuthentication(remote: string, credential?: WorkspaceScmCredentialInput): void {
  if (!isHttpRemote(remote)) return;
  if (credential?.authMode === "https_token" && credential.token?.trim()) return;
  throw new WorkspaceScmError(
    "SCM_CREDENTIAL_REQUIRED",
    "This HTTPS remote requires a saved access token with repository write permission",
  );
}

/** Injects an HTTP auth header through Git's environment config, never argv/URL. */
export function scmAuthEnvironment(remote: string, credential?: WorkspaceScmCredentialInput): Record<string, string> {
  if (credential?.authMode !== "https_token" || !credential.token) return {};
  const cleanRemote = cleanHttpRemote(remote);
  if (!cleanRemote) throw new WorkspaceScmError("SCM_AUTH_MISMATCH", "HTTPS token authentication requires an HTTP(S) remote");
  const username = credential.username?.trim() || (credential.provider === "gitlab" ? "oauth2" : credential.provider === "github" ? "x-access-token" : "git");
  const basic = Buffer.from(`${username}:${credential.token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${cleanRemote}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function safeBranch(branch: string): string {
  if (!branch || branch.length > 240 || branch.includes("..") || branch.startsWith("-") || branch.endsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new WorkspaceScmError("SCM_BRANCH_INVALID", "Default branch is invalid");
  }
  return branch;
}

function failure(result: ScmGitResult, fallback: string, token?: string | null) {
  const detail = `${result.stderr}\n${result.stdout}`.trim() || fallback;
  return redactWorkerDiagnostic(detail, token ? [token] : []).slice(0, 800);
}

function relation(ahead: number, behind: number): WorkspaceRemoteRelation {
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "synchronized";
}

export async function inspectWorkspaceRemote(input: {
  branch: string;
  requiredCommit?: string;
  credential?: WorkspaceScmCredentialInput;
  git: ScmGitExec;
  now?: () => string;
}): Promise<WorkspaceRemoteStatus> {
  const branch = safeBranch(input.branch);
  const localResult = await input.git(["rev-parse", "HEAD"]);
  if (localResult.code !== 0) throw new WorkspaceScmError("SCM_LOCAL_HEAD_FAILED", failure(localResult, "Unable to read local HEAD", input.credential?.token));
  const localHead = localResult.stdout.trim();
  const remoteResult = await input.git(["remote", "get-url", "origin"]);
  if (remoteResult.code !== 0 || !remoteResult.stdout.trim()) {
    return {
      provider: "generic", remote: "", branch, localHead, remoteHead: null,
      relation: "no_remote", ahead: 0, behind: 0, checkedAt: (input.now ?? (() => new Date().toISOString()))(),
      ...(input.requiredCommit ? { requiredCommit: input.requiredCommit, requiredCommitPresent: false } : {}),
    };
  }
  const rawRemote = remoteResult.stdout.trim();
  const remote = redactRemoteUrl(rawRemote, input.credential?.token ? [input.credential.token] : []);
  const provider = input.credential?.provider ?? detectScmProvider(rawRemote);
  const env = scmAuthEnvironment(rawRemote, { ...input.credential, provider });
  const remoteRef = `refs/pigo/remotes/origin/${branch}`;
  const ls = await input.git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], env);
  if (ls.code !== 0) throw new WorkspaceScmError("SCM_REMOTE_UNREACHABLE", failure(ls, "Unable to read origin", input.credential?.token));
  const remoteHead = ls.stdout.trim().split(/\s+/)[0] || null;
  const checkedAt = (input.now ?? (() => new Date().toISOString()))();
  if (!remoteHead) {
    return {
      provider, remote, branch, localHead, remoteHead: null, relation: "remote_branch_missing", ahead: 0, behind: 0, checkedAt,
      ...(input.requiredCommit ? { requiredCommit: input.requiredCommit, requiredCommitPresent: false } : {}),
    };
  }
  const fetched = await input.git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${remoteRef}`], env);
  if (fetched.code !== 0) throw new WorkspaceScmError("SCM_FETCH_FAILED", failure(fetched, "Unable to fetch origin", input.credential?.token));
  const counts = await input.git(["rev-list", "--left-right", "--count", `${localHead}...${remoteRef}`]);
  if (counts.code !== 0) throw new WorkspaceScmError("SCM_COMPARE_FAILED", failure(counts, "Unable to compare local and remote branches", input.credential?.token));
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map((value) => Number(value));
  let requiredCommitPresent: boolean | undefined;
  if (input.requiredCommit) {
    const contains = await input.git(["merge-base", "--is-ancestor", input.requiredCommit, remoteRef]);
    requiredCommitPresent = contains.code === 0;
  }
  return {
    provider, remote, branch, localHead, remoteHead, relation: relation(ahead, behind), ahead, behind, checkedAt,
    ...(input.requiredCommit ? { requiredCommit: input.requiredCommit, requiredCommitPresent } : {}),
  };
}

export async function pushWorkspaceBranch(input: {
  branch: string;
  credential?: WorkspaceScmCredentialInput;
  exportCredentials?: readonly string[];
  git: ScmGitExec;
  now?: () => string;
}): Promise<WorkspacePushResult> {
  const before = await inspectWorkspaceRemote(input);
  if (before.relation === "no_remote") throw new WorkspaceScmError("SCM_REMOTE_MISSING", "Workspace has no origin remote");
  if (before.relation === "behind") throw new WorkspaceScmError("SCM_REMOTE_AHEAD", "Remote branch contains commits that are not local; fetch and reconcile before pushing");
  if (before.relation === "diverged") throw new WorkspaceScmError("SCM_REMOTE_DIVERGED", "Local and remote branches have diverged; manual reconciliation is required");
  if (before.relation === "synchronized") return { pushed: false, before, after: before };
  const rawRemote = (await input.git(["remote", "get-url", "origin"])).stdout.trim();
  requirePushAuthentication(rawRemote, input.credential);
  const policyViolations = await inspectWorkspacePushPolicy({ before, git: input.git, credentials: [...(input.exportCredentials ?? []), ...(input.credential?.token ? [input.credential.token] : [])] });
  if (policyViolations.length > 0) {
    const sample = policyViolations.slice(0, 10).map((item) => `${item.category}:${item.path}`).join(", ");
    const remainder = policyViolations.length > 10 ? ` (+${policyViolations.length - 10} more)` : "";
    throw new WorkspaceScmError(
      "SCM_EXPORT_POLICY_BLOCKED",
      `Push blocked by repository export policy (${policyViolations.length} finding(s)): ${sample}${remainder}`,
    );
  }
  const env = scmAuthEnvironment(rawRemote, { ...input.credential, provider: input.credential?.provider ?? before.provider });
  // Push exactly the scanned commit, even if another process advances HEAD.
  const pushed = await input.git(["-c", "push.followTags=false", "push", "--porcelain", "origin", `${before.localHead}:refs/heads/${safeBranch(input.branch)}`], env);
  if (pushed.code !== 0) throw new WorkspaceScmError("SCM_PUSH_FAILED", failure(pushed, "Git push failed", input.credential?.token));
  const after = await inspectWorkspaceRemote(input);
  if (after.relation !== "synchronized") throw new WorkspaceScmError("SCM_PUSH_UNVERIFIED", "Push returned successfully but origin does not match local HEAD");
  return { pushed: true, before, after };
}
