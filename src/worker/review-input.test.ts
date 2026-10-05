import { describe, expect, it } from "vitest";
import {
  buildReviewDiff,
  defaultFileDiffBytes,
  defaultTotalDiffBytes,
  reviewInputLimits,
  splitDiff,
} from "./review-input.js";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

function fileHeader(path: string): string {
  return `diff --git a/${path} b/${path}\nindex 0000000..1111111 100644\n--- a/${path}\n+++ b/${path}`;
}

/** A text file with `count` hunks, each adding/removing one line. */
function textFile(path: string, count: number): string {
  const hunks = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `@@ -${n},2 +${n},5 @@\n ctx${n}\n+added${n}\n-removed${n}`;
  });
  return `${fileHeader(path)}\n${hunks.join("\n")}`;
}

function lockfile(path: string, fillerBytes: number): string {
  const filler = "x".repeat(Math.max(1, fillerBytes - 200));
  return `${fileHeader(path)}\n@@ -1,2 +1,3 @@\n ctx\n+${filler}\n-old`;
}

describe("reviewInputLimits (PI_REVIEW_FILE_DIFF_BYTES / PI_REVIEW_TOTAL_DIFF_BYTES)", () => {
  it("defaults to 40k/200k and parses strict positive integers only", () => {
    expect(defaultFileDiffBytes).toBe(40_000);
    expect(defaultTotalDiffBytes).toBe(200_000);
    expect(reviewInputLimits({})).toEqual({ fileDiffBytes: 40_000, totalDiffBytes: 200_000 });
    expect(reviewInputLimits({ PI_REVIEW_FILE_DIFF_BYTES: "1234", PI_REVIEW_TOTAL_DIFF_BYTES: "5678" })).toEqual({
      fileDiffBytes: 1234,
      totalDiffBytes: 5678,
    });
    expect(reviewInputLimits({ PI_REVIEW_FILE_DIFF_BYTES: "0", PI_REVIEW_TOTAL_DIFF_BYTES: "-1" })).toEqual({
      fileDiffBytes: 40_000,
      totalDiffBytes: 200_000,
    });
    expect(reviewInputLimits({ PI_REVIEW_FILE_DIFF_BYTES: "abc", PI_REVIEW_TOTAL_DIFF_BYTES: "2.5" })).toEqual({
      fileDiffBytes: 40_000,
      totalDiffBytes: 200_000,
    });
  });
});

describe("buildReviewDiff", () => {
  it("passes a small diff through byte-identically", () => {
    const diff = `${textFile("src/a.ts", 1)}\n${textFile("src/b.ts", 2)}`;
    const result = buildReviewDiff(diff);
    expect(result.trimmed).toBe(false);
    expect(result.text).toBe(diff);
    expect(result.originalBytes).toBe(bytes(diff));
    expect(result.includedBytes).toBe(bytes(diff));
    expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.files.every((file) => file.included && !file.trimmed)).toBe(true);
  });

  it("excludes a 900KB lockfile with a manifest and stays under the total budget", () => {
    const source = textFile("src/app.ts", 3);
    const lock = lockfile("package-lock.json", 900_000);
    const diff = `${source}\n${lock}`;
    expect(bytes(diff)).toBeGreaterThan(800_000);

    const result = buildReviewDiff(diff);
    expect(result.trimmed).toBe(true);
    // The lockfile body never reaches the reviewer.
    expect(result.text).not.toContain("xxxxx");
    expect(result.text).toContain("src/app.ts");
    expect(result.text).toContain("[PiGO review input manifest]");
    expect(result.text).toContain("- package-lock.json (excluded: lockfile)");
    expect(result.text).toContain("[review input trimmed]");
    const lockStat = result.files.find((file) => file.path === "package-lock.json");
    expect(lockStat?.excludedReason).toBe("lockfile");
    expect(lockStat?.added).toBe(1);
    expect(lockStat?.removed).toBe(1);
    expect(bytes(result.text)).toBeLessThanOrEqual(defaultTotalDiffBytes);
  });

  it("trims a file at the per-file cap with correct marker counts", () => {
    const header = fileHeader("src/big.ts");
    const hunks = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      return `@@ -${n},2 +${n},3 @@\n ctx${n}\n+added${n}\n-removed${n}`;
    });
    const diff = `${header}\n${hunks.join("\n")}`;
    // Cap fits the header plus exactly one hunk.
    const fileDiffBytes = bytes(header) + 1 + bytes(hunks[0]);
    const result = buildReviewDiff(diff, { fileDiffBytes, totalDiffBytes: 1_000_000 });

    expect(result.trimmed).toBe(true);
    const stat = result.files[0];
    expect(stat.trimmed).toBe(true);
    expect(stat.added).toBe(6);
    expect(stat.removed).toBe(6);
    expect(stat.trimmedHunks).toBe(5);
    expect(stat.trimmedAdded).toBe(5);
    expect(stat.trimmedRemoved).toBe(5);
    expect(result.text).toContain("... [trimmed: +5/-5 lines, 5 hunks omitted]");
    expect(result.text).toContain("ctx1");
    expect(result.text).not.toContain("ctx2");
  });

  it("detects binary files and never forwards their bytes", () => {
    const binary = `diff --git a/assets/logo.png b/assets/logo.png\nnew file mode 100644\nindex 0000000..2222222\nBinary files /dev/null and b/assets/logo.png differ`;
    const diff = `${textFile("src/app.ts", 1)}\n${binary}`;
    const result = buildReviewDiff(diff);
    expect(result.files.find((file) => file.path === "assets/logo.png")?.excludedReason).toBe("binary");
    expect(result.text).not.toContain("Binary files");
    expect(result.text).toContain("assets/logo.png (excluded: binary)");
  });

  it("excludes dist/build outputs and node_modules dependencies", () => {
    const diff = [
      textFile("src/app.ts", 1),
      textFile("dist/bundle.js", 1),
      textFile("build/out.js", 1),
      textFile("node_modules/pkg/index.js", 1),
      textFile("packages/x/node_modules/pkg/index.js", 1),
    ].join("\n");
    const result = buildReviewDiff(diff);
    const reason = (path: string) => result.files.find((file) => file.path === path)?.excludedReason;
    expect(reason("src/app.ts")).toBeUndefined();
    expect(reason("dist/bundle.js")).toBe("build-output");
    expect(reason("build/out.js")).toBe("build-output");
    expect(reason("node_modules/pkg/index.js")).toBe("dependency");
    expect(reason("packages/x/node_modules/pkg/index.js")).toBe("dependency");
  });

  it("drops the smallest files first when the total budget is hit, listing them all", () => {
    const big = textFile("src/big.ts", 1).replace(" ctx1\n", ` ctx1\n+${"y".repeat(130_000)}\n`);
    const medium = textFile("src/medium.ts", 1).replace(" ctx1\n", ` ctx1\n+${"z".repeat(120_000)}\n`);
    const small = textFile("src/small.ts", 1);
    const diff = `${big}\n${medium}\n${small}`;
    const totalDiffBytes = 200_000;
    const result = buildReviewDiff(diff, { fileDiffBytes: 1_000_000, totalDiffBytes });

    expect(bytes(result.text)).toBeLessThanOrEqual(totalDiffBytes);
    expect(result.text).toContain("[PiGO review input manifest]");
    // Full file list with stats and reasons, even for dropped files.
    expect(result.text).toContain("- src/big.ts (included)");
    expect(result.text).toContain("- src/medium.ts (excluded: total-budget)");
    expect(result.text).toContain("- src/small.ts (included)");
    expect(result.files.find((file) => file.path === "src/medium.ts")?.excludedReason).toBe("total-budget");
    expect(result.files.find((file) => file.path === "src/big.ts")?.included).toBe(true);
    expect(result.files.find((file) => file.path === "src/small.ts")?.included).toBe(true);
  });

  it("is deterministic", () => {
    const diff = `${textFile("src/app.ts", 2)}\n${lockfile("yarn.lock", 250_000)}`;
    expect(buildReviewDiff(diff).text).toBe(buildReviewDiff(diff).text);
  });

  it("parses an empty or preamble-only diff without throwing", () => {
    expect(buildReviewDiff("").text).toBe("");
    expect(splitDiff("").files).toEqual([]);
  });
});
