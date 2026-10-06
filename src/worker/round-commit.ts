import type { RunEvent } from "../shared/types.js";

/**
 * E2E-01b defect: a single-agent round left the developer's work *uncommitted*
 * in the run worktree. The human merge path fetches only
 * `refs/heads/<run branch>` from that worktree
 * (`src/worker/merge-guard.ts`, `+refs/heads/<branch>:refs/pigo/merge/<runId>`),
 * so the uncommitted change was never fetched: the merge fast-forwarded to the
 * base commit and reported success while nothing landed in the workspace.
 *
 * The sub-agent path never showed this because it commits per task and
 * cherry-picks the result into the run worktree, so its branch carries commits.
 *
 * This module commits a round's developer work onto the run branch *before* the
 * round's diff/checkpoints/checks/review are produced, so the reviewed artifact
 * is exactly what the merge will fetch. It is deliberately small and
 * dependency-injected (like `merge-guard.ts`) so the failure and clean paths are
 * unit-testable against a real repository.
 *
 * Guarantees:
 *  - a clean worktree (or a staging area with nothing to commit) is a no-op: an
 *    empty commit is never created;
 *  - the identity and message are deterministic (`round <n>: <short task>`), so
 *    a recovered round that re-runs this step against the same content creates
 *    no second commit (after the first commit the worktree is clean);
 *  - a commit that cannot be made is surfaced as a `round.commit_failed` event
 *    with the Git error; it never silently pretends the work is mergeable;
 *  - only the run worktree's branch is advanced; the workspace repository and
 *    the worktree's `.git` configuration are never touched (identity is passed
 *    with `-c`, no `git config` write).
 */

/** Identity the worker already uses for its own integration commits. */
export const roundCommitIdentity = { name: "PiGO Integration", email: "agent@pigo.local" } as const;

export const ROUND_COMMIT_FAILED_EVENT = "round.commit_failed";
export const ROUND_COMMITTED_EVENT = "round.committed";

export interface RoundCommitGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RoundCommitGitOptions {
  /** Process timeout in ms; 0/undefined means the injected executor's default. */
  timeoutMs?: number;
}

/** Injected git executor. `args` are the arguments after `git`. */
export type RoundCommitGitExec = (args: string[], options?: RoundCommitGitOptions) => Promise<RoundCommitGitResult>;

/** Event payload the caller must post on the run (source/type/message/meta). */
export interface RoundCommitEvent {
  source: RunEvent["source"];
  type: string;
  message: string;
  meta?: Record<string, unknown>;
}

export type CommitRoundChangesResult =
  | { status: "clean" }
  | { status: "committed"; commit: string; message: string }
  | { status: "failed"; error: string; message: string };

export interface CommitRoundChangesInput {
  exec: RoundCommitGitExec;
  /** Round number the commit belongs to. */
  round: number;
  /** Deterministic subject source (the run's task or round title). */
  label: string;
  /**
   * Best-effort observer. Called with a `round.committed` event on success and a
   * `round.commit_failed` event on every failure path; an emit error must never
   * change the round's behaviour.
   */
  emit?: (event: RoundCommitEvent) => void | Promise<void>;
}

const maxSubjectLength = 72;

/**
 * Deterministic commit subject: `round <n>: <single-line label>`. It is a pure
 * function of the round and label, so the same round/run produces the same
 * subject across a worker restart.
 */
export function roundCommitSubject(round: number, label: string): string {
  const singleLine = (label ?? "").replace(/\s+/g, " ").trim();
  const short = singleLine.length > maxSubjectLength
    ? `${singleLine.slice(0, maxSubjectLength - 1)}…`
    : singleLine;
  return `round ${round}: ${short || "developer work"}`;
}

function failureMessage(round: number, detail: string): string {
  return `第 ${round} 轮开发成果提交失败，改动仍留在任务目录且不会被合并：${detail}`;
}

/**
 * Commits whatever the round's developer work left in the run worktree.
 *
 * Returns `clean` when there is nothing to commit (no empty commit is ever
 * created), `committed` with the new HEAD, or `failed` with the Git error (the
 * caller continues the round; the failure is already surfaced through `emit`).
 */
export async function commitRoundChanges(input: CommitRoundChangesInput): Promise<CommitRoundChangesResult> {
  const { exec, round } = input;
  const emit = async (event: RoundCommitEvent) => {
    try {
      await input.emit?.(event);
    } catch {
      // Observability must never change the round's outcome.
    }
  };
  const fail = async (error: string, meta: Record<string, unknown> = {}): Promise<CommitRoundChangesResult> => {
    const message = failureMessage(round, error.slice(0, 500));
    await emit({
      source: "system",
      type: ROUND_COMMIT_FAILED_EVENT,
      message,
      meta: { round, error: error.slice(0, 2_000), ...meta },
    });
    return { status: "failed", error, message };
  };

  const status = await exec(["status", "--porcelain"]).catch(() => undefined);
  if (!status || status.code !== 0) {
    return fail(`无法读取任务目录状态：${(status?.stderr || "git status 调用失败").trim().slice(0, 300)}`);
  }
  if (!status.stdout.trim()) return { status: "clean" };

  const added = await exec(["add", "-A", "--", "."]).catch(() => undefined);
  if (!added || added.code !== 0) {
    return fail(`无法暂存本轮改动：${(added?.stderr || "git add 调用失败").trim().slice(0, 300)}`);
  }
  // Structurally guarantee "never create an empty commit": after staging, only
  // commit when the index really differs from HEAD (exit 1). A `status` entry
  // that Git cannot stage (e.g. a submodule edge case) becomes a clean no-op.
  const staged = await exec(["diff", "--cached", "--quiet"]).catch(() => undefined);
  if (!staged) return fail("无法确认本轮改动是否已暂存：git diff --cached 调用失败");
  if (staged.code === 0) return { status: "clean" };
  if (staged.code !== 1) {
    return fail(`无法确认本轮改动是否已暂存：${staged.stderr.trim().slice(0, 300) || `git diff --cached --quiet 退出码 ${staged.code}`}`);
  }

  const message = roundCommitSubject(round, input.label);
  const commit = await exec([
    "-c", `user.name=${roundCommitIdentity.name}`,
    "-c", `user.email=${roundCommitIdentity.email}`,
    "commit", "-m", message,
  ]).catch(() => undefined);
  if (!commit || commit.code !== 0) {
    return fail(`无法提交本轮改动：${(commit?.stderr || "git commit 调用失败").trim().slice(0, 500)}`);
  }

  const sha = await exec(["rev-parse", "HEAD"]).catch(() => undefined);
  if (!sha || sha.code !== 0 || !sha.stdout.trim()) {
    return fail("提交已完成但无法读取提交哈希（改动已提交到任务分支）");
  }
  const resolved = sha.stdout.trim();
  await emit({
    source: "system",
    type: ROUND_COMMITTED_EVENT,
    message: `第 ${round} 轮开发成果已提交到任务分支 ${resolved.slice(0, 12)}（${message}），合并将获取该提交`,
    meta: { round, commit: resolved, subject: message },
  });
  return { status: "committed", commit: resolved, message };
}
