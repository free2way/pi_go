import { describe, expect, it } from "vitest";
import { mergeConflictReply, parseConflictingPaths, planMergeStrategy } from "./merge.js";

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
});
