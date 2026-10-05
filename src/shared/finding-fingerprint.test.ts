import { describe, expect, it } from "vitest";
import type { Finding } from "./types.js";
import {
  NO_FILE_TOKEN,
  findingFingerprint,
  normalizeFindingFile,
  normalizeFindingTitle,
} from "./finding-fingerprint.js";

const finding = (overrides: Partial<Finding> = {}) => ({
  id: "model-id-1",
  severity: "high" as const,
  file: "src/auth/session.ts",
  line: 12,
  title: "Refresh race condition",
  evidence: "two concurrent refreshes",
  requiredChange: "Serialize refresh per token",
  resolved: false,
  ...overrides,
});

describe("normalizeFindingFile", () => {
  it("lowercases and strips leading ./ and backslashes", () => {
    expect(normalizeFindingFile("./src/Auth/Session.ts")).toBe("src/auth/session.ts");
    expect(normalizeFindingFile("././src/a.ts")).toBe("src/a.ts");
    expect(normalizeFindingFile("SRC\\Auth\\Session.ts")).toBe("src/auth/session.ts");
  });

  it("uses the placeholder token for null/empty files", () => {
    expect(normalizeFindingFile(null)).toBe(NO_FILE_TOKEN);
    expect(normalizeFindingFile(undefined)).toBe(NO_FILE_TOKEN);
    expect(normalizeFindingFile("   ")).toBe(NO_FILE_TOKEN);
  });
});

describe("normalizeFindingTitle", () => {
  it("lowercases, collapses whitespace, strips list markers and trailing punctuation", () => {
    expect(normalizeFindingTitle("  -   Fix   the  Race. ")).toBe("fix the race");
    expect(normalizeFindingTitle("1. 未恢复之前状态。")).toBe("未恢复之前状态");
    expect(normalizeFindingTitle("* [ ] Missing test")).toBe("missing test");
    expect(normalizeFindingTitle("Race?")).toBe("race");
  });
});

describe("findingFingerprint", () => {
  it("is id-independent: reworded casing/whitespace/markers keep one identity", () => {
    const a = findingFingerprint(finding({ id: "story-unblock-state-not-restored" }));
    const b = findingFingerprint(finding({ id: "F1", title: "-  Refresh   RACE condition. " }));
    const c = findingFingerprint(finding({ id: "STORY-BLOCK-001", title: "refresh race condition。" }));
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("src/auth/session.ts|refresh race condition");
  });

  it("ignores severity, line, evidence and required change", () => {
    const a = findingFingerprint(finding());
    const b = findingFingerprint(finding({ severity: "low", line: 999, evidence: "other", requiredChange: "different" }));
    expect(a).toBe(b);
  });

  it("keeps genuinely different files or titles separate", () => {
    expect(findingFingerprint(finding({ file: "src/a.ts" }))).not.toBe(findingFingerprint(finding({ file: "src/b.ts" })));
    expect(findingFingerprint(finding({ title: "Race condition" }))).not.toBe(findingFingerprint(finding({ title: "Memory leak" })));
  });

  it("returns a stable key when the file is missing", () => {
    expect(findingFingerprint(finding({ file: null }))).toBe(`${NO_FILE_TOKEN}|refresh race condition`);
    expect(findingFingerprint(finding({ file: null, title: "X" }))).toBe(findingFingerprint(finding({ file: "", title: "x" })));
  });
});
