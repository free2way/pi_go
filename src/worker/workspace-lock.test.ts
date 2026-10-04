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

  it("does not let a second worker displace a live same-run lock, but takes over once stale (NEW-06)", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const crashed = manager(dir, { workerId: "worker-old", now: () => now });
    const first = await crashed.acquire("apps/api", "run-1");
    expect(first.acquired).toBe(true);

    // A fresh process (empty in-memory map) resumes the same run: a shared run
    // id alone must not displace the live holder while the heartbeat is fresh.
    const restarted = manager(dir, { workerId: "worker-new", now: () => now });
    const blocked = await restarted.acquire("apps/api", "run-1");
    expect(blocked.acquired).toBe(false);
    if (!blocked.acquired) expect(blocked.holder?.runId).toBe("run-1");

    // Once the heartbeat goes stale the same run id may take over (recovery).
    now += 61_000;
    const resumed = await restarted.acquire("apps/api", "run-1");
    expect(resumed.acquired).toBe(true);
    if (resumed.acquired) {
      expect(resumed.reclaimedStale?.runId).toBe("run-1");
      await resumed.handle.release();
    }
  });

  it("grants a same-run lock to at most one of two racing managers while fresh (NEW-06)", async () => {
    const dir = await tempDir();
    const a = manager(dir, { workerId: "worker-a" });
    const b = manager(dir, { workerId: "worker-b" });
    const [ra, rb] = await Promise.all([a.acquire("apps/api", "run-1"), b.acquire("apps/api", "run-1")]);
    expect([ra.acquired, rb.acquired].filter(Boolean)).toHaveLength(1);

    // Whichever won, the loser cannot take the fresh same-run lock over.
    const again = await b.acquire("apps/api", "run-1");
    expect(again.acquired).toBe(false);

    const winner = ra.acquired ? ra : rb;
    if (winner.acquired) await winner.handle.release();
  });

  it("lets exactly one of two racing managers take over a stale lock (NEW-06)", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const dead = manager(dir, { workerId: "worker-dead", now: () => now });
    expect((await dead.acquire("apps/api", "run-1")).acquired).toBe(true);

    now += 61_000;
    const a = manager(dir, { workerId: "worker-a", now: () => now });
    const b = manager(dir, { workerId: "worker-b", now: () => now });
    const [ra, rb] = await Promise.all([a.acquire("apps/api", "run-1"), b.acquire("apps/api", "run-1")]);
    expect([ra.acquired, rb.acquired].filter(Boolean)).toHaveLength(1);

    const winner = ra.acquired ? ra : rb;
    if (winner.acquired) {
      expect(winner.reclaimedStale?.runId).toBe("run-1");
      const persisted = JSON.parse(await readFile(a.lockPath("apps/api"), "utf8")) as { token?: string };
      expect(typeof persisted.token).toBe("string");
      await winner.handle.release();
    }
  });

  it("ignores touch/release from a former holder whose lease was taken over (NEW-06)", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const old = manager(dir, { workerId: "worker-old", now: () => now });
    const first = await old.acquire("apps/api", "run-1");
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    now += 61_000;
    const newer = manager(dir, { workerId: "worker-new", now: () => now });
    const takeover = await newer.acquire("apps/api", "run-1");
    expect(takeover.acquired).toBe(true);
    if (!takeover.acquired) return;

    const newToken = (JSON.parse(await readFile(newer.lockPath("apps/api"), "utf8")) as { token?: string }).token;
    expect(newToken).toBeTruthy();

    // The stale handle is a no-op: it neither refreshes nor deletes the lock.
    expect(await first.handle.touch()).toBe(false);
    expect(await first.handle.release()).toBe(false);
    const stillThere = JSON.parse(await readFile(newer.lockPath("apps/api"), "utf8")) as { token?: string };
    expect(stillThere.token).toBe(newToken);

    // The new holder is unaffected and can still refresh and release.
    expect(await takeover.handle.touch()).toBe(true);
    expect(await takeover.handle.release()).toBe(true);
  });

  it("treats a release whose token no longer matches as a no-op (NEW-06)", async () => {
    const dir = await tempDir();
    const locks = manager(dir);
    const held = await locks.acquire("apps/api", "run-1");
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    // Simulate a takeover by another worker overwriting the lock file.
    await (await import("node:fs/promises")).writeFile(
      locks.lockPath("apps/api"),
      JSON.stringify({ key: "apps/api", runId: "run-1", workerId: "other", pid: 1, acquiredAt: 1, heartbeatAt: 2, token: "foreign-token" }),
    );
    expect(await held.handle.release()).toBe(false);
    const onDisk = JSON.parse(await readFile(locks.lockPath("apps/api"), "utf8")) as { token?: string };
    expect(onDisk.token).toBe("foreign-token");
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
