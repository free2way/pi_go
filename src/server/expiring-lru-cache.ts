export class ExpiringLruCache<Value> {
  private readonly entries = new Map<string, { value: Value; expiresAt: number }>();

  constructor(
    private readonly options: { maxEntries: number; ttlMs: number; now?: () => number },
  ) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1) throw new Error("ttlMs must be positive");
  }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= (this.options.now ?? Date.now)()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order on access while preserving the original expiry.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value) {
    const now = (this.options.now ?? Date.now)();
    for (const [existingKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(existingKey);
    }
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + this.options.ttlMs });
  }

  get size() {
    return this.entries.size;
  }
}
