import type {
  ScmAuthMode,
  ScmProvider,
  WorkspacePushResult,
  WorkspaceRemoteRelation,
  WorkspaceRemoteStatus,
} from "../shared/types.js";

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

export type WorkspacePushPolicyCategory = "documentation" | "credential_file" | "account_export" | "secret" | "internal_network" | "embedded_credentials" | "account_data" | "ai_prompt";

export interface WorkspacePushPolicyViolation {
  category: WorkspacePushPolicyCategory;
  path: string;
}

const contentPolicies: Array<{ category: WorkspacePushPolicyCategory; pattern: string; ignoreCase?: boolean }> = [
  {
    category: "secret",
    pattern: "(BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})",
  },
  {
    category: "internal_network",
    pattern: "(^|[^0-9])(10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3}\\.[0-9]{1,3})([^0-9]|$)",
  },
  {
    category: "embedded_credentials",
    pattern: "https?://[^:/[:space:]@]+:[^@/[:space:]]+@",
  },
  {
    category: "ai_prompt",
    // Split the natural-language markers so this policy source does not flag itself.
    pattern: `(${"You" + " are"}|${"Act" + " as"}|${"system" + " prompt"}|${"developer" + " prompt"}|${"reviewer" + " prompt"}|${"prompt" + " template"}|systemPrompt|developerPrompt|reviewerPrompt|promptTemplate|${"系统" + "提示词"}|${"开发者" + "提示词"}|${"审查" + "提示词"}|${"你" + "是"}|${"你将" + "作为"})`,
  },
  {
    category: "account_data",
    pattern: "([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|((ssh|deploy|git|db|database)[_-]?(user|username))[^[:space:]]{0,80}(:-|[:=])[^[:space:]]*[A-Za-z0-9][A-Za-z0-9._@+-]{3,})",
    ignoreCase: true,
  },
];

const accountConfigPattern = "(password|passwd|access[_-]?token|api[_-]?key|secret|username|user[_-]?name|account[_-]?id|email)['\"]?[[:space:]]*[:=][[:space:]]*['\"]?[A-Za-z0-9][A-Za-z0-9@._+:/-]{7,}";

function pathPolicy(pathName: string): WorkspacePushPolicyCategory | undefined {
  const normalized = pathName.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (lower.startsWith("docs/") || lower.includes("/docs/")) return "documentation";
  if (/\.(md|mdx)$/i.test(lower) && /(^|[._/-])(acceptance|development|dev-plan|architecture|system-design|验收|开发|架构)([._/-]|$)/i.test(lower)) return "documentation";
  if (/(^|[._/-])(prompt|prompts|system-prompt|agent-instruction|提示词)([._/-]|$)/i.test(lower)) return "ai_prompt";
  if (/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(normalized) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(lower)) return "credential_file";
  if (/(^|\/)(accounts?|users?[-_.]?(export|backup|dump)|credentials)[-_.].*\.(csv|json|ya?ml|sql|xlsx?)$/i.test(normalized)) return "account_export";
  return undefined;
}

function nulPaths(output: string) {
  return output.split("\0").map((value) => value.replace(/^HEAD:/, "")).filter(Boolean);
}

function displayPolicyPath(pathName: string) {
  return pathName.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 180);
}

async function grepPolicyFiles(git: ScmGitExec, pattern: string, files: string[], ignoreCase = false) {
  const matches = new Set<string>();
  for (let index = 0; index < files.length; index += 80) {
    const result = await git(["grep", "-I", "-l", "-z", ...(ignoreCase ? ["-i"] : []), "-E", pattern, "HEAD", "--", ...files.slice(index, index + 80)]);
    if (result.code !== 0 && result.code !== 1) {
      throw new WorkspaceScmError("SCM_EXPORT_POLICY_FAILED", "Unable to complete the repository export policy scan");
    }
    for (const pathName of nulPaths(result.stdout)) matches.add(pathName);
  }
  return matches;
}

/**
 * Scans only blobs that the next push would introduce. Findings contain a
 * category and path only: matching source text (which may itself be secret) is
 * never returned to the web service or written to the audit log.
 */
export async function inspectWorkspacePushPolicy(input: {
  before: WorkspaceRemoteStatus;
  git: ScmGitExec;
}): Promise<WorkspacePushPolicyViolation[]> {
  const listed = input.before.remoteHead
    ? await input.git(["diff", "--name-only", "-z", "--diff-filter=ACMR", `${input.before.remoteHead}..HEAD`, "--"])
    : await input.git(["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
  if (listed.code !== 0) throw new WorkspaceScmError("SCM_EXPORT_POLICY_FAILED", "Unable to enumerate files for the repository export policy scan");
  const files = [...new Set(nulPaths(listed.stdout))];
  const findings = new Map<string, WorkspacePushPolicyViolation>();
  const add = (category: WorkspacePushPolicyCategory, pathName: string) => {
    const path = displayPolicyPath(pathName);
    findings.set(`${category}:${path}`, { category, path });
  };
  for (const pathName of files) {
    const category = pathPolicy(pathName);
    if (category) add(category, pathName);
  }
  for (const policy of contentPolicies) {
    for (const pathName of await grepPolicyFiles(input.git, policy.pattern, files, policy.ignoreCase)) add(policy.category, pathName);
  }
  const accountFiles = files.filter((pathName) => /(^|\/)(\.env[^/]*|[^/]+\.(json|ya?ml|toml|ini|conf|properties|csv|sql))$/i.test(pathName));
  for (const pathName of await grepPolicyFiles(input.git, accountConfigPattern, accountFiles, true)) add("account_data", pathName);
  return [...findings.values()];
}

export function redactRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^@/\s]*@/g, "//***@");
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
  let detail = `${result.stderr}\n${result.stdout}`.trim() || fallback;
  if (token) detail = detail.replaceAll(token, "***");
  return detail.replace(/\/\/[^@/\s]*@/g, "//***@").slice(0, 800);
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
  if (localResult.code !== 0) throw new WorkspaceScmError("SCM_LOCAL_HEAD_FAILED", failure(localResult, "Unable to read local HEAD"));
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
  const remote = redactRemoteUrl(rawRemote);
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
  if (counts.code !== 0) throw new WorkspaceScmError("SCM_COMPARE_FAILED", failure(counts, "Unable to compare local and remote branches"));
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
  const policyViolations = await inspectWorkspacePushPolicy({ before, git: input.git });
  if (policyViolations.length > 0) {
    const sample = policyViolations.slice(0, 10).map((item) => `${item.category}:${item.path}`).join(", ");
    const remainder = policyViolations.length > 10 ? ` (+${policyViolations.length - 10} more)` : "";
    throw new WorkspaceScmError(
      "SCM_EXPORT_POLICY_BLOCKED",
      `Push blocked by repository export policy (${policyViolations.length} finding(s)): ${sample}${remainder}`,
    );
  }
  const env = scmAuthEnvironment(rawRemote, { ...input.credential, provider: input.credential?.provider ?? before.provider });
  const pushed = await input.git(["push", "--porcelain", "origin", `HEAD:refs/heads/${safeBranch(input.branch)}`], env);
  if (pushed.code !== 0) throw new WorkspaceScmError("SCM_PUSH_FAILED", failure(pushed, "Git push failed", input.credential?.token));
  const after = await inspectWorkspaceRemote(input);
  if (after.relation !== "synchronized") throw new WorkspaceScmError("SCM_PUSH_UNVERIFIED", "Push returned successfully but origin does not match local HEAD");
  return { pushed: true, before, after };
}
