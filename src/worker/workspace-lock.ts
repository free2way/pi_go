import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync as rmSyncNative } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * GAP-05 / AT-RUN-012: only one run may execute against a given workspace at a
 * time. The lock is represented by a JSON file on disk (so it is visible to any
 * worker process sharing the workspace root) plus an in-process map (so two
 * async call stacks in the same worker cannot both win the race).
 *
 * Ownership (NEW-06): every lease carries a non-reusable `token` minted on
 * acquire. A run id is *not* sufficient to own a lock: `touch()`/`release()`
 * must present the exact token that was written, so a former holder whose lease
 * was taken over can no longer refresh or delete the new holder's lock.
 *
 * Staleness / crash safety: a lock is never permanent. Every holder refreshes
 * `heartbeatAt`; a lock whose heartbeat is older than `staleMs` is abandoned
 * and may be taken over — even by the same run id (worker restart). Takeover is
 * a compare-and-swap: the stale file is first claimed with an atomic `rename`,
 * which only one racer can win, then re-verified for staleness and replaced with
 * an exclusive (`wx`) create. Two live managers therefore never both acquire.
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
  /**
   * Non-reusable ownership token, minted per acquisition (NEW-06). Absent only
   * on locks written by an older version; such locks can never be touched or
   * released by a token-bearing handle.
   */
  token?: string;
}

export interface WorkspaceLockHandle {
  readonly key: string;
  readonly runId: string;
  /**
   * Refreshes the on-disk heartbeat so the lock is not considered stale.
   * Returns `false` when this handle no longer owns the lock (its lease was
   * taken over), in which case nothing is written.
   */
  touch(): Promise<boolean>;
  /**
   * Removes the lock when this handle still owns it. Safe to call twice.
   * Returns `true` when this call removed the lock it owned, `false` when the
   * lock was already gone or is now owned by someone else (no-op).
   */
  release(): Promise<boolean>;
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

type TakeoverResult =
  | { acquired: true; reclaimedStale?: WorkspaceLockInfo }
  | { acquired: false; holder?: WorkspaceLockInfo };

/** A lock we minted ourselves, so the ownership token is always present. */
type OwnedLockInfo = WorkspaceLockInfo & { token: string };

/** Workspace identity: an explicit workspace wins over the repository path. */
export function workspaceKeyFor(run: { workspaceId?: string; repository: string }): string {
  const explicit = run.workspaceId?.trim();
  return explicit && explicit.length > 0 ? explicit : run.repository;
}

function lockFileName(key: string) {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock.json`;
}

function parseLock(raw: string): WorkspaceLockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as WorkspaceLockInfo;
    if (!parsed || typeof parsed.runId !== "string" || typeof parsed.heartbeatAt !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
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
    if (local) {
      // A live in-process lease (even for the same run id) blocks re-acquire;
      // a stale one (holder paused without touching) is dropped so the on-disk
      // logic can reclaim it.
      if (timestamp - local.heartbeatAt < this.staleMs) return { acquired: false, reason: "locked", holder: local };
      this.held.delete(key);
    }

    const candidate: OwnedLockInfo = {
      key,
      runId,
      workerId: this.workerId,
      pid: this.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      token: randomUUID(),
    };
    const lockPath = this.lockPath(key);

    // Fast path: no lock on disk. Atomic create picks a single winner.
    if (await this.createExclusive(lockPath, candidate)) {
      this.held.set(key, candidate);
      return { acquired: true, handle: this.handle(candidate) };
    }

    const existing = await this.readLock(lockPath);
    // A fresh heartbeat blocks everyone, the same run id included (NEW-06): a
    // live holder must never be displaced without proof it stopped touching.
    if (existing && timestamp - existing.heartbeatAt < this.staleMs) {
      return { acquired: false, reason: "locked", holder: existing };
    }

    // Missing, corrupt, or stale: reclaim it via compare-and-swap. Only one
    // racer can win, so two managers can never both report `acquired: true`.
    const takeover = await this.takeover(lockPath, candidate);
    if (!takeover.acquired) {
      return { acquired: false, reason: "locked", ...(takeover.holder ? { holder: takeover.holder } : {}) };
    }
    this.held.set(key, candidate);
    const reclaimed = takeover.reclaimedStale ?? existing;
    return { acquired: true, handle: this.handle(candidate), ...(reclaimed ? { reclaimedStale: reclaimed } : {}) };
  }

  /** Releases every lock this process still holds (best effort, sync). */
  releaseAllSync() {
    for (const info of this.held.values()) {
      const lockPath = this.lockPath(info.key);
      try {
        const onDisk = parseLock(readFileSync(lockPath, "utf8"));
        // Do not delete a lock a different lease has since taken over.
        if (onDisk?.token !== info.token) continue;
        rmSyncNative(lockPath, { force: true });
      } catch {
        // Best effort: a leftover lock is reclaimed once it goes stale.
      }
    }
    this.held.clear();
  }

  private handle(info: OwnedLockInfo): WorkspaceLockHandle {
    const { key, runId, token } = info;
    const lockPath = this.lockPath(key);
    return {
      key,
      runId,
      touch: async () => {
        const current = this.held.get(key);
        // Lease lost (displaced by a takeover): never resurrect the lock.
        if (!current || current.token !== token) return false;
        const onDisk = await this.readLock(lockPath);
        if (!onDisk || onDisk.token !== token) return false;
        current.heartbeatAt = this.now();
        await this.writeLock(lockPath, current);
        return true;
      },
      release: async () => {
        const current = this.held.get(key);
        if (!current || current.token !== token) return false;
        this.held.delete(key);
        return this.removeOwnedLock(lockPath, token);
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

  /**
   * Compare-and-swap takeover of a lock that is already known to be stale (or
   * corrupt). The existing file is atomically moved aside with `rename` — a
   * single winner — then re-verified: if a live holder refreshed it in the
   * meantime it is restored untouched and we report `locked`. Otherwise a new
   * lock is written with an exclusive create, so a racer that grabbed the freed
   * name first is honoured instead of clobbered.
   */
  private async takeover(lockPath: string, next: OwnedLockInfo): Promise<TakeoverResult> {
    const stolenPath = `${lockPath}.${next.token}.steal`;
    let raw: string;
    try {
      await rename(lockPath, stolenPath);
      raw = await readFile(stolenPath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // The file vanished (released, or another racer claimed it first): only an
      // exclusive create can win the now-empty slot.
      if (await this.createExclusive(lockPath, next)) return { acquired: true };
      const holder = await this.readLock(lockPath);
      return { acquired: false, ...(holder ? { holder } : {}) };
    }

    const claimed = parseLock(raw);
    const stale = !claimed || this.now() - claimed.heartbeatAt >= this.staleMs;
    if (!stale) {
      // We moved a lock that is still being refreshed: put it back rather than
      // clobbering a live worker.
      await this.restore(lockPath, raw);
      await this.removeFile(stolenPath);
      return { acquired: false, ...(claimed ? { holder: claimed } : {}) };
    }

    if (await this.createExclusive(lockPath, next)) {
      await this.removeFile(stolenPath);
      return { acquired: true, ...(claimed ? { reclaimedStale: claimed } : {}) };
    }
    // Another racer re-created the lock while the slot was free: yield to it.
    await this.removeFile(stolenPath);
    const holder = await this.readLock(lockPath);
    return { acquired: false, ...(holder ? { holder } : {}) };
  }

  /**
   * Atomically removes the lock only if it still carries our token. The file is
   * moved aside first so a concurrent takeover cannot interleave between the
   * ownership check and the delete; a foreign lock is restored untouched.
   */
  private async removeOwnedLock(lockPath: string, token: string): Promise<boolean> {
    const trashPath = `${lockPath}.${token}.release`;
    let raw: string;
    try {
      await rename(lockPath, trashPath);
      raw = await readFile(trashPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return false; // already gone, or never ours
      throw error;
    }
    const onDisk = parseLock(raw);
    if (onDisk?.token === token) {
      await this.removeFile(trashPath);
      return true;
    }
    // The moved file belonged to a newer lease: restore it and report no-op.
    await this.restore(lockPath, raw);
    await this.removeFile(trashPath);
    return false;
  }

  /** Best-effort put-back of a lock file we moved aside but did not consume. */
  private async restore(lockPath: string, raw: string) {
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(lockPath, raw, { flag: "wx" });
    } catch {
      // EEXIST (someone else claimed the slot) or any other error: leaving the
      // newer lock in place is correct; the stale copy is discarded by caller.
    }
  }

  private async removeFile(target: string) {
    await rm(target, { force: true }).catch(() => undefined);
  }

  private async readLock(lockPath: string): Promise<WorkspaceLockInfo | undefined> {
    try {
      return parseLock(await readFile(lockPath, "utf8"));
    } catch {
      return undefined;
    }
  }
}
