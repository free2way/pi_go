import { describe, expect, it } from "vitest";
import { captureWorkspaceState, restoreWorkspaceState, runGuardedMerge, type MergeGuardGitResult } from "./merge-guard.js";

/**
 * B2 — the guard is exercised through an injected git exec so no real repository
 * is needed. `createFakeRepo` simulates just enough of Git's state (attached
 * branch / detached HEAD, HEAD sha, porcelain status, in-progress merge) to let
 * tests assert that a failed merge really does roll the workspace back.
 */

type Result = MergeGuardGitResult;

function ok(stdout = ""): Result {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr = "fatal: failed"): Result {
  return { code: 1, stdout: "", stderr };
}

interface FakeRepoOptions {
  /** Short branch name, or null for a detached HEAD. */
  branch: string | null;
  headSha: string;
  /** Branch name -> sha used when checking a branch out. */
  branches?: Record<string, string>;
  porcelain?: string;
  headIsAncestor?: boolean;
  /** Result of the real `merge` (not `merge --abort`). Defaults to success. */
  mergeResult?: Result;
  /** Porcelain state after a conflicting merge. */
  conflictPorcelain?: string;
  conflictPaths?: string[];
  /** Sha HEAD moves to after a successful merge. */
  mergedSha?: string;
  /** Force `merge --abort` to fail (simulates an already-clean tree). */
  abortResult?: Result;
  /** Override a checkout; return a result to fail/observe it. */
  checkoutOverride?: (ref: string, isDetach: boolean) => Result | undefined;
  fetchResult?: Result;
}

function createFakeRepo(init: FakeRepoOptions) {
  let branch = init.branch;
  let headSha = init.headSha;
  let porcelain = init.porcelain ?? "";
  let mergeInProgress = false;
  const branches = init.branches ?? {};
  const calls: string[][] = [];

  const exec = async (args: string[]): Promise<Result> => {
    calls.push(args);
    let i = 0;
    while (i < args.length && args[i] === "-c") i += 2;
    const cmd = args[i];
    const rest = args.slice(i + 1);

    if (cmd === "rev-parse" && rest[0] === "HEAD") return ok(`${headSha}\n`);
    if (cmd === "symbolic-ref") return branch ? ok(`${branch}\n`) : fail("fatal: ref HEAD is not a symbolic ref");
    if (cmd === "status") return ok(porcelain);
    if (cmd === "checkout") {
      const isDetach = rest[0] === "--detach";
      const ref = (isDetach ? rest[1] : rest[0]) ?? "";
      const override = init.checkoutOverride?.(ref, isDetach);
      if (override) return override;
      if (isDetach) {
        branch = null;
        headSha = ref;
      } else {
        branch = ref;
        headSha = branches[ref] ?? headSha;
      }
      return ok("");
    }
    if (cmd === "fetch") return init.fetchResult ?? ok("");
    if (cmd === "merge-base") return init.headIsAncestor ? ok("") : fail("fatal: not an ancestor");
    if (cmd === "merge") {
      if (rest[0] === "--abort") {
        if (init.abortResult) return init.abortResult;
        if (!mergeInProgress) return fail("fatal: There is no merge to abort (MERGE_HEAD missing).");
        mergeInProgress = false;
        porcelain = "";
        return ok("");
      }
      const result = init.mergeResult ?? ok("");
      if (result.code === 0) {
        mergeInProgress = true;
        porcelain = "";
        if (init.mergedSha) headSha = init.mergedSha;
      } else {
        mergeInProgress = true;
        porcelain = init.conflictPorcelain ?? "UU conflicted.txt";
      }
      return result;
    }
    if (cmd === "diff") return ok((init.conflictPaths ?? []).map((p) => `${p}\n`).join(""));
    if (cmd === "update-ref") return ok("");
    return fail(`unexpected git ${cmd}`);
  };

  return {
    exec,
    calls,
    get state() {
      return { branch, headSha, porcelain };
    },
  };
}

const base = { branch: "main", headSha: "aaa111", branches: { main: "aaa111", release: "bbb222" } };

describe("captureWorkspaceState (B2)", () => {
  it("captures the attached branch, HEAD sha and cleanliness", async () => {
    const repo = createFakeRepo(base);
    const captured = await captureWorkspaceState(repo.exec);
    expect(captured).toEqual({
      ok: true,
      state: { branch: "main", headSha: "aaa111", porcelain: "", clean: true },
    });
  });

  it("captures a detached HEAD as branch=null", async () => {
    const repo = createFakeRepo({ branch: null, headSha: "det000" });
    const captured = await captureWorkspaceState(repo.exec);
    expect(captured.ok).toBe(true);
    if (captured.ok) expect(captured.state.branch).toBeNull();
  });

  it("reports a dirty workspace as unclean without refusing capture", async () => {
    const repo = createFakeRepo({ ...base, porcelain: " M src/a.ts\n?? tmp\n" });
    const captured = await captureWorkspaceState(repo.exec);
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(captured.state.clean).toBe(false);
      expect(captured.state.porcelain).toBe(" M src/a.ts\n?? tmp");
    }
  });
});

describe("runGuardedMerge (B2)", () => {
  it("refuses a dirty workspace without switching branch", async () => {
    const repo = createFakeRepo({ ...base, porcelain: " M src/a.ts" });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("WORKSPACE_DIRTY");
      expect(result.restored).toBe(true);
      expect(result.original).toEqual({ branch: "main", headSha: "aaa111", clean: false });
    }
    expect(repo.calls.some(([cmd]) => cmd === "checkout")).toBe(false);
  });

  it("restores branch and HEAD after a merge conflict and reports conflicting paths", async () => {
    const repo = createFakeRepo({
      ...base,
      mergeResult: fail("CONFLICT (content): Merge conflict"),
      conflictPorcelain: "UU src/a.ts\n",
      conflictPaths: ["src/a.ts", "src/b.ts"],
    });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe("MERGE_CONFLICT");
      expect(result.conflictingPaths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.restored).toBe(true);
      expect(result.original).toEqual({ branch: "main", headSha: "aaa111", clean: true });
    }
    // The workspace is back on the original branch at the original commit.
    expect(repo.state).toEqual({ branch: "main", headSha: "aaa111", porcelain: "" });
    // The temporary fetch ref is cleaned up on the failure path.
    expect(repo.calls).toContainEqual(["update-ref", "-d", "refs/pigo/merge/run-1"]);
    // Never a force push.
    expect(repo.calls.some((args) => args.includes("push"))).toBe(false);
  });

  it("restores the original branch when switching to the target branch fails", async () => {
    const repo = createFakeRepo({
      ...base,
      checkoutOverride: (ref) => (ref === "release" ? fail("error: pathspec 'release' did not match") : undefined),
    });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TARGET_BRANCH_UNAVAILABLE");
      expect(result.restored).toBe(true);
    }
    expect(repo.state).toEqual({ branch: "main", headSha: "aaa111", porcelain: "" });
    expect(repo.calls.some(([cmd]) => cmd === "fetch")).toBe(false);
  });

  it("reports restored:false when the workspace restore itself fails", async () => {
    const repo = createFakeRepo({
      ...base,
      mergeResult: fail("CONFLICT"),
      conflictPorcelain: "UU src/a.ts\n",
      // Initial switch to `release` succeeds; the restore back to `main` fails,
      // leaving HEAD on the target branch.
      checkoutOverride: (ref) => (ref === "main" ? fail("error: cannot switch back") : undefined),
    });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MERGE_CONFLICT");
      expect(result.restored).toBe(false);
      expect(result.restoreError).toBeTruthy();
      expect(result.error).toContain("恢复失败");
    }
    // The fake confirms the workspace really was left on the target branch.
    expect(repo.state.branch).toBe("release");
  });

  it("restores a detached HEAD back to the original sha", async () => {
    const repo = createFakeRepo({
      branch: null,
      headSha: "det000",
      branches: { release: "bbb222" },
      mergeResult: fail("CONFLICT"),
      conflictPorcelain: "UU src/a.ts\n",
    });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MERGE_CONFLICT");
      expect(result.restored).toBe(true);
      expect(result.original).toEqual({ branch: null, headSha: "det000", clean: true });
    }
    expect(repo.state).toEqual({ branch: null, headSha: "det000", porcelain: "" });
    expect(repo.calls).toContainEqual(["checkout", "--detach", "det000"]);
  });

  it("refuses a detached HEAD when no target branch is supplied", async () => {
    const repo = createFakeRepo({ branch: null, headSha: "det000" });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TARGET_BRANCH_UNKNOWN");
      expect(result.restored).toBe(true);
      expect(result.original).toEqual({ branch: null, headSha: "det000", clean: true });
    }
    expect(repo.calls.some(([cmd]) => cmd === "checkout")).toBe(false);
  });

  it("leaves the target branch checked out after a successful fast-forward merge", async () => {
    const repo = createFakeRepo({ ...base, headIsAncestor: true, mergedSha: "ccc333" });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commit).toBe("ccc333");
      expect(result.targetBranch).toBe("release");
      expect(result.strategy).toBe("fast-forward");
      expect(result.original).toEqual({ branch: "main", headSha: "aaa111", clean: true });
    }
    expect(repo.state).toEqual({ branch: "release", headSha: "ccc333", porcelain: "" });
    expect(repo.calls).toContainEqual(["update-ref", "-d", "refs/pigo/merge/run-1"]);
  });

  it("uses a --no-ff merge commit when the target is not an ancestor", async () => {
    const repo = createFakeRepo({ ...base, headIsAncestor: false, mergedSha: "ddd444" });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("merge-commit");
    const mergeCall = repo.calls.find((args) => args.includes("--no-ff"));
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toContain("--no-edit");
    expect(repo.state.branch).toBe("release");
  });

  it("restores when the fetch of the run branch fails", async () => {
    const repo = createFakeRepo({ ...base, fetchResult: fail("fatal: couldn't find remote ref") });
    const result = await runGuardedMerge({
      exec: repo.exec, sourcePath: "/runs/wt", sourceBranch: "pigo/run-1", runId: "run-1", targetBranch: "release",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MERGE_FETCH_FAILED");
      expect(result.restored).toBe(true);
    }
    expect(repo.state).toEqual({ branch: "main", headSha: "aaa111", porcelain: "" });
  });
});

describe("restoreWorkspaceState (B2)", () => {
  it("verifies HEAD, branch and cleanliness and reports failure detail", async () => {
    const repo = createFakeRepo({
      ...base,
      // Simulate a restore that cannot get back to the original branch: HEAD
      // stays on a different commit.
      checkoutOverride: (ref, isDetach) => {
        if (ref === "main" && !isDetach) return ok("");
        return undefined;
      },
    });
    // Move the fake repo away from `main` first.
    await repo.exec(["checkout", "release"]);
    const report = await restoreWorkspaceState(repo.exec, { branch: "main", headSha: "aaa111", porcelain: "", clean: true });
    // The override made the checkout a no-op, so the verification must fail.
    expect(report.steps.checkout).toBe(true);
    expect(report.steps.branchMatch).toBe(false);
    expect(report.restored).toBe(false);
    expect(report.errors.join(" ")).toContain("分支不匹配");
  });
});
