import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/types.js";
import { mergeFindings, unresolvedFeedback } from "./review-findings.js";

const finding = (id: string, resolved = false): Finding => ({
  id,
  severity: "high",
  file: null,
  line: null,
  title: `问题 ${id}`,
  evidence: "证据",
  requiredChange: "修改",
  resolved,
});

describe("review findings helpers", () => {
  it("marks previous findings resolved when a new review arrives", () => {
    const merged = mergeFindings([finding("a"), finding("b", true)], [finding("c")]);
    expect(merged.map((item) => [item.id, item.resolved])).toEqual([["a", true], ["b", true], ["c", false]]);
  });

  it("builds the repair brief from unresolved findings only", () => {
    const feedback = unresolvedFeedback([finding("a"), finding("b", true)]);
    expect(feedback).toContain("问题 a");
    expect(feedback).not.toContain("问题 b");
    expect(unresolvedFeedback(undefined)).toBe("");
    expect(unresolvedFeedback([])).toBe("");
  });
});
