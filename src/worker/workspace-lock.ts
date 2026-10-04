import { createHash } from "node:crypto";
import { rmSync as rmSyncNative } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * GAP-05 / AT-RUN-012: only one run may execute against a given workspace at a
 * time. The lock is represented by a JSON file on disk (so it is visible to any
 * worker process sharing the workspace root) plus an in-process map (so two
 * async call stacks in the same worker cannot both win the race).
 *
 * Crash safety: a lock is never permanent. Every holder refreshes
 * `heartbeatAt`; a lock whose heartbeat is older than `staleMs` is treated as
 * abandoned and reclaimed. A worker restart therefore leaves no workspace
 * permanently locked, and the same run id may always re-acquire its own lock
 * (recovery after restart).
 */
export interface WorkspaceLockInfo {
  /** Workspace identity this lock guards (see `workspaceKeyFor`). */
  key: string;
  /** Run currently holding the lock. */
  runId: string;
  workerId: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface WorkspaceLockHandle {
  readonly key: string;
  readonly runId: string;
  /** Refreshes the on-disk heartbeat so the lock is not considered stale. */
  touch(): Promise<void>;
  /** Removes the lock when this handle still owns it. Safe to call twice. */
  release(): Promise<void>;
}

export type AcquireResult =
  | { acquired: true; handle: WorkspaceLockHandle; reclaimedStale?: WorkspaceLockInfo }
  | { acquired: false; reason: "locked"; holder?: WorkspaceLockInfo };

export interface WorkspaceLockOptions {
  /** Directory holding the lock files (shared by all worker processes). */
  directory: string;
  workerId: string;
  /** How long a lock may go without a heartbeat before it is stale. */
  staleMs?: number;
  now?: () => number;
  pid?: number;
}

/** Workspace identity: an explicit workspace wins over the repository path. */
export function workspaceKeyFor(run: { workspaceId?: string; repository: string }): string {
  const explicit = run.workspaceId?.trim();
  return explicit && explicit.length > 0 ? explicit : run.repository;
}

function lockFileName(key: string) {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock.json`;
}

export class WorkspaceLockManager {
  private readonly directory: string;
  private readonly workerId: string;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly held = new Map<string, WorkspaceLockInfo>();

  constructor(options: WorkspaceLockOptions) {
    this.directory = options.directory;
    this.workerId = options.workerId;
    this.staleMs = options.staleMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  /** Fast in-process check: run id currently holding the workspace, if any. */
  isHeld(key: string): string | undefined {
    return this.held.get(key)?.runId;
  }

  lockPath(key: string) {
    return path.join(this.directory, lockFileName(key));
  }

  async acquire(key: string, runId: string): Promise<AcquireResult> {
    const timestamp = this.now();
    const local = this.held.get(key);
    if (local && local.runId !== runId) {
      // A stale in-process entry (holder died without releasing) must not wedge
      // the workspace; fall through so the on-disk logic can reclaim it.
      if (timestamp - local.heartbeatAt < this.staleMs) return { acquired: false, reason: "locked", holder: local };
      this.held.delete(key);
    }

    const candidate: WorkspaceLockInfo = {
      key,
      runId,
      workerId: this.workerId,
      pid: this.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    };
    const lockPath = this.lockPath(key);

    // Atomic create: only one process can create the file, the loser re-reads it.
    const created = await this.createExclusive(lockPath, candidate);
    if (created) {
      this.held.set(key, candidate);
      return { acquired: true, handle: this.handle(key, runId) };
    }

    const existing = await this.readLock(lockPath);
    if (existing && existing.runId === runId) {
      // Same run resuming after a worker restart: the previous process is gone.
      await this.writeLock(lockPath, candidate);
      this.held.set(key, candidate);
      return { acquired: true, handle: this.handle(key, runId), reclaimedStale: existing };
    }
    if (existing && timestamp - existing.heartbeatAt < this.staleMs) {
      return { acquired: false, reason: "locked", holder: existing };
    }
    // Missing, unreadable or stale: reclaim it and record who we displaced.
    await this.writeLock(lockPath, candidate);
    this.held.set(key, candidate);
    return { acquired: true, handle: this.handle(key, runId), ...(existing ? { reclaimedStale: existing } : {}) };
  }

  /** Releases every lock this process still holds (best effort, sync). */
  releaseAllSync() {
    for (const key of this.held.keys()) {
      try {
        rmSyncNative(this.lockPath(key), { force: true });
      } catch {
        // Best effort: a leftover lock is reclaimed once it goes stale.
      }
    }
    this.held.clear();
  }

  private handle(key: string, runId: string): WorkspaceLockHandle {
    return {
      key,
      runId,
      touch: async () => {
        const current = this.held.get(key);
        if (!current || current.runId !== runId) return;
        current.heartbeatAt = this.now();
        await this.writeLock(this.lockPath(key), current);
      },
      release: async () => {
        const current = this.held.get(key);
        if (!current || current.runId !== runId) return;
        this.held.delete(key);
        const onDisk = await this.readLock(this.lockPath(key));
        if (!onDisk || onDisk.runId !== runId) return;
        await rm(this.lockPath(key), { force: true }).catch(() => undefined);
      },
    };
  }

  private async createExclusive(lockPath: string, info: WorkspaceLockInfo): Promise<boolean> {
    try {
      await writeFile(lockPath, JSON.stringify(info), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await mkdir(this.directory, { recursive: true });
        try {
          await writeFile(lockPath, JSON.stringify(info), { flag: "wx" });
          return true;
        } catch (retry) {
          if ((retry as NodeJS.ErrnoException).code !== "EEXIST") throw retry;
          return false;
        }
      }
      return false;
    }
  }

  private async writeLock(lockPath: string, info: WorkspaceLockInfo) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(lockPath, JSON.stringify(info));
  }

  private async readLock(lockPath: string): Promise<WorkspaceLockInfo | undefined> {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as WorkspaceLockInfo;
      if (!parsed || typeof parsed.runId !== "string" || typeof parsed.heartbeatAt !== "number") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}
