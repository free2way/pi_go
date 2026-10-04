import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitExec } from "./review-snapshot.js";
import { captureSnapshotHash } from "./snapshot-hash.js";
import { gitAvailable } from "./git-test-helpers.js";

const temporaryDirs: string[] = [];

async function initRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-snapshot-hash-test-"));
  temporaryDirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!gitAvailable)("captureSnapshotHash (NEW-03)", () => {
  it("is stable for identical dirty content (no stash/time drift)", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });

    const first = await captureSnapshotHash(defaultGitExec, repo);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await captureSnapshotHash(defaultGitExec, repo);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes when tracked content changes", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const before = await captureSnapshotHash(defaultGitExec, repo);

    await writeFile(path.join(repo, "a.txt"), "two\n");
    const after = await captureSnapshotHash(defaultGitExec, repo);

    expect(after).not.toBe(before);
  });

  it("changes when an intent-to-add file's content changes", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "new.txt"), "x\n");
    execFileSync("git", ["add", "-N", "new.txt"], { cwd: repo });
    const before = await captureSnapshotHash(defaultGitExec, repo);

    await writeFile(path.join(repo, "new.txt"), "y\n");
    const after = await captureSnapshotHash(defaultGitExec, repo);

    expect(after).not.toBe(before);
  });
});
