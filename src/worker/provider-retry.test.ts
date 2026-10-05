import { describe, expect, it, vi } from "vitest";
import { withProviderRetry } from "./provider-retry.js";

describe("withProviderRetry", () => {
  it("retries transient rate limits with exponential backoff and then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withProviderRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("429 rate limit exceeded");
      return "ok";
    }, {
      policy: { attempts: 3, baseDelayMs: 1 },
      onRetry: ({ delayMs }) => { delays.push(delayMs); },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([1, 2]);
  });

  it("does not retry permanent credential errors", async () => {
    let calls = 0;
    await expect(withProviderRetry(async () => {
      calls += 1;
      throw new Error("401 Unauthorized: invalid api key");
    }, { policy: { attempts: 3, baseDelayMs: 1 } })).rejects.toThrow(/Unauthorized/);
    expect(calls).toBe(1);
  });

  it("stops retrying when the run is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(withProviderRetry(async () => {
      calls += 1;
      controller.abort();
      throw new Error("503 service unavailable");
    }, { policy: { attempts: 4, baseDelayMs: 1 }, signal: controller.signal })).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempt limit (AT-REL-006)", async () => {
    let calls = 0;
    const onRetry = vi.fn();
    await expect(withProviderRetry(async () => {
      calls += 1;
      throw new Error("502 bad gateway");
    }, { policy: { attempts: 3, baseDelayMs: 1 }, onRetry })).rejects.toThrow(/502/);
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("calls beforeAttempt and onAttemptFailure for every attempt (NEW-08)", async () => {
    const attempts: number[] = [];
    const failures: number[] = [];
    let calls = 0;
    const result = await withProviderRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("503 service unavailable");
      return "ok";
    }, {
      policy: { attempts: 4, baseDelayMs: 1 },
      beforeAttempt: (attempt) => { attempts.push(attempt); },
      onAttemptFailure: ({ attempt }) => { failures.push(attempt); },
    });
    expect(result).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
    expect(failures).toEqual([1, 2]);
  });

  it("aborts the loop when beforeAttempt refuses the retry (hard budget cap)", async () => {
    let calls = 0;
    await expect(withProviderRetry(async () => {
      calls += 1;
      throw new Error("503 service unavailable");
    }, {
      policy: { attempts: 4, baseDelayMs: 1 },
      beforeAttempt: (attempt) => { if (attempt > 1) throw new Error("budget exhausted"); },
    })).rejects.toThrow(/budget exhausted/);
    expect(calls).toBe(1);
  });

  it("lets a caller stop an otherwise retryable late failure and reports its duration", async () => {
    let calls = 0;
    const failures: Array<{ elapsedMs: number; willRetry: boolean }> = [];
    await expect(withProviderRetry(async () => {
      calls += 1;
      throw new Error("upstream response stream was interrupted");
    }, {
      policy: { attempts: 3, baseDelayMs: 1 },
      shouldRetry: ({ elapsedMs }) => elapsedMs < 0,
      onAttemptFailure: ({ elapsedMs, willRetry }) => { failures.push({ elapsedMs, willRetry }); },
    })).rejects.toThrow(/interrupted/);
    expect(calls).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(failures[0].willRetry).toBe(false);
  });
});
