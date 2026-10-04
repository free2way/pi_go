import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the limit inside the window and then blocks", () => {
    const limiter = new RateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.check("user_a", now).allowed).toBe(true);
    expect(limiter.check("user_a", now + 1).allowed).toBe(true);
    expect(limiter.check("user_a", now + 2).allowed).toBe(true);
    const blocked = limiter.check("user_a", now + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks keys independently and recovers after the window", () => {
    const limiter = new RateLimiter(2, 1_000);
    limiter.check("a", 0);
    limiter.check("a", 1);
    expect(limiter.check("a", 2).allowed).toBe(false);
    expect(limiter.check("b", 2).allowed).toBe(true);
    expect(limiter.check("a", 1_500).allowed).toBe(true);
  });

  it("bounds memory by pruning stale buckets", () => {
    const limiter = new RateLimiter(1, 1_000);
    for (let index = 0; index < 6_000; index += 1) limiter.check(`key_${index}`, 10_000 + index);
    limiter.check("fresh", 100_000);
    const size = (limiter as unknown as { buckets: Map<string, number[]> }).buckets.size;
    expect(size).toBeLessThan(6_000);
  });
});
