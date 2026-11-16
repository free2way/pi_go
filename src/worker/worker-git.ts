import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Run } from "../shared/types.js";
import { runHardenedGit } from "./git-hardening.js";
import { RunCleanupPathError, planRunDirectoryRemoval } from "./run-cleanup.js";
import { runGuardedMerge, type GuardedMergeResult, type MergeGuardGitExec } from "./merge-guard.js";
import { commitRoundChanges, type CommitRoundChangesResult } from "./round-commit.js";
import { createWorkspaceService } from "./workspace-service.js";
import { serializeWorktreeMutation, projectsRoot, diagnosticMessage, runsRoot } from "./worker-runtime.js";
import { git } from "./worker-process.js";
import { postUpdate } from "./worker-web-client.js";

/**
 * AUD-01 / AT-GIT-001: prepares the run directory as a standalone clone of the
 * source repository. No shared, writable Git metadata is exposed to agents; the
 * clone is the only repository the sandbox can see.
 */
export async function prepareRunDirectory(input: {
  project: string;
  runDir: string;
  branch: string;
  baseSha?: string;
  reuse: boolean;
  signal: AbortSignal;
}): Promise<{ baseSha: string }> {
  const { project, runDir, branch, signal } = input;
  const exists = await stat(runDir).then(() => true).catch(() => false);
  if (input.reuse) {
    if (!exists) throw new Error("无法恢复：任务运行目录不存在（可能已被清理）");
    const current = await git(runDir, ["branch", "--show-current"], signal);
    if (current !== branch) throw new Error(`无法恢复：运行目录当前分支为 ${current || "detached"}，期望 ${branch}`);
    const baseSha = input.baseSha ?? await git(runDir, ["rev-parse", "HEAD"], signal);
    return { baseSha };
  }
  await mkdir(path.dirname(runDir), { recursive: true });
  if (exists) await rm(runDir, { recursive: true, force: true });
  // The file transport is allowed only for this clone (the source is an
  // operator-registered local workspace); every other Git call keeps it off.
  await serializeWorktreeMutation(() => git(project, [
    "-c", "protocol.file.allow=always",
    "clone", "--local", "--no-hardlinks", "--quiet", project, runDir,
  ], signal));
  await git(runDir, ["config", "core.hooksPath", "/dev/null"], signal);
  await git(runDir, ["config", "credential.helper", ""], signal);
  await git(runDir, ["config", "gc.auto", "0"], signal);
  const head = input.baseSha ?? await git(project, ["rev-parse", "HEAD"], signal);
  await git(runDir, ["checkout", "-b", branch, head], signal);
  return { baseSha: head };
}

export const {
  cloneWorkspace,
  createWorkspace,
  listProjects,
  pushWorkspace,
  resolveProject,
  verifyWorkspace,
  workspaceRemoteStatus,
} = createWorkspaceService({
  projectsRoot,
  git,
  serializeMutation: serializeWorktreeMutation,
  diagnosticMessage,
});

/** AUD-16: cap is high enough for realistic diffs; when it is hit the artifact
 * says so explicitly instead of silently clipping. */
const maxDiffOutput = 3_400_000;

/**
 * E2E-01b: commits whatever a round's developer work left uncommitted in the run
 * worktree, on the run branch, before that round's diff/checkpoints/checks/review
 * are produced. The merge only fetches `refs/heads/<run branch>` from the run
 * worktree, so without this the human merge fast-forwards to the base commit and
 * silently reports success while nothing lands in the workspace.
 *
 * Runs for every path that reaches the round's checks: the fresh single-agent
 * round, repair rounds, the multi-agent integrator's own edits, a recovered
 * round that skipped the developer stage via checkpoint, and retry-review.
 * Clean worktrees (including the sub-agent/cherry-pick path, whose commits are
 * already on the branch) are a no-op; a failure is surfaced as a run event and
 * the round continues unchanged.
 */
export async function commitRoundWork(
  run: Run,
  worktree: string,
  round: number,
  signal: AbortSignal,
): Promise<CommitRoundChangesResult> {
  return commitRoundChanges({
    exec: (args, options) => runHardenedGit({ cwd: worktree, args, signal, timeoutMs: options?.timeoutMs ?? 120_000 }),
    round,
    // Deterministic across recovery: the run's task text never changes, so a
    // recovered round targeting the same content produces the same subject.
    label: run.task,
    emit: (event) => postUpdate(run.id, {
      event: {
        round,
        source: event.source,
        type: event.type,
        message: event.message,
        ...(event.meta ? { meta: event.meta } : {}),
      },
    }).catch(() => undefined),
  });
}

export async function collectDiff(worktree: string, signal: AbortSignal, baseRef?: string) {
  await git(worktree, ["add", "-N", "."], signal);
  const args = baseRef ? ["diff", "--no-ext-diff", baseRef, "--", "."] : ["diff", "--no-ext-diff", "--", "."];
  const diff = await git(worktree, args, signal, { maxOutput: maxDiffOutput });
  if (diff.length >= maxDiffOutput) {
    return `${diff}\n# [PiGO] diff truncated at ${maxDiffOutput} characters (AUD-16)\n`;
  }
  return diff;
}

/**
 * A1: regenerates a run's full patch from its run directory, using the same
 * `git add -N . && git diff <base>` path the worker uses while executing. Used
 * by the web export route when no diff artifact body is stored (e.g. the run was
 * accepted before artifacts existed). Read-only: it never mutates the worktree
 * beyond the intent-to-add index entries the normal flow already creates.
 */
export async function generateRunDiff(input: { ownerId: string; runId: string; baseSha?: string }) {
  let plan;
  try {
    plan = planRunDirectoryRemoval(runsRoot, input.ownerId, input.runId);
  } catch (error) {
    if (error instanceof RunCleanupPathError) return { ok: false as const, status: 400, code: error.code, error: error.message };
    throw error;
  }
  const exists = await stat(plan.worktree).then(() => true).catch(() => false);
  if (!exists) return { ok: false as const, status: 404, code: "RUN_DIRECTORY_MISSING", error: "任务运行目录不存在（可能已被清理）" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  timer.unref?.();
  try {
    const baseRef = input.baseSha?.trim() || undefined;
    const diff = await collectDiff(plan.worktree, controller.signal, baseRef);
    return { ok: true as const, diff, baseSha: input.baseSha ?? null };
  } catch (error) {
    return { ok: false as const, status: 500, code: "DIFF_FAILED", error: diagnosticMessage(error, [], 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * B2: records a `run.merge_failed` event so the run timeline shows that a merge
 * failed and whether the workspace was verified back on its pre-merge branch and
 * HEAD. The event is best-effort: a callback outage must not change the merge
 * result, but a failed restore is logged loudly (never dressed up as success).
 */
async function recordMergeFailure(runId: string, result: Extract<GuardedMergeResult, { ok: false }>) {
  const originalBranch = result.original?.branch ?? null;
  const originalHead = result.original?.headSha ?? null;
  const where = originalBranch ?? `detached@${(originalHead ?? "unknown").slice(0, 12)}`;
  const message = result.restored
    ? `合并失败（${result.code}），工作区已恢复到合并前的 ${where}`
    : `合并失败（${result.code}），工作区恢复未通过校验：${diagnosticMessage(result.restoreError ?? "未知原因")}`;
  if (!result.restored) console.error(`[merge] ${runId} ${message}`);
  await postUpdate(runId, {
    event: {
      round: 1,
      source: "system",
      type: "run.merge_failed",
      message,
      meta: {
        code: result.code,
        restored: result.restored,
        originalBranch,
        originalHead,
        targetBranch: result.targetBranch ?? null,
        ...(result.restoreError ? { restoreError: diagnosticMessage(result.restoreError) } : {}),
        ...(result.conflictingPaths?.length ? { conflictingPaths: result.conflictingPaths } : {}),
      },
    },
  });
}

/**
 * A2/B2: merges a run branch into the workspace's default branch. Fast-forwards
 * when possible, otherwise creates a merge commit. Never force-pushes and never
 * auto-resolves conflicts. The whole operation runs inside `runGuardedMerge`,
 * which captures the workspace's original branch/HEAD before any mutation and,
 * on every failure path, aborts the merge and restores + verifies that state, so
 * "the workspace was left untouched" is actually true.
 */
export async function mergeRunBranch(input: {
  ownerId: string;
  runId: string;
  repository: string;
  branch: string;
  targetBranch?: string;
  message?: string;
}) {
  let plan;
  try {
    plan = planRunDirectoryRemoval(runsRoot, input.ownerId, input.runId);
  } catch (error) {
    if (error instanceof RunCleanupPathError) return { ok: false as const, status: 400, code: error.code, error: error.message };
    throw error;
  }
  const runDirExists = await stat(plan.worktree).then(() => true).catch(() => false);
  if (!runDirExists) return { ok: false as const, status: 404, code: "RUN_DIRECTORY_MISSING", error: "任务运行目录不存在（可能已被清理），无法合并" };

  let project: string;
  try {
    project = await resolveProject(input.repository);
  } catch (error) {
    return { ok: false as const, status: 400, code: "WORKSPACE_INVALID", error: diagnosticMessage(error) };
  }

  const exec: MergeGuardGitExec = (args, options) => runHardenedGit({ cwd: project, args, timeoutMs: options?.timeoutMs ?? 120_000 });
  const result = await runGuardedMerge({
    exec,
    sourcePath: plan.worktree,
    sourceBranch: input.branch,
    targetBranch: input.targetBranch,
    message: input.message,
    runId: input.runId,
  });
  if (!result.ok) {
    await recordMergeFailure(input.runId, result).catch((error) => {
      console.warn(`[merge] could not record run.merge_failed for ${input.runId}: ${diagnosticMessage(error)}`);
    });
  }
  return result;
}
