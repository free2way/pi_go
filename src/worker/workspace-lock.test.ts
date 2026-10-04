import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceLockManager, workspaceKeyFor } from "./workspace-lock.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "pigo-lock-"));
}

function manager(directory: string, options: { workerId?: string; staleMs?: number; now?: () => number } = {}) {
  return new WorkspaceLockManager({
    directory,
    workerId: options.workerId ?? "worker-a",
    staleMs: options.staleMs ?? 60_000,
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("workspaceKeyFor", () => {
  it("prefers an explicit workspace over the repository path (AT-RUN-012)", () => {
    expect(workspaceKeyFor({ workspaceId: "ws-1", repository: "apps/api" })).toBe("ws-1");
    expect(workspaceKeyFor({ repository: "apps/api" })).toBe("apps/api");
    expect(workspaceKeyFor({ workspaceId: "  ", repository: "apps/api" })).toBe("apps/api");
  });
});

describe("WorkspaceLockManager", () => {
  it("grants the lock to one run and rejects a concurrent run in the same workspace", async () => {
    const dir = await tempDir();
    const locks = manager(dir);
    const first = await locks.acquire("apps/api", "run-1");
    expect(first.acquired).toBe(true);
    expect(locks.isHeld("apps/api")).toBe("run-1");

    const second = await locks.acquire("apps/api", "run-2");
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("locked");
      expect(second.holder?.runId).toBe("run-1");
    }

    // A different workspace is unaffected.
    expect((await locks.acquire("apps/web", "run-3")).acquired).toBe(true);
    if (first.acquired) await first.handle.release();
  });

  it("lets another run start once the holder releases", async () => {
    const dir = await tempDir();
    const locks = manager(dir);
    const first = await locks.acquire("apps/api", "run-1");
    expect(first.acquired).toBe(true);
    if (first.acquired) await first.handle.release();
    expect(locks.isHeld("apps/api")).toBeUndefined();

    const second = await locks.acquire("apps/api", "run-2");
    expect(second.acquired).toBe(true);
    if (second.acquired) await second.handle.release();
  });

  it("reclaims a stale lock after the heartbeat timeout (crash safety)", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const locks = manager(dir, { now: () => now });
    const first = await locks.acquire("apps/api", "run-dead");
    expect(first.acquired).toBe(true);

    // The holder died without releasing: the lock file stays on disk. A second
    // run is rejected while the heartbeat is fresh...
    const blocked = await locks.acquire("apps/api", "run-2");
    expect(blocked.acquired).toBe(false);

    // ...and can take over once the lock goes stale.
    now += 61_000;
    const takeover = await locks.acquire("apps/api", "run-2");
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) {
      expect(takeover.reclaimedStale?.runId).toBe("run-dead");
      await takeover.handle.release();
    }
  });

  it("allows the same run to re-acquire its own lock after a worker restart", async () => {
    const dir = await tempDir();
    const crashed = manager(dir, { workerId: "worker-old" });
    const first = await crashed.acquire("apps/api", "run-1");
    expect(first.acquired).toBe(true);

    // A fresh process (empty in-memory map) resumes the same run immediately,
    // even though the old heartbeat is still inside the stale window.
    const restarted = manager(dir, { workerId: "worker-new" });
    const resumed = await restarted.acquire("apps/api", "run-1");
    expect(resumed.acquired).toBe(true);
    if (resumed.acquired) await resumed.handle.release();
  });

  it("keeps refreshing the heartbeat so a live holder is never reclaimed", async () => {
    const dir = await tempDir();
    let now = 5_000;
    const locks = manager(dir, { staleMs: 10_000, now: () => now });
    const held = await locks.acquire("apps/api", "run-1");
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    for (let i = 0; i < 3; i += 1) {
      now += 9_000;
      await held.handle.touch();
      const blocked = await locks.acquire("apps/api", "run-2");
      expect(blocked.acquired).toBe(false);
    }

    const persisted = JSON.parse(await readFile(locks.lockPath("apps/api"), "utf8")) as { runId: string; heartbeatAt: number };
    expect(persisted.runId).toBe("run-1");
    expect(persisted.heartbeatAt).toBe(now);
    await held.handle.release();
  });

  it("recovers from a corrupt lock file instead of wedging the workspace", async () => {
    const dir = await tempDir();
    const locks = manager(dir);
    await (await import("node:fs/promises")).writeFile(locks.lockPath("apps/api"), "{not json");
    const acquired = await locks.acquire("apps/api", "run-1");
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) await acquired.handle.release();
  });
});
