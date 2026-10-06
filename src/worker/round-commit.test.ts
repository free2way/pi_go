import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGuardedMerge } from "./merge-guard.js";
import { runHardenedGit } from "./git-hardening.js";
import { gitAvailable } from "./git-test-helpers.js";
import {
  commitRoundChanges,
  roundCommitIdentity,
  roundCommitSubject,
  type RoundCommitEvent,
  type RoundCommitGitExec,
} from "./round-commit.js";
import { captureSnapshotHash } from "./snapshot-hash.js";

const temporaryDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-round-commit-test-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const testIdentity = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

/** Hardened git in one fixture directory; throws on a non-zero exit. */
async function git(cwd: string, args: string[]) {
  const result = await runHardenedGit({ cwd, args, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The hardened runner blocks the `file` transport; the worker allows it for the
 * one local clone that creates the run directory (prepareRunDirectory). The
 * later `-c` wins over the hardened flag, exactly like production.
 */
async function gitLocalClone(cwd: string, args: string[]) {
  return git(cwd, ["-c", "protocol.file.allow=always", ...args]);
}

/** Production-shaped executor: args after `git`, cwd fixed to the run worktree. */
function execFor(cwd: string): RoundCommitGitExec {
  return (args, options) => runHardenedGit({ cwd, args, timeoutMs: options?.timeoutMs ?? 60_000 });
}

const snapshotExec = async (cwd: string, args: string[], options: { signal?: AbortSignal; env?: Record<string, string> } = {}) =>
  (await runHardenedGit({ cwd, args, signal: options.signal, env: options.env, timeoutMs: 60_000 })).stdout;

/** Mirrors the worker's `collectDiff` (intent-to-add, then diff against base). */
async function collectDiff(cwd: string, baseRef: string) {
  await git(cwd, ["add", "-N", "."]);
  return (await runHardenedGit({ cwd, args: ["diff", "--no-ext-diff", baseRef, "--", "."] })).stdout;
}

/** Bare `origin` with one commit + a clone standing in for the run worktree. */
async function initRunWorktree(branch = "run-branch") {
  const root = await tempDir();
  const workspace = path.join(root, "workspace");
  const run = path.join(root, "run");
  await mkdir(workspace);
  await git(root, ["init", "-q", "-b", "main", workspace]);
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  await git(workspace, ["add", "-A"]);
  await git(workspace, [...testIdentity, "commit", "-q", "-m", "base"]);
  const baseSha = await git(workspace, ["rev-parse", "HEAD"]);
  await gitLocalClone(root, ["clone", "--local", "--no-hardlinks", "--quiet", workspace, run]);
  await git(run, ["checkout", "-q", "-b", branch, baseSha]);
  return { root, workspace, run, baseSha };
}

describe("roundCommitSubject", () => {
  it("is deterministic and names the round", () => {
    expect(roundCommitSubject(3, "修复合并缺陷")).toBe("round 3: 修复合并缺陷");
    expect(roundCommitSubject(3, "修复合并缺陷")).toBe(roundCommitSubject(3, "修复合并缺陷"));
  });

  it("collapses newlines and caps the subject length", () => {
    expect(roundCommitSubject(1, "first line\nsecond line")).toBe("round 1: first line second line");
    const long = roundCommitSubject(2, "x".repeat(200));
    expect(long.endsWith("…")).toBe(true);
    expect(long).toBe(`round 2: ${"x".repeat(71)}…`);
  });

  it("falls back to a stable subject when the label is empty", () => {
    expect(roundCommitSubject(4, "   \n  ")).toBe("round 4: developer work");
  });
});

describe.skipIf(!gitAvailable)("commitRoundChanges (E2E-01b)", () => {
  it("is a no-op on a clean worktree: no commit, no new HEAD, no event", async () => {
    const { run } = await initRunWorktree();
    const headBefore = await git(run, ["rev-parse", "HEAD"]);
    const events: RoundCommitEvent[] = [];

    const result = await commitRoundChanges({ exec: execFor(run), round: 1, label: "task", emit: (event) => { events.push(event); } });

    expect(result).toEqual({ status: "clean" });
    expect(await git(run, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(run, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(events).toEqual([]);
  });

  it("commits a dirty worktree exactly once with the deterministic identity, subject and branch", async () => {
    const { run } = await initRunWorktree();
    await writeFile(path.join(run, "base.txt"), "base changed\n");
    await writeFile(path.join(run, "new.ts"), "export const added = true;\n");
    const events: RoundCommitEvent[] = [];

    const result = await commitRoundChanges({
      exec: execFor(run),
      round: 2,
      label: "single agent implementation",
      emit: (event) => { events.push(event); },
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.message).toBe("round 2: single agent implementation");
    expect(await git(run, ["branch", "--show-current"])).toBe("run-branch");
    expect(await git(run, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await git(run, ["log", "-1", "--format=%an <%ae>|%s"])).toBe(
      `${roundCommitIdentity.name} <${roundCommitIdentity.email}>|round 2: single agent implementation`,
    );
    // The commit is on the run branch (HEAD) and the worktree is clean again.
    expect(await git(run, ["rev-parse", "HEAD"])).toBe(result.commit);
    expect(await git(run, ["status", "--porcelain"])).toBe("");
    expect(events.map((event) => event.type)).toEqual(["round.committed"]);
    expect(events[0]?.meta?.commit).toBe(result.commit);
  });

  it("surfaces a commit failure as a visible event with the git error and keeps going", async () => {
    const { run } = await initRunWorktree();
    await writeFile(path.join(run, "base.txt"), "changed\n");
    const headBefore = await git(run, ["rev-parse", "HEAD"]);
    const events: RoundCommitEvent[] = [];
    const gitError = "fatal: unable to write new index file";
    const exec: RoundCommitGitExec = (args, options) =>
      args.includes("commit")
        ? Promise.resolve({ code: 128, stdout: "", stderr: gitError })
        : execFor(run)(args, options);

    const result = await commitRoundChanges({ exec, round: 5, label: "task", emit: (event) => { events.push(event); } });

    expect(result.status).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("round.commit_failed");
    expect(events[0]?.message).toContain(gitError);
    expect(events[0]?.meta).toMatchObject({ round: 5, error: expect.stringContaining(gitError) });
    // No partial commit: HEAD did not move and the change is still uncommitted.
    expect(await git(run, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(run, ["status", "--porcelain"])).not.toBe("");
  });

  it("never silently succeeds when the worktree status cannot be read", async () => {
    const { run } = await initRunWorktree();
    const events: RoundCommitEvent[] = [];
    const exec: RoundCommitGitExec = (args, options) =>
      args[0] === "status"
        ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: not a git repository" })
        : execFor(run)(args, options);

    const result = await commitRoundChanges({ exec, round: 1, label: "task", emit: (event) => { events.push(event); } });

    expect(result.status).toBe("failed");
    expect(events[0]?.type).toBe("round.commit_failed");
    expect(events[0]?.message).toContain("not a git repository");
  });

  it("commits a recovered round's leftover work once and never duplicates it", async () => {
    const { run, baseSha } = await initRunWorktree();
    // A previous execution already committed round 1 (HEAD moved off the base).
    await writeFile(path.join(run, "round1.txt"), "round 1\n");
    const first = await commitRoundChanges({ exec: execFor(run), round: 1, label: "task" });
    expect(first.status).toBe("committed");
    // The recovered round skipped the developer stage but left new work behind.
    await writeFile(path.join(run, "round2.txt"), "uncommitted repair\n");

    const recovered = await commitRoundChanges({ exec: execFor(run), round: 2, label: "task" });
    const second = await commitRoundChanges({ exec: execFor(run), round: 2, label: "task" });

    expect(recovered.status).toBe("committed");
    expect(second).toEqual({ status: "clean" });
    expect(await git(run, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(await git(run, ["status", "--porcelain"])).toBe("");
    // The round-2 diff against the pinned base is unaffected by the commit.
    expect(await collectDiff(run, baseSha)).toContain("round2.txt");
  });

  it("leaves the sub-agent/cherry-pick path unchanged: an already-committed branch is not re-committed", async () => {
    const { root, run } = await initRunWorktree();
    // Exactly like the worker: the sub-agent worktree is linked off the run
    // repository, commits its task, the worker cherry-picks that commit into the
    // run worktree and removes the sub-agent worktree.
    const sub = path.join(root, "sub-agent-task");
    await git(run, ["worktree", "add", "-q", "-b", "run-branch-sub-task", sub, "HEAD"]);
    await writeFile(path.join(sub, "sub.txt"), "sub agent work\n");
    await git(sub, ["add", "-A"]);
    await git(sub, [...testIdentity, "commit", "-q", "-m", "subagent: task"]);
    const subSha = await git(sub, ["rev-parse", "HEAD"]);
    await git(run, [...testIdentity, "cherry-pick", subSha]);
    const headAfterCherryPick = await git(run, ["rev-parse", "HEAD"]);
    await git(run, ["worktree", "remove", "--force", sub]);

    const result = await commitRoundChanges({ exec: execFor(run), round: 1, label: "task" });

    expect(result).toEqual({ status: "clean" });
    expect(await git(run, ["rev-parse", "HEAD"])).toBe(headAfterCherryPick);
    expect(await git(run, ["rev-list", "--count", "HEAD"])).toBe("2");
  });

  it("keeps the reviewed artifact byte-identical and content-addressed after the commit", async () => {
    const { run, baseSha } = await initRunWorktree();
    await writeFile(path.join(run, "base.txt"), "base changed\n");
    await writeFile(path.join(run, "new.ts"), "export const added = true;\n");

    const patchBefore = await collectDiff(run, baseSha);
    const hashBefore = await captureSnapshotHash(snapshotExec, run, undefined);

    const result = await commitRoundChanges({ exec: execFor(run), round: 3, label: "task" });

    const patchAfter = await collectDiff(run, baseSha);
    const hashAfter = await captureSnapshotHash(snapshotExec, run, undefined);

    expect(result.status).toBe("committed");
    // Content never changes: the merged patch and the checkpoint identity are
    // exactly the ones produced from the pre-commit worktree.
    expect(patchAfter).toBe(patchBefore);
    expect(hashAfter).toBe(hashBefore);
    // The committed tree *is* the reviewed content: nothing is silently added or
    // dropped by the commit, so a snapshot taken after it is still accurate.
    expect(await git(run, ["rev-parse", "HEAD^{tree}"])).toBe(hashAfter);
  });

  it("makes the round's work what the guarded merge actually fetches (E2E-01b regression)", async () => {
    const { workspace, run, baseSha } = await initRunWorktree();
    await writeFile(path.join(run, "feature.txt"), "hello\n");
    const merge = () => runGuardedMerge({
      exec: (args, options) => runHardenedGit({ cwd: workspace, args, timeoutMs: options?.timeoutMs ?? 120_000 }),
      sourcePath: run,
      sourceBranch: "run-branch",
      runId: "round-commit-regression",
      targetBranch: "main",
    });

    // Root cause, reproduced: merging with the change still uncommitted
    // fast-forwards to the base commit and reports success while nothing lands.
    const premature = await merge();
    expect(premature.ok).toBe(true);
    if (!premature.ok) return;
    expect(premature.strategy).toBe("fast-forward");
    expect(premature.commit).toBe(baseSha);
    expect((await runHardenedGit({ cwd: workspace, args: ["cat-file", "-e", "HEAD:feature.txt"] })).code).not.toBe(0);

    const committed = await commitRoundChanges({ exec: execFor(run), round: 1, label: "task" });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;

    const landed = await merge();
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.strategy).toBe("fast-forward");
    expect(landed.commit).toBe(committed.commit);
    expect((await runHardenedGit({ cwd: workspace, args: ["cat-file", "-e", "HEAD:feature.txt"] })).code).toBe(0);
  });

  it("commits untracked and deleted files but respects .gitignore", async () => {
    const { run } = await initRunWorktree();
    await writeFile(path.join(run, ".gitignore"), "ignored.bin\n");
    await git(run, ["add", "-A"]);
    await git(run, [...testIdentity, "commit", "-q", "-m", "ignore rules"]);
    await writeFile(path.join(run, "ignored.bin"), "secret\n");
    await writeFile(path.join(run, "tracked.txt"), "tracked\n");
    await rm(path.join(run, "base.txt"));

    const result = await commitRoundChanges({ exec: execFor(run), round: 1, label: "task" });
    expect(result.status).toBe("committed");
    const status = await git(run, ["show", "--name-status", "--format=", "HEAD"]);
    expect(status).toContain("A\ttracked.txt");
    expect(status).toContain("D\tbase.txt");
    expect(status).not.toContain("ignored.bin");
    expect(await git(run, ["status", "--porcelain"])).toBe("");
  });
});
