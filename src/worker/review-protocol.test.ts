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
});
