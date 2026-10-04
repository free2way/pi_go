import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/types.js";
import { findingFingerprint, mergeFindings, repeatedFindings, unresolvedFeedback } from "./review-findings.js";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "stable-finding",
  severity: "high",
  file: "src/auth/session.ts",
  line: 12,
  title: "Refresh race condition",
  evidence: "two concurrent refreshes",
  requiredChange: "Serialize refresh per token",
  resolved: false,
  ...overrides,
});

const incoming = (overrides: Partial<Omit<Finding, "resolved">> = {}) => {
  const { resolved: _resolved, ...rest } = finding(overrides);
  return rest;
};

describe("mergeFindings", () => {
  it("keeps a repeated finding as one unresolved record (AUD-11)", () => {
    const first = mergeFindings([], [incoming()], { round: 1 });
    expect(first).toHaveLength(1);
    expect(first[0].resolved).toBe(false);
    expect(first[0].observations).toBe(1);

    const second = mergeFindings(first, [incoming({ evidence: "still reproducible" })], { round: 2 });
    expect(second).toHaveLength(1);
    expect(second[0].resolved).toBe(false);
    expect(second[0].observations).toBe(2);
    expect(second[0].consecutiveRounds).toBe(2);
    expect(second[0].firstSeenRound).toBe(1);
    expect(second[0].lastSeenRound).toBe(2);
    expect(second[0].evidence).toBe("still reproducible");
  });

  it("does not silently resolve old findings while changes are still requested", () => {
    const first = mergeFindings([], [incoming()], { round: 1 });
    const second = mergeFindings(first, [incoming({ id: "another-finding", title: "Different problem", file: "src/b.ts" })], { round: 2 });
    expect(second).toHaveLength(2);
    expect(second.every((item) => !item.resolved)).toBe(true);
  });

  it("closes previously open findings only when the snapshot is approved", () => {
    const first = mergeFindings([], [incoming()], { round: 1 });
    const approved = mergeFindings(first, [], { round: 2, approved: true });
    expect(approved[0].resolved).toBe(true);
    expect(approved[0].consecutiveRounds).toBe(0);
  });

  it("matches a renamed id through the fingerprint", () => {
    const first = mergeFindings([], [incoming()], { round: 1 });
    const renamed = mergeFindings(first, [incoming({ id: "review-2-1" })], { round: 2 });
    expect(renamed).toHaveLength(1);
    expect(renamed[0].observations).toBe(2);
  });

  it("flags problems repeated across consecutive reviews", () => {
    let findings = mergeFindings([], [incoming()], { round: 1 });
    findings = mergeFindings(findings, [incoming()], { round: 2 });
    expect(repeatedFindings(findings, 2).map((item) => item.id)).toEqual(["stable-finding"]);
    expect(repeatedFindings(findings, 3)).toEqual([]);
  });

  it("produces a stable fingerprint independent of severity and line", () => {
    const a = findingFingerprint({ file: "src/a.ts", title: "Race", requiredChange: "Fix the race" });
    const b = findingFingerprint({ file: "src/a.ts", title: " race ", requiredChange: "fix the race" });
    expect(a).toBe(b);
  });
});

describe("unresolvedFeedback", () => {
  it("serializes only unresolved findings", () => {
    const feedback = unresolvedFeedback([finding({ id: "a" }), finding({ id: "b", resolved: true })]);
    expect(feedback).toContain("\"a\"");
    expect(feedback).not.toContain("\"b\"");
    expect(unresolvedFeedback([])).toBe("");
  });
});
