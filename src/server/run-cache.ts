import type { Run } from "../shared/types.js";

function isFinished(run: Run) {
  return run.state === "completed" || run.state === "failed" || run.state === "cancelled";
}

export function runCacheCapacity(value = process.env.PI_RUN_CACHE_MAX) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 2000;
}

export class RunCache {
  private readonly entries = new Map<string, Run>();

  constructor(private readonly capacity: number) {}

  get size() {
    return this.entries.size;
  }

  list(owner: string | string[]) {
    const keys = new Set(Array.isArray(owner) ? owner : [owner]);
    return [...this.entries.values()]
      .filter((run) => keys.has(run.ownerId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string) {
    this.entries.delete(id);
  }

  get(id: string) {
    const run = this.entries.get(id);
    if (run) {
      this.entries.delete(id);
      this.entries.set(id, run);
    }
    return run;
  }

  set(id: string, run: Run) {
    if (!this.entries.has(id) && this.entries.size === this.capacity) {
      for (const [candidate, cached] of this.entries) {
        if (isFinished(cached)) {
          this.entries.delete(candidate);
          break;
        }
      }
      // A full cache of active Runs can still serve additional Runs from PostgreSQL.
      if (this.entries.size === this.capacity) return;
    }
    this.entries.delete(id);
    this.entries.set(id, run);
  }
}
