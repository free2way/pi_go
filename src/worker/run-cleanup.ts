import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * GAP-04 storage follow-up: removes a finished run's on-disk directory tree
 * (`<runsRoot>/<ownerId>/<runId>`, its `.state` Pi session directory, any
 * reviewer snapshots `<runId>.reviewer-r<round>(.state)` and everything nested
 * below, including sub-agent worktrees).
 *
 * Safety model (defense in depth against traversal):
 * - the owner id and run id must match the exact formats the worker itself
 *   produces, so no separator or `..` can ever reach `path.join`;
 * - the runs root and the owner directory are `realpath`-resolved and the owner
 *   directory must stay inside the runs root;
 * - symlinks are unlinked, never traversed, so a link pointing outside the runs
 *   root can never cause a delete outside it.
 */
export class RunCleanupPathError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Owner ids are the 64-hex internal identity used by `executeJob`. */
const OWNER_ID_PATTERN = /^[a-f0-9]{64}$/;
/** Run ids look like `run_<20 hex>` (see `newId` in the server store). */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export interface RunDirectoryPlan {
  runsRoot: string;
  parent: string;
  worktree: string;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure validation/build step: returns the resolved paths for a run directory or
 * throws `RunCleanupPathError`. No filesystem access, so it is trivially
 * testable and cannot be bypassed by a malformed request body.
 */
export function planRunDirectoryRemoval(runsRoot: string, ownerId: string, runId: string): RunDirectoryPlan {
  if (!OWNER_ID_PATTERN.test(ownerId)) throw new RunCleanupPathError("RUN_PATH_INVALID", "Invalid run owner id");
  if (!RUN_ID_PATTERN.test(runId)) throw new RunCleanupPathError("RUN_PATH_INVALID", "Invalid run id");
  const root = path.resolve(runsRoot);
  const parent = path.join(root, ownerId);
  const worktree = path.join(parent, runId);
  const relative = path.relative(root, worktree);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RunCleanupPathError("RUN_PATH_OUTSIDE_ROOT", "Run directory resolves outside the runs root");
  }
  return { runsRoot: root, parent, worktree };
}

/** True for every on-disk entry owned by a run inside `<runsRoot>/<owner>`. */
export function isRunDirectoryEntry(runId: string, entry: string): boolean {
  if (entry === runId || entry === `${runId}.state`) return true;
  return new RegExp(`^${escapeRegExp(runId)}\\.reviewer-r\\d+(?:\\.state)?$`).test(entry);
}

export interface RunDirectoryRemovalResult {
  runId: string;
  ownerId: string;
  dryRun: boolean;
  /** True when at least one entry existed (and was, or would be, removed). */
  removed: boolean;
  /** Entries relative to the runs root that were (or would be) removed. */
  paths: string[];
  /** Total file bytes reclaimed; symlinks count their link size, never the target. */
  bytes: number;
}

/**
 * Recursively removes `target` without ever following a symlink, returning the
 * bytes it covered. In `dryRun` mode it only measures.
 */
async function removeTarget(target: string, dryRun: boolean): Promise<number> {
  const info = await lstat(target).catch(() => undefined);
  if (!info) return 0;
  if (info.isSymbolicLink()) {
    if (!dryRun) await unlink(target).catch(() => undefined);
    return info.size;
  }
  if (info.isDirectory()) {
    let bytes = 0;
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      bytes += await removeTarget(path.join(target, entry.name), dryRun);
    }
    if (!dryRun) await rmdir(target).catch(() => undefined);
    return bytes;
  }
  if (!dryRun) await unlink(target).catch(() => undefined);
  return info.size;
}

/**
 * Idempotently removes every on-disk artifact belonging to a run. A missing
 * runs root, owner directory or run entry is a success with nothing to remove.
 */
export async function removeRunDirectory(input: {
  runsRoot: string;
  ownerId: string;
  runId: string;
  dryRun?: boolean;
}): Promise<RunDirectoryRemovalResult> {
  const plan = planRunDirectoryRemoval(input.runsRoot, input.ownerId, input.runId);
  const dryRun = Boolean(input.dryRun);
  const empty: RunDirectoryRemovalResult = {
    runId: input.runId,
    ownerId: input.ownerId,
    dryRun,
    removed: false,
    paths: [],
    bytes: 0,
  };

  const rootReal = await realpath(plan.runsRoot).catch(() => undefined);
  if (!rootReal) return empty;
  const parentReal = await realpath(plan.parent).catch(() => undefined);
  if (!parentReal) return empty;
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new RunCleanupPathError("RUN_PATH_OUTSIDE_ROOT", "Run owner directory resolves outside the runs root");
  }

  const entries = await readdir(parentReal, { withFileTypes: true }).catch(() => []);
  const targets = entries
    .filter((entry) => isRunDirectoryEntry(input.runId, entry.name))
    .map((entry) => path.join(parentReal, entry.name));
  if (targets.length === 0) return empty;

  let bytes = 0;
  const paths: string[] = [];
  for (const target of targets) {
    bytes += await removeTarget(target, dryRun);
    paths.push(path.relative(rootReal, target));
  }
  return { runId: input.runId, ownerId: input.ownerId, dryRun, removed: true, paths, bytes };
}
