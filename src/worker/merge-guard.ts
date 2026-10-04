import { parseConflictingPaths, planMergeStrategy, type MergeStrategy } from "../shared/merge.js";

/**
 * B2 — merging a run branch into a workspace must leave the workspace and its
 * branch exactly as they were whenever the merge does not succeed. The previous
 * implementation switched to the target branch and, on conflict, only ran
 * `git merge --abort`: the workspace stayed on the target branch, so the
 * "workspace untouched" promise was false.
 *
 * This module owns the capture / merge / restore / verify state machine. All Git
 * access goes through an injected `exec`, so the failure paths are unit-testable
 * without a real repository, a remote or docker. The Worker supplies a thin
 * adapter over `runHardenedGit`; tests supply a fake repository simulator.
 */

export interface MergeGuardGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MergeGuardGitOptions {
  /** Process timeout in ms for this invocation; 0/undefined means no limit. */
  timeoutMs?: number;
}

/** Injected git executor. `args` are the arguments after `git`. */
export type MergeGuardGitExec = (args: string[], options?: MergeGuardGitOptions) => Promise<MergeGuardGitResult>;

/** Workspace state captured before any mutation. */
export interface WorkspaceState {
  /** Short branch name when HEAD is attached; `null` when HEAD is detached. */
  branch: string | null;
  /** Full HEAD commit sha at capture time. */
  headSha: string;
  /** Raw `status --porcelain` output (empty string means clean). */
  porcelain: string;
  clean: boolean;
}

export type CaptureWorkspaceResult =
  | { ok: true; state: WorkspaceState }
  | { ok: false; error: string };

function normalizePorcelain(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Captures the workspace's branch (or detached HEAD), HEAD sha and cleanliness
 * before the merge mutates anything. Returns `ok: false` when the repository is
 * unreadable so the caller can refuse the merge without touching it.
 */
export async function captureWorkspaceState(exec: MergeGuardGitExec): Promise<CaptureWorkspaceResult> {
  const head = await exec(["rev-parse", "HEAD"], { timeoutMs: 60_000 }).catch(() => undefined);
  if (!head || head.code !== 0 || !head.stdout.trim()) {
    return { ok: false, error: "无法读取工作区 HEAD" };
  }
  const status = await exec(["status", "--porcelain"], { timeoutMs: 60_000 }).catch(() => undefined);
  if (!status || status.code !== 0) {
    return { ok: false, error: "无法读取工作区状态" };
  }
  const symbolic = await exec(["symbolic-ref", "--short", "HEAD"], { timeoutMs: 60_000 }).catch(() => undefined);
  const branch = symbolic && symbolic.code === 0 && symbolic.stdout.trim() ? symbolic.stdout.trim() : null;
  const porcelain = normalizePorcelain(status.stdout);
  return {
    ok: true,
    state: { branch, headSha: head.stdout.trim(), porcelain, clean: porcelain.length === 0 },
  };
}

export interface RestoreSteps {
  /** `git merge --abort` completed (false also means "no merge was in progress"). */
  mergeAbort: boolean;
  /** The restore checkout/switch succeeded. */
  checkout: boolean;
  headMatch: boolean;
  branchMatch: boolean;
  cleanMatch: boolean;
}

export interface RestoreReport {
  /** True only when every verification step passed. */
  restored: boolean;
  steps: RestoreSteps;
  errors: string[];
  observed: { branch: string | null; headSha: string | null; porcelain: string | null };
}

async function bestEffort(exec: MergeGuardGitExec, args: string[], timeoutMs: number): Promise<MergeGuardGitResult | undefined> {
  return exec(args, { timeoutMs }).catch(() => undefined);
}

/**
 * Rolls the workspace back to the captured state:
 *  1. aborts an in-progress merge (best effort — a clean checkout fails the
 *     command, which is not an error);
 *  2. checks the original branch back out, or re-detaches at the captured sha;
 *  3. verifies HEAD, the symbolic branch and `status --porcelain` so a restore
 *     that silently did not happen is reported as `restored: false` instead of
 *     being dressed up as success.
 */
export async function restoreWorkspaceState(exec: MergeGuardGitExec, state: WorkspaceState): Promise<RestoreReport> {
  const errors: string[] = [];
  const abort = await bestEffort(exec, ["merge", "--abort"], 120_000);
  const mergeAbort = abort?.code === 0;

  const checkoutArgs = state.branch ? ["checkout", state.branch] : ["checkout", "--detach", state.headSha];
  const checkout = await bestEffort(exec, checkoutArgs, 120_000);
  const checkoutOk = checkout?.code === 0;
  if (!checkoutOk) {
    errors.push(`无法恢复工作区（git ${checkoutArgs.join(" ")}）：${(checkout?.stderr || "git 调用失败").trim().slice(0, 200)}`);
  }

  const head = await bestEffort(exec, ["rev-parse", "HEAD"], 60_000);
  const headSha = head && head.code === 0 ? head.stdout.trim() : null;
  const headMatch = headSha === state.headSha;
  if (!headMatch) errors.push(`恢复后 HEAD 不匹配（期望 ${state.headSha}，实际 ${headSha ?? "unknown"}）`);

  let branch: string | null = null;
  let branchMatch = true;
  if (state.branch) {
    const symbolic = await bestEffort(exec, ["symbolic-ref", "--short", "HEAD"], 60_000);
    branch = symbolic && symbolic.code === 0 ? symbolic.stdout.trim() : null;
    branchMatch = branch === state.branch;
    if (!branchMatch) errors.push(`恢复后分支不匹配（期望 ${state.branch}，实际 ${branch ?? "detached"}）`);
  }

  const status = await bestEffort(exec, ["status", "--porcelain"], 60_000);
  const porcelain = status && status.code === 0 ? normalizePorcelain(status.stdout) : null;
  const cleanMatch = porcelain !== null && porcelain === state.porcelain;
  if (!cleanMatch) errors.push(`恢复后工作区状态不匹配（期望 ${state.porcelain ? "有未提交改动" : "干净"}）`);

  return {
    restored: checkoutOk && headMatch && branchMatch && cleanMatch,
    steps: { mergeAbort, checkout: checkoutOk, headMatch, branchMatch, cleanMatch },
    errors,
    observed: { branch, headSha, porcelain },
  };
}

export interface GuardedMergeInput {
  exec: MergeGuardGitExec;
  /** Absolute path of the run worktree to fetch `sourceBranch` from. */
  sourcePath: string;
  sourceBranch: string;
  /** Explicit target branch; defaults to the workspace's current branch. */
  targetBranch?: string;
  message?: string;
  /** Run id, used to namespace the temporary fetch ref. */
  runId: string;
}

/** The workspace state captured before the merge, echoed back in failures. */
export interface GuardedMergeOriginal {
  branch: string | null;
  headSha: string;
  clean: boolean;
}

export type GuardedMergeResult =
  | { ok: true; commit: string; targetBranch: string; strategy: MergeStrategy; original: GuardedMergeOriginal }
  | {
    ok: false;
    status: number;
    code: string;
    error: string;
    conflictingPaths?: string[];
    /** True when the workspace was verified back on its pre-merge branch/HEAD. */
    restored: boolean;
    /** Present when a restore was attempted and did not fully verify. */
    restoreError?: string;
    original: GuardedMergeOriginal | null;
    targetBranch?: string;
  };

function originalOf(state: WorkspaceState): GuardedMergeOriginal {
  return { branch: state.branch, headSha: state.headSha, clean: state.clean };
}

function restoreErrorOf(report: RestoreReport): string | undefined {
  return report.restored ? undefined : report.errors.join("；").slice(0, 400) || "工作区恢复未通过校验";
}

async function deleteTempRef(exec: MergeGuardGitExec, tempRef: string): Promise<void> {
  await bestEffort(exec, ["update-ref", "-d", tempRef], 30_000);
}

/**
 * Performs the merge exactly as before (fetch into a temp ref, `--ff-only` when
 * the target is already an ancestor, otherwise `--no-ff` merge commit; never a
 * force push) but with the B2 guarantee attached: on every failure path the
 * workspace is restored to its captured branch/HEAD and the restore is verified.
 */
export async function runGuardedMerge(input: GuardedMergeInput): Promise<GuardedMergeResult> {
  const captured = await captureWorkspaceState(input.exec);
  if (!captured.ok) {
    return { ok: false, status: 500, code: "GIT_FAILED", error: captured.error, restored: true, original: null };
  }
  const state = captured.state;
  const original = originalOf(state);

  if (!state.clean) {
    return {
      ok: false, status: 409, code: "WORKSPACE_DIRTY",
      error: "工作区存在未提交改动，已拒绝合并（未修改工作区）",
      restored: true, original,
    };
  }

  const targetBranch = input.targetBranch?.trim() || state.branch || "";
  if (!targetBranch) {
    return {
      ok: false, status: 409, code: "TARGET_BRANCH_UNKNOWN",
      error: "无法确定工作区默认分支", restored: true, original,
    };
  }

  const tempRef = `refs/pigo/merge/${input.runId}`;
  const fail = (status: number, code: string, error: string, report: RestoreReport, extra: { conflictingPaths?: string[] } = {}): GuardedMergeResult => ({
    ok: false, status, code, error, restored: report.restored, ...(restoreErrorOf(report) ? { restoreError: restoreErrorOf(report) } : {}),
    original, targetBranch, ...extra,
  });

  let mergeCommitted = false;
  try {
    if (state.branch !== targetBranch) {
      const checkout = await input.exec(["checkout", targetBranch], { timeoutMs: 120_000 });
      if (checkout.code !== 0) {
        const report = await restoreWorkspaceState(input.exec, state);
        return fail(409, "TARGET_BRANCH_UNAVAILABLE", `无法切换到目标分支 ${targetBranch}：${checkout.stderr.trim().slice(0, 200)}`, report);
      }
    }

    // Fetch the run branch into a temporary ref. The file transport is enabled
    // for this one fetch (the run directory is a local clone), exactly as when
    // cloning. `+` updates the temp ref, it is not a force push to a real branch.
    const fetch = await input.exec(
      ["-c", "protocol.file.allow=always", "fetch", "--no-tags", input.sourcePath, `+refs/heads/${input.sourceBranch}:${tempRef}`],
      { timeoutMs: 120_000 },
    );
    if (fetch.code !== 0) {
      await deleteTempRef(input.exec, tempRef);
      const report = await restoreWorkspaceState(input.exec, state);
      return fail(409, "MERGE_FETCH_FAILED", `无法获取任务分支 ${input.sourceBranch}：${fetch.stderr.trim().slice(0, 200)}`, report);
    }

    const ancestor = await input.exec(["merge-base", "--is-ancestor", "HEAD", tempRef], { timeoutMs: 60_000 });
    const strategy = planMergeStrategy({ headIsAncestor: ancestor.code === 0 });
    const mergeArgs = strategy === "fast-forward"
      ? ["merge", "--ff-only", tempRef]
      : ["-c", "user.name=PiGO", "-c", "user.email=agent@pigo.local", "merge", "--no-ff", "--no-edit", "-m", input.message?.trim() || `Merge ${input.sourceBranch} into ${targetBranch}`, tempRef];

    const merge = await input.exec(mergeArgs, { timeoutMs: 300_000 });
    if (merge.code !== 0) {
      const conflictOutput = await bestEffort(input.exec, ["diff", "--name-only", "--diff-filter=U"], 60_000);
      const conflictingPaths = parseConflictingPaths(conflictOutput?.stdout ?? "");
      await deleteTempRef(input.exec, tempRef);
      const report = await restoreWorkspaceState(input.exec, state);
      const error = report.restored
        ? "合并存在冲突，已中止并恢复工作区到合并前的分支与提交"
        : "合并存在冲突，已中止，但工作区恢复失败（请人工检查）";
      return fail(409, "MERGE_CONFLICT", error, report, { conflictingPaths });
    }

    mergeCommitted = true;
    const commit = await bestEffort(input.exec, ["rev-parse", "HEAD"], 60_000);
    await deleteTempRef(input.exec, tempRef);
    if (!commit || commit.code !== 0 || !commit.stdout.trim()) {
      // The merge itself succeeded; rolling it back would discard a valid merge,
      // so report the unreadable hash loudly without pretending a restore.
      return {
        ok: false, status: 500, code: "MERGE_COMMIT_UNKNOWN",
        error: "合并已完成但无法读取提交哈希（工作区保留合并结果）",
        restored: false, restoreError: "合并已应用，未回滚；仅提交哈希读取失败", original, targetBranch,
      };
    }
    return { ok: true, commit: commit.stdout.trim(), targetBranch, strategy, original };
  } catch (error) {
    await deleteTempRef(input.exec, tempRef);
    if (mergeCommitted) {
      return {
        ok: false, status: 500, code: "MERGE_FAILED",
        error: `合并已完成但后续步骤异常：${(error as Error).message.slice(0, 200)}`,
        restored: false, restoreError: "合并已应用，未回滚", original, targetBranch,
      };
    }
    const report = await restoreWorkspaceState(input.exec, state).catch(() => undefined);
    if (!report) {
      return {
        ok: false, status: 500, code: "MERGE_FAILED",
        error: `合并过程中发生异常：${(error as Error).message.slice(0, 200)}`,
        restored: false, restoreError: "工作区恢复本身失败（git 调用异常）", original, targetBranch,
      };
    }
    return fail(500, "MERGE_FAILED", `合并过程中发生异常：${(error as Error).message.slice(0, 200)}`, report);
  }
}
