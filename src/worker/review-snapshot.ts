import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../shared/types.js";
import { hardenedGitConfigArgs, hardenedGitEnvironment, hardenedGitFlags } from "./git-hardening.js";

/**
 * GAP-03 / AT-REVIEW-012 / AT-GIT-005 / AT-SEC-009:
 * before the review phase the worker materializes a throwaway, immutable copy of
 * the developer worktree. The reviewer reads only that copy, so nothing it does
 * can reach the developer's own (possibly still running) working tree.
 *
 * NEW-02: the copy is made by walking the developer worktree directly instead of
 * `git archive`, so repository export attributes (`export-ignore`,
 * `export-subst`) can no longer silently remove or rewrite delivered files.
 * Both sides of the divergence check are content manifests of the *actual*
 * files (path + normalized mode + content hash, sorted), never a Git tree OID
 * read back from the original commit.
 */

export interface MaterializedReviewSnapshot {
  /** Normalized content manifest of the developer worktree captured for review. */
  developerTreeHash: string;
  /** Normalized content manifest of the directory that was actually materialized. */
  snapshotTreeHash: string;
  /** Developer manifest recomputed after materialization (mutation detector). */
  developerTreeHashAfter: string;
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

/** Runs one hardened git command and resolves with its stdout. */
export type GitExec = (cwd: string, args: string[], options?: GitExecOptions) => Promise<string>;

const maxCapturedOutput = 4_000_000;

/**
 * AUD-01 / NEW-01: hooks, credential helpers, repository-local filters and the
 * full Worker environment stay out of every snapshot Git command.
 */
export const defaultGitExec: GitExec = async (cwd, args, options = {}) => {
  const configArgs = await hardenedGitConfigArgs(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...hardenedGitFlags, ...configArgs, ...args], {
      cwd,
      env: { ...hardenedGitEnvironment(options.env), ...(options.env ?? {}) },
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
};

// ---------------------------------------------------------------- manifest

export interface ManifestEntry {
  /** Worktree-relative path using `/` separators, compared case-sensitively. */
  path: string;
  /** Normalized mode: `100644`, `100755` or `120000` (symlink). */
  mode: string;
  type: "blob" | "symlink";
  /** sha256 of the file bytes (blob) or of the link target (symlink). */
  hash: string;
}

/** Stable, sorted, content-addressed hash of a set of manifest entries. */
export function manifestHash(entries: ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash("sha256");
  digest.update(`pigo-review-manifest-v1\n${sorted.length}\n`);
  for (const entry of sorted) {
    digest.update(`${entry.mode} ${entry.type} ${entry.hash} ${entry.path}\n`);
  }
  return digest.digest("hex").slice(0, 40);
}

function hashBuffer(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Hashes one worktree-relative path into a manifest entry (or `undefined` when absent). */
async function entryForPath(root: string, relative: string): Promise<ManifestEntry | undefined> {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) {
    const target = await readlink(absolute).catch(() => "");
    return { path: relative, mode: "120000", type: "symlink", hash: hashBuffer(target) };
  }
  if (!info.isFile()) return undefined;
  const content = await readFile(absolute).catch(() => undefined);
  if (!content) return undefined;
  return { path: relative, mode: info.mode & 0o111 ? "100755" : "100644", type: "blob", hash: hashBuffer(content) };
}

/** Recursively hashes every real file/symlink under `root` (never follows links). */
export async function hashDirectory(root: string, signal?: AbortSignal): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  async function walk(relativeDir: string): Promise<void> {
    signal?.throwIfAborted();
    const directory = relativeDir ? path.join(root, relativeDir) : root;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(relative);
        continue;
      }
      const entry = await entryForPath(root, relative);
      if (entry) entries.push(entry);
    }
  }
  await walk("");
  return entries;
}

/** Lists the tracked + untracked (non-ignored) paths of a worktree via Git. */
async function listWorktreePaths(exec: GitExec, worktree: string, signal?: AbortSignal): Promise<string[]> {
  const staged = await exec(worktree, ["-c", "core.quotePath=false", "ls-files", "-s", "-z"], { signal });
  const untracked = await exec(worktree, ["-c", "core.quotePath=false", "ls-files", "-o", "--exclude-standard", "-z"], { signal });
  const paths = new Set<string>();
  for (const record of staged.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const mode = meta[0];
    // Submodule gitlinks are not materialized (their content is not part of this
    // worktree), so they are excluded from both sides of the comparison.
    if (mode === "160000") continue;
    paths.add(record.slice(tab + 1));
  }
  for (const record of untracked.split("\0")) {
    if (record) paths.add(record);
  }
  return [...paths];
}

async function developerEntries(exec: GitExec, worktree: string, signal?: AbortSignal): Promise<ManifestEntry[]> {
  const paths = await listWorktreePaths(exec, worktree, signal);
  const entries: ManifestEntry[] = [];
  for (const relative of paths) {
    const entry = await entryForPath(worktree, relative);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Copies one manifest entry from the developer worktree into the snapshot dir. */
async function copyEntry(source: string, destination: string, entry: ManifestEntry): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (entry.type === "symlink") {
    const target = await readlink(path.join(source, entry.path)).catch(() => "");
    await rm(destination, { force: true }).catch(() => undefined);
    await symlink(target, destination);
    return;
  }
  await copyFile(path.join(source, entry.path), destination);
}

/**
 * Real materializer: lists the developer worktree (tracked, staged, intent-to-add
 * and untracked, but not ignored files), copies every file/symlink into the
 * reviewer directory and hashes both sides into independent content manifests.
 * No `git archive`, so `export-ignore`/`export-subst` cannot affect what the
 * reviewer sees.
 */
export function createGitReviewSnapshotMaterializer(exec: GitExec = defaultGitExec): ReviewSnapshotMaterializer {
  return async ({ worktree, snapshotDir, signal }) => {
    const before = await developerEntries(exec, worktree, signal);
    await rm(snapshotDir, { recursive: true, force: true });
    await mkdir(snapshotDir, { recursive: true });
    for (const entry of before) {
      signal?.throwIfAborted();
      await copyEntry(worktree, path.join(snapshotDir, entry.path), entry);
    }
    // NEW-02: hash the directory that was actually materialized, then re-hash
    // the developer worktree so a concurrent mutation is still detected.
    const snapshotTreeHash = manifestHash(await hashDirectory(snapshotDir, signal));
    const developerTreeHash = manifestHash(before);
    const developerTreeHashAfter = manifestHash(await developerEntries(exec, worktree, signal));
    return { developerTreeHash, snapshotTreeHash, developerTreeHashAfter };
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
 * GAP-03 divergence rule. The docs require the developer worktree content to be
 * unchanged by the review (AT-GIT-005) and never document a tolerated drift, so
 * the threshold is exact equality: any mismatch escalates instead of silently
 * reviewing a different tree.
 */
export function evaluateSnapshotDivergence(input: DivergenceInput): DivergenceResult {
  const reasons: string[] = [];
  if (input.developerTreeHash !== input.snapshotTreeHash) {
    reasons.push(`快照内容 ${shortHash(input.snapshotTreeHash)} 与开发内容 ${shortHash(input.developerTreeHash)} 不一致`);
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
    title: "审核快照与开发 worktree 的内容哈希不一致",
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
