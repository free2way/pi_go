import { describe, expect, it } from "vitest";
import {
  defaultReviewerRetryMaxElapsedMs,
  parseThinkingLevel,
  reviewerRetryMaxElapsedMs,
  shouldRetryProviderAttempt,
} from "./review-performance.js";

describe("review performance policy", () => {
  it("uses medium reviewer thinking unless low/medium/high is explicitly configured", () => {
    expect(parseThinkingLevel(undefined, "medium")).toBe("medium");
    expect(parseThinkingLevel(" HIGH ", "medium")).toBe("high");
    expect(parseThinkingLevel("invalid", "medium")).toBe("medium");
  });

  it("parses the late reviewer retry threshold strictly", () => {
    expect(reviewerRetryMaxElapsedMs(undefined)).toBe(defaultReviewerRetryMaxElapsedMs);
    expect(reviewerRetryMaxElapsedMs("90")).toBe(90_000);
    expect(reviewerRetryMaxElapsedMs("0")).toBe(Number.POSITIVE_INFINITY);
    expect(reviewerRetryMaxElapsedMs("1.5")).toBe(defaultReviewerRetryMaxElapsedMs);
  });

  it("stops only late reviewer retries", () => {
    expect(shouldRetryProviderAttempt({ role: "reviewer", elapsedMs: 120_001, reviewerMaxElapsedMs: 120_000 })).toBe(false);
    expect(shouldRetryProviderAttempt({ role: "reviewer", elapsedMs: 120_000, reviewerMaxElapsedMs: 120_000 })).toBe(true);
    expect(shouldRetryProviderAttempt({ role: "developer", elapsedMs: 900_000, reviewerMaxElapsedMs: 120_000 })).toBe(true);
  });
});
