export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * SEC-008 / AT-SEC-005: fixed-window per-key rate limiting for write endpoints
 * (credential writes, run creation, cancel and human-in-the-loop actions).
 * Buckets are pruned on access so the map cannot grow without bound.
 */
export class RateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    const cutoff = now - this.windowMs;
    const hits = (this.buckets.get(key) ?? []).filter((value) => value > cutoff);
    if (hits.length >= this.limit) {
      this.buckets.set(key, hits);
      const oldest = hits[0];
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    hits.push(now);
    this.buckets.set(key, hits);
    if (this.buckets.size > 5_000) this.prune(cutoff);
    return { allowed: true, remaining: Math.max(0, this.limit - hits.length), retryAfterMs: 0 };
  }

  private prune(cutoff: number) {
    for (const [key, hits] of this.buckets) {
      const kept = hits.filter((value) => value > cutoff);
      if (kept.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, kept);
    }
  }

  reset(key?: string) {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}
