import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSnapshotDivergenceFinding,
  createGitReviewSnapshotMaterializer,
  destroyReviewSnapshot,
  evaluateSnapshotDivergence,
  reviewSnapshotDirectory,
  type GitExec,
} from "./review-snapshot.js";

function fakeGit(options: { developerTree: string; afterTree: string }) {
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  let writeTreeCalls = 0;
  const exec: GitExec = async (_cwd, args, execOptions) => {
    calls.push({ args, env: execOptions?.env });
    const subcommand = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? args[0];
    switch (subcommand) {
      case "rev-parse":
        return args[1] === "HEAD" ? "head-commit" : options.developerTree;
      case "read-tree":
      case "add":
      case "archive":
        return "";
      case "write-tree":
        writeTreeCalls += 1;
        return writeTreeCalls === 1 ? options.developerTree : options.afterTree;
      case "commit-tree":
        return "snapshot-commit";
      default:
        throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
  };
  return { exec, calls };
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "pigo-review-snapshot-test-"));
}

describe("createGitReviewSnapshotMaterializer (GAP-03)", () => {
  it("captures the worktree through a scratch index and archives it without touching the developer index", async () => {
    const { exec, calls } = fakeGit({ developerTree: "tree-100", afterTree: "tree-100" });
    const extracted: Array<{ archive: string; dir: string }> = [];
    const materialize = createGitReviewSnapshotMaterializer(exec, async (archive, dir) => {
      extracted.push({ archive, dir });
    });
    const snapshotDir = path.join(await tempDir(), "reviewer-r1");

    const result = await materialize({ worktree: "/workspace/runs/o/run_1", snapshotDir });

    expect(result).toEqual({
      developerTreeHash: "tree-100",
      snapshotTreeHash: "tree-100",
      developerTreeHashAfter: "tree-100",
      commit: "snapshot-commit",
    });
    // Every tree write uses its own scratch index, never the worktree's `.git/index`.
    const indexWrites = calls.filter((call) => ["read-tree", "add", "write-tree"].includes(call.args[0]));
    expect(indexWrites.length).toBe(6);
    for (const call of indexWrites) {
      expect(call.env?.GIT_INDEX_FILE).toBeTruthy();
      expect(call.env?.GIT_INDEX_FILE).not.toContain("/run_1/.git/index");
    }
    expect(extracted).toHaveLength(1);
    expect(extracted[0].dir).toBe(snapshotDir);
  });

  it("reports a developer tree hash recomputed after the snapshot was taken", async () => {
    const { exec } = fakeGit({ developerTree: "tree-100", afterTree: "tree-200" });
    const materialize = createGitReviewSnapshotMaterializer(exec, async () => undefined);

    const result = await materialize({ worktree: "/workspace/runs/o/run_1", snapshotDir: "/workspace/runs/o/run_1.reviewer-r1" });

    expect(result.developerTreeHash).toBe("tree-100");
    expect(result.snapshotTreeHash).toBe("tree-100");
    expect(result.developerTreeHashAfter).toBe("tree-200");
  });
});

describe("evaluateSnapshotDivergence (GAP-03)", () => {
  it("accepts identical developer, snapshot and post-materialization trees", () => {
    expect(evaluateSnapshotDivergence({ developerTreeHash: "abc", snapshotTreeHash: "abc", developerTreeHashAfter: "abc" }))
      .toEqual({ divergent: false, reasons: [] });
  });

  it("escalates when the snapshot does not match the captured developer tree", () => {
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
    const finding = buildSnapshotDivergenceFinding(2, ["快照 tree aaa 与开发 tree bbb 不一致"]);
    expect(finding.severity).toBe("critical");
    expect(finding.id).toBe("snapshot-divergence-r2");
    expect(finding.evidence).toContain("不一致");
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
