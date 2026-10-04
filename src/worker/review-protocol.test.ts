import { describe, expect, it } from "vitest";
import { parseReview } from "./review-protocol.js";

describe("review protocol", () => {
  it("parses fenced reviewer JSON and normalizes findings", () => {
    const review = parseReview([
      "```json",
      JSON.stringify({
        verdict: "changes_requested",
        summary: "One defect",
        findings: [{
          id: "race-cleanup",
          severity: "high",
          file: "src/auth/session.ts",
          line: 46,
          title: "锁未在失败路径清理",
          evidence: "finally 缺失",
          requiredChange: "使用 finally",
        }],
      }),
      "```",
    ].join("\n"), 2);

    expect(review.verdict).toBe("changes_requested");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].id).toBe("race-cleanup");
    expect(review.findings[0].severity).toBe("high");
  });

  it("defaults malformed finding fields instead of throwing", () => {
    const review = parseReview(JSON.stringify({
      verdict: "changes_requested",
      findings: [{ severity: "urgent", line: "12", title: 42 }],
    }), 3);

    expect(review.findings[0]).toMatchObject({
      id: "review-3-1",
      severity: "medium",
      file: null,
      line: null,
      title: "42",
    });
  });

  it("rejects invalid verdicts and non-array findings", () => {
    expect(() => parseReview(JSON.stringify({ verdict: "maybe", findings: [] }))).toThrow();
    expect(() => parseReview(JSON.stringify({ verdict: "approved" }))).toThrow();
    expect(() => parseReview("not json at all")).toThrow();
  });

  it("rejects an approved verdict that carries blocking findings (AUD-03)", () => {
    const approvedWithHigh = JSON.stringify({
      verdict: "approved",
      summary: "looks fine",
      findings: [{ id: "f1", severity: "high", file: "src/a.ts", line: 1, title: "Broken auth", evidence: "e", requiredChange: "r" }],
    });
    expect(() => parseReview(approvedWithHigh)).toThrow(/blocking/);

    const approvedWithMedium = JSON.stringify({
      verdict: "approved",
      summary: "ok",
      findings: [{ id: "f2", severity: "medium", file: null, line: null, title: "Medium issue", evidence: "e", requiredChange: "r" }],
    });
    expect(() => parseReview(approvedWithMedium)).toThrow(/blocking/);

    // Low severity notes are allowed alongside an approval.
    const approvedWithLow = JSON.stringify({
      verdict: "approved",
      summary: "ok",
      findings: [{ id: "f3", severity: "low", file: null, line: null, title: "nit", evidence: "e", requiredChange: "r" }],
    });
    expect(parseReview(approvedWithLow).verdict).toBe("approved");

    // changes_requested may carry any severity.
    const changes = JSON.stringify({
      verdict: "changes_requested",
      summary: "fix",
      findings: [{ id: "f4", severity: "critical", file: null, line: null, title: "critical", evidence: "e", requiredChange: "r" }],
    });
    expect(parseReview(changes).verdict).toBe("changes_requested");
  });

});
