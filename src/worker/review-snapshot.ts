import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Finding } from "../shared/types.js";

/**
 * GAP-03 / AT-REVIEW-012 / AT-GIT-005 / AT-SEC-009:
 * before the review phase the worker materializes a throwaway, immutable copy of
 * the developer worktree. The reviewer reads only that copy, so nothing it does
 * can reach the developer's own (possibly still running) working tree.
 *
 * The copy is created from a git tree object, never by linking the developer
 * repository's own `.git/worktrees` metadata (that would hand the developer
 * process a handle on the reviewer's directory and vice versa).
 */

export interface MaterializedReviewSnapshot {
  /** git tree hash of the developer worktree captured for this review. */
  developerTreeHash: string;
  /** git tree hash the snapshot directory was materialized from. */
  snapshotTreeHash: string;
  /** Developer tree hash recomputed after materialization (mutation detector). */
  developerTreeHashAfter: string;
  /** Synthetic commit object that pins `snapshotTreeHash` with the developer HEAD as parent. */
  commit: string;
}

export interface ReviewSnapshotRequest {
  worktree: string;
  snapshotDir: string;
  signal?: AbortSignal;
}

export type ReviewSnapshotMaterializer = (request: ReviewSnapshotRequest) => Promise<MaterializedReviewSnapshot>;

export interface GitExecOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Runs one hardened git command and resolves with its trimmed stdout. */
export type GitExec = (cwd: string, args: string[], options?: GitExecOptions) => Promise<string>;

/** AUD-01: hooks/credential helpers/local config stay disabled for snapshot git. */
const hardenedGitFlags = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.file.allow=never",
  "-c", "gc.auto=0",
  "-c", "advice.detachedHead=false",
];

const maxCapturedOutput = 4_000_000;

export const defaultGitExec: GitExec = (cwd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...hardenedGitFlags, ...args], {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-maxCapturedOutput); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-maxCapturedOutput); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
    });
  });

/** Extracts a `git archive --format=tar` file into `dir` without preserving git metadata. */
export type ArchiveExtractor = (archive: string, dir: string) => Promise<void>;

async function extractArchive(archive: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar exited with ${code}`));
    });
  });
}

/**
 * Real materializer: writes the current worktree (tracked, staged and untracked,
 * but not ignored files) into a tree object using a scratch index so the
 * developer's own index is never touched, then checks that tree out with
 * `git archive` into a sibling directory.
 */
export function createGitReviewSnapshotMaterializer(
  exec: GitExec = defaultGitExec,
  extract: ArchiveExtractor = extractArchive,
): ReviewSnapshotMaterializer {
  return async ({ worktree, snapshotDir, signal }) => {
    const head = await exec(worktree, ["rev-parse", "HEAD"], { signal });
    const scratch = await mkdtemp(path.join(os.tmpdir(), "pigo-review-snapshot-"));
    const indexFile = path.join(scratch, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    const captureTree = async () => {
      await exec(worktree, ["read-tree", head], { env, signal });
      await exec(worktree, ["add", "-A", "--", "."], { env, signal });
      return (await exec(worktree, ["write-tree"], { env, signal })).trim();
    };
    try {
      const developerTreeHash = await captureTree();
      const commit = await exec(worktree, [
        "-c", "user.name=PiGO Reviewer Snapshot",
        "-c", "user.email=review-snapshot@pigo.local",
        "commit-tree", developerTreeHash, "-p", head, "-m", "pigo review snapshot",
      ], { signal });
      const archive = path.join(scratch, "snapshot.tar");
      await exec(worktree, ["archive", "--format=tar", `--output=${archive}`, developerTreeHash], { signal });
      await rm(snapshotDir, { recursive: true, force: true });
      await extract(archive, snapshotDir);
      const snapshotTreeHash = (await exec(worktree, ["rev-parse", `${commit}^{tree}`], { signal })).trim();
      // Recomputed after materialization: a difference means the developer
      // process touched the worktree while the snapshot was being taken.
      const developerTreeHashAfter = await captureTree();
      return { developerTreeHash, snapshotTreeHash, developerTreeHashAfter, commit };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export interface DivergenceInput {
  developerTreeHash: string;
  snapshotTreeHash: string;
  developerTreeHashAfter?: string;
}

export interface DivergenceResult {
  divergent: boolean;
  reasons: string[];
}

function shortHash(hash: string) {
  return hash.slice(0, 12);
}

/**
 * GAP-03 divergence rule. The docs require the developer worktree tree hash to
 * be unchanged by the review (AT-GIT-005) and never document a tolerated drift,
 * so the threshold is exact equality: any mismatch escalates instead of
 * silently reviewing a different tree.
 */
export function evaluateSnapshotDivergence(input: DivergenceInput): DivergenceResult {
  const reasons: string[] = [];
  if (input.developerTreeHash !== input.snapshotTreeHash) {
    reasons.push(`快照 tree ${shortHash(input.snapshotTreeHash)} 与开发 tree ${shortHash(input.developerTreeHash)} 不一致`);
  }
  if (input.developerTreeHashAfter && input.developerTreeHashAfter !== input.snapshotTreeHash) {
    reasons.push(`创建快照后开发 worktree 又被修改（${shortHash(input.developerTreeHashAfter)} ≠ ${shortHash(input.snapshotTreeHash)}）`);
  }
  return { divergent: reasons.length > 0, reasons };
}

/** Blocking finding raised when the reviewer snapshot and the developer tree disagree. */
export function buildSnapshotDivergenceFinding(round: number, reasons: string[]): Omit<Finding, "resolved"> {
  return {
    id: `snapshot-divergence-r${round}`,
    severity: "critical",
    file: null,
    line: null,
    title: "审核快照与开发 worktree 的 tree hash 不一致",
    evidence: reasons.join("；").slice(0, 4_000),
    requiredChange: "已阻断本轮审核。人工确认开发 worktree 的额外修改后重新运行审核，避免审核的代码与实际交付不一致。",
  };
}

/** Immutable snapshot directory name (sibling of the worktree, never inside it). */
export function reviewSnapshotDirectory(worktree: string, round: number) {
  return `${worktree}.reviewer-r${round}`;
}

/** Removes a one-shot reviewer snapshot (and its Pi state) after the review ends. */
export async function destroyReviewSnapshot(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  await rm(`${directory}.state`, { recursive: true, force: true }).catch(() => undefined);
}
