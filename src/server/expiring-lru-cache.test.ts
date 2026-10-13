import { describe, expect, it } from "vitest";
import { ExpiringLruCache } from "./expiring-lru-cache.js";

describe("ExpiringLruCache", () => {
  it("expires entries so identity changes can be resolved again", () => {
    let now = 1_000;
    const cache = new ExpiringLruCache<string>({ maxEntries: 2, ttlMs: 100, now: () => now });
    cache.set("user", "before");
    expect(cache.get("user")).toBe("before");
    now = 1_100;
    expect(cache.get("user")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("keeps recently used entries and evicts the least recently used at the bound", () => {
    const cache = new ExpiringLruCache<number>({ maxEntries: 2, ttlMs: 1_000, now: () => 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("rejects invalid capacity and TTL values", () => {
    expect(() => new ExpiringLruCache({ maxEntries: 0, ttlMs: 1 })).toThrow(/maxEntries/);
    expect(() => new ExpiringLruCache({ maxEntries: 1, ttlMs: 0 })).toThrow(/ttlMs/);
  });
});
