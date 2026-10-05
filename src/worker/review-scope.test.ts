import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/types.js";
import {
  blockingFindings,
  blockingSeveritiesForScope,
  deferredFindings,
  deferredMessage,
  isDeferral,
  resolveReviewScope,
  severeSeverities,
  shouldAcceptRound,
} from "./review-scope.js";

function finding(severity: Finding["severity"], resolved = false): Finding {
  return { id: `${severity}-${resolved}`, severity, file: null, line: null, title: severity, evidence: "", requiredChange: "", resolved };
}

describe("resolveReviewScope", () => {
  it("defaults to `all` for missing or unknown values (older runs)", () => {
    expect(resolveReviewScope(undefined)).toBe("all");
    expect(resolveReviewScope({})).toBe("all");
    expect(resolveReviewScope({ reviewScope: "all" })).toBe("all");
    expect(resolveReviewScope({ reviewScope: "blocking" })).toBe("blocking");
  });
});

describe("blocking set per scope", () => {
  it("keeps medium blocking under `all` and drops it under `blocking`", () => {
    expect(blockingSeveritiesForScope("all")).toContain("medium");
    expect(blockingSeveritiesForScope("blocking")).toEqual(severeSeverities);
  });

  it("collects only unresolved findings", () => {
    const findings = [finding("critical"), finding("high", true), finding("medium")];
    expect(blockingFindings(findings, "all").map((item) => item.id)).toEqual(["critical-false", "medium-false"]);
    expect(blockingFindings(findings, "blocking").map((item) => item.id)).toEqual(["critical-false"]);
  });
});

describe("deferredFindings / isDeferral", () => {
  it("defers medium/low only under the blocking scope", () => {
    const findings = [finding("critical"), finding("medium"), finding("low"), finding("low", true)];
    expect(deferredFindings(findings, "all")).toEqual([]);
    expect(deferredFindings(findings, "blocking").map((item) => item.id)).toEqual(["medium-false", "low-false"]);
    expect(isDeferral("blocking", deferredFindings(findings, "blocking"))).toBe(true);
    expect(isDeferral("all", deferredFindings(findings, "all"))).toBe(false);
  });

  it("builds a message naming the round and count", () => {
    expect(deferredMessage(3, deferredFindings([finding("low")], "blocking"))).toContain("第 3 轮");
    expect(deferredMessage(3, deferredFindings([finding("low")], "blocking"))).toContain("1 个非阻断问题");
  });
});

describe("shouldAcceptRound", () => {
  it("accepts an approved verdict under either scope", () => {
    expect(shouldAcceptRound({ verdict: "approved", scope: "all", blocking: [] })).toBe(true);
    expect(shouldAcceptRound({ verdict: "approved", scope: "blocking", blocking: [] })).toBe(true);
  });

  it("repairs a changes_requested round under the default scope", () => {
    expect(shouldAcceptRound({ verdict: "changes_requested", scope: "all", blocking: [] })).toBe(false);
  });

  it("accepts (approval-with-notes) a changes_requested round with no critical/high under `blocking`", () => {
    expect(shouldAcceptRound({ verdict: "changes_requested", scope: "blocking", blocking: [] })).toBe(true);
  });

  it("still repairs a changes_requested round when a critical/high finding blocks, even under `blocking`", () => {
    expect(shouldAcceptRound({ verdict: "changes_requested", scope: "blocking", blocking: [finding("high")] })).toBe(false);
  });
});
