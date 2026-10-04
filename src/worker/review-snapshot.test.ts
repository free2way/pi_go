import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshotDivergenceFinding,
  createGitReviewSnapshotMaterializer,
  defaultGitExec,
  destroyReviewSnapshot,
  evaluateSnapshotDivergence,
  hashDirectory,
  manifestHash,
  reviewSnapshotDirectory,
} from "./review-snapshot.js";
import type { ManifestEntry } from "./review-snapshot.js";
import { gitAvailable } from "./git-test-helpers.js";

const temporaryDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-review-snapshot-test-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Initializes a real git repository with one commit. */
async function initRepo() {
  const dir = await tempDir();
  await defaultGitExec(dir, ["init", "-q", "-b", "main"]);
  await defaultGitExec(dir, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

async function commitAll(repo: string) {
  await defaultGitExec(repo, ["add", "-A"]);
  await defaultGitExec(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "files"]);
}

describe.skipIf(!gitAvailable)("createGitReviewSnapshotMaterializer (GAP-03 / NEW-02)", () => {
  it("materializes tracked and untracked files and returns matching content manifests", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "tracked.txt"), "tracked\n");
    await commitAll(repo);
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });

    expect(result.developerTreeHash).toBe(result.snapshotTreeHash);
    expect(result.developerTreeHashAfter).toBe(result.snapshotTreeHash);
    expect(await readFile(path.join(snapshotDir, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(await readFile(path.join(snapshotDir, "untracked.txt"), "utf8")).toBe("untracked\n");
  });

  it("does not honor export-ignore: an export-ignored file still reaches the reviewer", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, ".gitattributes"), "hidden.secret export-ignore\n");
    await writeFile(path.join(repo, "hidden.secret"), "delivered\n");
    await writeFile(path.join(repo, "visible.txt"), "visible\n");
    await commitAll(repo);
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });

    expect(await readFile(path.join(snapshotDir, "hidden.secret"), "utf8")).toBe("delivered\n");
    expect(result.developerTreeHash).toBe(result.snapshotTreeHash);
    expect(evaluateSnapshotDivergence(result).divergent).toBe(false);
  });

  it("does not honor export-subst: the raw file content (not the substituted form) is materialized", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, ".gitattributes"), "stamped.txt export-subst\n");
    const raw = "commit=$Format:%H$\n";
    await writeFile(path.join(repo, "stamped.txt"), raw);
    await commitAll(repo);
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });

    expect(await readFile(path.join(snapshotDir, "stamped.txt"), "utf8")).toBe(raw);
    expect(result.developerTreeHash).toBe(result.snapshotTreeHash);
  });

  it("materializes symlinks as symlinks and detects a changed link target", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "target.txt"), "one\n");
    await symlink("target.txt", path.join(repo, "link.txt"));
    await commitAll(repo);
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });

    expect((await lstat(path.join(snapshotDir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(result.developerTreeHash).toBe(result.snapshotTreeHash);

    const before = manifestHash(await hashDirectory(snapshotDir));
    await rm(path.join(snapshotDir, "link.txt"));
    await symlink("other.txt", path.join(snapshotDir, "link.txt"));
    expect(manifestHash(await hashDirectory(snapshotDir))).not.toBe(before);
  });

  it("detects divergence when materialized content differs from the developer worktree", async () => {
    const repo = await initRepo();
    await writeFile(path.join(repo, "code.txt"), "original\n");
    await commitAll(repo);
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });
    expect(evaluateSnapshotDivergence(result).divergent).toBe(false);

    // A tampered snapshot dir no longer matches the developer manifest.
    await writeFile(path.join(snapshotDir, "code.txt"), "tampered\n");
    const tampered = manifestHash(await hashDirectory(snapshotDir));
    expect(evaluateSnapshotDivergence({ ...result, snapshotTreeHash: tampered }).divergent).toBe(true);
  });

  it("keeps case-conflicting paths distinct in the manifest", () => {
    const base: ManifestEntry = { path: "Readme.md", mode: "100644", type: "blob", hash: "a".repeat(64) };
    const upper = manifestHash([base]);
    const lower = manifestHash([{ ...base, path: "readme.md" }]);
    const both = manifestHash([base, { ...base, path: "readme.md" }]);
    expect(upper).not.toBe(lower);
    expect(both).not.toBe(upper);
  });
});

describe.skipIf(!gitAvailable)("git execution hardening (NEW-01)", () => {
  it("neutralizes repository-local filter config and scrubs the worker environment", async () => {
    const repo = await initRepo();
    const marker = path.join(repo, "filter-executed.txt");
    const markerName = "DUMMY_WORKER_SECRET_NOT_A_REAL_KEY";
    process.env[markerName] = "leaked-value";
    try {
      await appendFile(
        path.join(repo, ".git", "config"),
        `[filter "evil"]\n\tclean = sh -c "env > '${marker}'; echo PWNED"\n\trequired = true\n`,
      );
      await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
      await writeFile(path.join(repo, "a.txt"), "hello\n");

      // The vulnerable path: a filter that runs during `git add`.
      await expect(defaultGitExec(repo, ["add", "-A"])).resolves.toBeTypeOf("string");

      expect(await stat(marker).then(() => true).catch(() => false)).toBe(false);
    } finally {
      delete process.env[markerName];
    }
  });

  it("still materializes safely when a hostile filter and export-ignore are configured", async () => {
    const repo = await initRepo();
    const marker = path.join(repo, "pwned.txt");
    await appendFile(
      path.join(repo, ".git", "config"),
      `[filter "evil"]\n\tclean = sh -c "env > '${marker}'; cat"\n`,
    );
    await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\npayload.txt export-ignore\n");
    await writeFile(path.join(repo, "payload.txt"), "must-be-present\n");
    await commitAll(repo);
    const snapshotDir = `${repo}.reviewer-r1`;

    const result = await createGitReviewSnapshotMaterializer()({ worktree: repo, snapshotDir });

    expect(await stat(marker).then(() => true).catch(() => false)).toBe(false);
    expect(await readFile(path.join(snapshotDir, "payload.txt"), "utf8")).toBe("must-be-present\n");
    expect(result.developerTreeHash).toBe(result.snapshotTreeHash);
  });
});

describe("evaluateSnapshotDivergence (GAP-03)", () => {
  it("accepts identical developer, snapshot and post-materialization manifests", () => {
    expect(evaluateSnapshotDivergence({ developerTreeHash: "abc", snapshotTreeHash: "abc", developerTreeHashAfter: "abc" }))
      .toEqual({ divergent: false, reasons: [] });
  });

  it("escalates when the snapshot does not match the captured developer content", () => {
    const decision = evaluateSnapshotDivergence({ developerTreeHash: "abc", snapshotTreeHash: "def" });
    expect(decision.divergent).toBe(true);
    expect(decision.reasons.join(" ")).toContain("不一致");
  });

  it("escalates when the developer worktree changed after the snapshot", () => {
    const decision = evaluateSnapshotDivergence({ developerTreeHash: "abc", snapshotTreeHash: "abc", developerTreeHashAfter: "def" });
    expect(decision.divergent).toBe(true);
    expect(decision.reasons.join(" ")).toContain("又被修改");
  });

  it("produces a blocking finding for a diverged review", () => {
    const finding = buildSnapshotDivergenceFinding(2, ["快照内容 aaa 与开发内容 bbb 不一致"]);
    expect(finding.severity).toBe("critical");
    expect(finding.id).toBe("snapshot-divergence-r2");
    expect(finding.evidence).toContain("不一致");
  });
});

describe("manifestHash", () => {
  it("is order-independent and content-sensitive", () => {
    const entries: ManifestEntry[] = [
      { path: "b.txt", mode: "100644", type: "blob", hash: createHash("sha256").update("b").digest("hex") },
      { path: "a.txt", mode: "100644", type: "blob", hash: createHash("sha256").update("a").digest("hex") },
    ];
    const shuffled = [entries[1], entries[0]];
    expect(manifestHash(entries)).toBe(manifestHash(shuffled));
    expect(manifestHash([{ ...entries[0], hash: "f".repeat(64) }, entries[1]])).not.toBe(manifestHash(entries));
  });
});

describe("review snapshot lifecycle (GAP-03 / AT-REVIEW-012)", () => {
  it("places the snapshot as a sibling of the worktree, not inside it", () => {
    expect(reviewSnapshotDirectory("/workspace/runs/o/run_1", 3)).toBe("/workspace/runs/o/run_1.reviewer-r3");
  });

  it("destroys the snapshot directory and its Pi state", async () => {
    const root = await tempDir();
    const snapshot = path.join(root, "run_1.reviewer-r1");
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "note.txt"), "reviewer scratch");
    await mkdir(`${snapshot}.state`, { recursive: true });

    await destroyReviewSnapshot(snapshot);

    await expect(stat(snapshot)).rejects.toThrow();
    await expect(stat(`${snapshot}.state`)).rejects.toThrow();
  });
});
