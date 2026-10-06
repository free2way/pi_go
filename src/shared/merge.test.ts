import { describe, expect, it } from "vitest";
import { describeMergeRestore, mergeConflictReply, mergeRestoreFields, parseConflictingPaths, planMergeStrategy } from "./merge.js";

describe("planMergeStrategy", () => {
  it("fast-forwards when the target branch is an ancestor of the run branch", () => {
    expect(planMergeStrategy({ headIsAncestor: true })).toBe("fast-forward");
  });

  it("creates a merge commit when the branches diverged", () => {
    expect(planMergeStrategy({ headIsAncestor: false })).toBe("merge-commit");
  });
});

describe("parseConflictingPaths", () => {
  it("parses --name-only output, de-duplicated and trimmed", () => {
    expect(parseConflictingPaths("src/a.ts\n\nsrc/b.ts\nsrc/a.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses porcelain status lines into paths", () => {
    // Porcelain: only unmerged codes are conflicts; an unrelated ` M` entry is ignored.
    expect(parseConflictingPaths("UU src/a.ts\nAA src/b.ts\n M src/ok.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("tolerates missing or malformed output", () => {
    expect(parseConflictingPaths(undefined)).toEqual([]);
    expect(parseConflictingPaths("")).toEqual([]);
  });

  it("bounds the number of paths", () => {
    const output = Array.from({ length: 80 }, (_, index) => `src/f${index}.ts`).join("\n");
    expect(parseConflictingPaths(output)).toHaveLength(50);
  });
});

describe("mergeConflictReply", () => {
  it("shapes a 409 that names the conflicting files", () => {
    const reply = mergeConflictReply(["src/a.ts", "src/a.ts", "src/b.ts"]);
    expect(reply.status).toBe(409);
    expect(reply.code).toBe("MERGE_CONFLICT");
    expect(reply.conflictingPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(reply.message).toContain("src/a.ts");
  });

  it("forwards the workspace-restore state when the worker reports it", () => {
    expect(mergeConflictReply(["src/a.ts"], { restored: true })).toMatchObject({ restored: true });
    expect(mergeConflictReply(["src/a.ts"], { restored: false, restoreError: "无法恢复工作区" })).toMatchObject({ restored: false, restoreError: "无法恢复工作区" });
  });

  it("omits restore fields that are missing or malformed", () => {
    const reply = mergeConflictReply(["src/a.ts"]);
    expect("restored" in reply).toBe(false);
    expect("restoreError" in reply).toBe(false);
    expect(mergeConflictReply([], { restored: "yes" as unknown as boolean, restoreError: "  " })).toEqual({
      status: 409,
      code: "MERGE_CONFLICT",
      message: "合并存在冲突（0 个文件），已中止且未修改工作区：",
      conflictingPaths: [],
    });
  });
});

describe("mergeRestoreFields (R)", () => {
  it("keeps booleans and non-empty strings only", () => {
    expect(mergeRestoreFields({ restored: true, restoreError: "boom" })).toEqual({ restored: true, restoreError: "boom" });
    expect(mergeRestoreFields({ restored: false })).toEqual({ restored: false });
    expect(mergeRestoreFields({})).toEqual({});
    expect(mergeRestoreFields({ restored: undefined, restoreError: "   " })).toEqual({});
    expect(mergeRestoreFields({ restored: 1 as unknown, restoreError: 7 as unknown })).toEqual({});
  });
});

describe("describeMergeRestore (R)", () => {
  it("renders the restore line in the selected language", () => {
    expect(describeMergeRestore({ restored: true }, "en")).toBe("Workspace restored to the original branch");
    expect(describeMergeRestore({ restored: false, restoreError: "checkout failed" }, "en"))
      .toContain("checkout failed");
  });

  it("renders restored vs failed, and nothing when absent", () => {
    expect(describeMergeRestore({ restored: true })).toBe("工作区已恢复原分支");
    expect(describeMergeRestore({ restored: false })).toBe("工作区恢复失败，需人工处理");
    expect(describeMergeRestore({ restored: false, restoreError: "checkout 失败" })).toBe("工作区恢复失败，需人工处理：checkout 失败");
    expect(describeMergeRestore({})).toBeUndefined();
  });
});
