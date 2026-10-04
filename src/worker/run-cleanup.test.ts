import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunCleanupPathError, isRunDirectoryEntry, planRunDirectoryRemoval, removeRunDirectory } from "./run-cleanup.js";

const OWNER_ID = "a".repeat(64);
const RUN_ID = "run_0123456789abcdef0123";

async function exists(target: string) {
  return stat(target).then(() => true).catch(() => false);
}

describe("run cleanup path validation", () => {
  it("builds the run directory inside the runs root", () => {
    const plan = planRunDirectoryRemoval("/workspace/runs", OWNER_ID, RUN_ID);
    expect(plan.parent).toBe(path.join("/workspace/runs", OWNER_ID));
    expect(plan.worktree).toBe(path.join("/workspace/runs", OWNER_ID, RUN_ID));
  });

  it("refuses malformed owner ids and run ids", () => {
    expect(() => planRunDirectoryRemoval("/workspace/runs", "short", RUN_ID)).toThrow(RunCleanupPathError);
    expect(() => planRunDirectoryRemoval("/workspace/runs", "A".repeat(64), RUN_ID)).toThrow(RunCleanupPathError);
    for (const runId of ["../etc", "a/b", "run id", "", "x".repeat(121), "."]) {
      const error = (() => {
        try {
          planRunDirectoryRemoval("/workspace/runs", OWNER_ID, runId);
          return undefined;
        } catch (cause) {
          return cause as RunCleanupPathError;
        }
      })();
      expect(error, `runId=${runId}`).toBeInstanceOf(RunCleanupPathError);
      expect(error?.code).toBe("RUN_PATH_INVALID");
    }
  });

  it("matches only entries owned by the run", () => {
    expect(isRunDirectoryEntry(RUN_ID, RUN_ID)).toBe(true);
    expect(isRunDirectoryEntry(RUN_ID, `${RUN_ID}.state`)).toBe(true);
    expect(isRunDirectoryEntry(RUN_ID, `${RUN_ID}.reviewer-r1`)).toBe(true);
    expect(isRunDirectoryEntry(RUN_ID, `${RUN_ID}.reviewer-r12.state`)).toBe(true);
    expect(isRunDirectoryEntry(RUN_ID, `${RUN_ID}.reviewer-x`)).toBe(false);
    expect(isRunDirectoryEntry(RUN_ID, `${RUN_ID}-other`)).toBe(false);
    expect(isRunDirectoryEntry(RUN_ID, `other-${RUN_ID}`)).toBe(false);
    expect(isRunDirectoryEntry(RUN_ID, "unrelated")).toBe(false);
  });
});

describe("removeRunDirectory", () => {
  async function fixture() {
    const runsRoot = await mkdtemp(path.join(tmpdir(), "pigo-runs-"));
    const ownerDir = path.join(runsRoot, OWNER_ID);
    const worktree = path.join(ownerDir, RUN_ID);
    await mkdir(path.join(worktree, "subagents", "task-1"), { recursive: true });
    await writeFile(path.join(worktree, "index.ts"), "hello");
    await writeFile(path.join(worktree, "subagents", "task-1", "file.txt"), "subagent");
    await mkdir(path.join(ownerDir, `${RUN_ID}.state`, "agent"), { recursive: true });
    await writeFile(path.join(ownerDir, `${RUN_ID}.state`, "agent", "session.json"), "{}");
    await mkdir(path.join(ownerDir, `${RUN_ID}.reviewer-r1`), { recursive: true });
    await writeFile(path.join(ownerDir, `${RUN_ID}.reviewer-r1`, "README.md"), "snapshot");
    await mkdir(path.join(ownerDir, `${RUN_ID}.reviewer-r1.state`), { recursive: true });
    await writeFile(path.join(ownerDir, `${RUN_ID}.reviewer-r1.state`, "x"), "x");
    const otherRun = path.join(ownerDir, "run_ffffffffffffffffffff");
    await mkdir(otherRun);
    await writeFile(path.join(otherRun, "keep"), "keep");
    const otherOwner = path.join(runsRoot, "b".repeat(64));
    await mkdir(otherOwner);
    await writeFile(path.join(otherOwner, "keep"), "keep");
    return { runsRoot, ownerDir, worktree, otherRun, otherOwner };
  }

  it("removes the run tree, state and reviewer snapshots but nothing else", async () => {
    const { runsRoot, ownerDir, worktree, otherRun, otherOwner } = await fixture();
    const result = await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID });

    expect(result.removed).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect([...result.paths].sort()).toEqual(
      [
        path.join(OWNER_ID, RUN_ID),
        path.join(OWNER_ID, `${RUN_ID}.state`),
        path.join(OWNER_ID, `${RUN_ID}.reviewer-r1`),
        path.join(OWNER_ID, `${RUN_ID}.reviewer-r1.state`),
      ].sort(),
    );
    expect(await exists(worktree)).toBe(false);
    expect(await exists(path.join(ownerDir, `${RUN_ID}.state`))).toBe(false);
    expect(await exists(path.join(ownerDir, `${RUN_ID}.reviewer-r1`))).toBe(false);
    expect(await exists(path.join(ownerDir, `${RUN_ID}.reviewer-r1.state`))).toBe(false);
    expect(await exists(path.join(otherRun, "keep"))).toBe(true);
    expect(await exists(path.join(otherOwner, "keep"))).toBe(true);
  });

  it("is idempotent: a missing directory is a successful no-op", async () => {
    const { runsRoot } = await fixture();
    await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID });
    const again = await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID });
    expect(again).toMatchObject({ removed: false, paths: [], bytes: 0 });
  });

  it("is a no-op when the runs root or owner directory does not exist", async () => {
    const runsRoot = await mkdtemp(path.join(tmpdir(), "pigo-runs-"));
    await expect(removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID })).resolves.toMatchObject({ removed: false, bytes: 0 });
    await expect(removeRunDirectory({ runsRoot: `${runsRoot}-missing`, ownerId: OWNER_ID, runId: RUN_ID })).resolves.toMatchObject({ removed: false, bytes: 0 });
  });

  it("dry-run reports the plan without touching anything", async () => {
    const { runsRoot, worktree } = await fixture();
    const result = await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, removed: true });
    expect(result.paths.length).toBe(4);
    expect(result.bytes).toBeGreaterThan(0);
    expect(await exists(path.join(worktree, "index.ts"))).toBe(true);
  });

  it("never follows a symlinked run directory out of the runs root", async () => {
    const runsRoot = await mkdtemp(path.join(tmpdir(), "pigo-runs-"));
    const outside = await mkdtemp(path.join(tmpdir(), "pigo-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await mkdir(path.join(runsRoot, OWNER_ID), { recursive: true });
    await symlink(outside, path.join(runsRoot, OWNER_ID, RUN_ID));

    const result = await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID });
    expect(result.removed).toBe(true);
    expect(await exists(path.join(runsRoot, OWNER_ID, RUN_ID))).toBe(false);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("never follows a symlink nested inside the run tree", async () => {
    const { runsRoot, worktree } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "pigo-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(worktree, "escape"));

    await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID });
    expect(await exists(worktree)).toBe(false);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses an owner directory that is a symlink escaping the runs root", async () => {
    const runsRoot = await mkdtemp(path.join(tmpdir(), "pigo-runs-"));
    const outside = await mkdtemp(path.join(tmpdir(), "pigo-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(runsRoot, OWNER_ID));

    const error = await removeRunDirectory({ runsRoot, ownerId: OWNER_ID, runId: RUN_ID }).catch((cause: RunCleanupPathError) => cause);
    expect(error).toBeInstanceOf(RunCleanupPathError);
    expect((error as RunCleanupPathError).code).toBe("RUN_PATH_OUTSIDE_ROOT");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});
