import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run, RunEvent } from "../shared/types.js";

interface DatabaseShape {
  runs: Run[];
  events: Record<string, RunEvent[]>;
}

export type EventListener = (event: RunEvent) => void;

export interface AppendEventOptions {
  /** Idempotency key for at-least-once delivery (AT-REL-004). */
  deliveryId?: string;
}

/** Storage contract shared by the JSON (dev/test) and PostgreSQL (REL-001) stores. */
export interface RunStoreLike {
  init(): Promise<void>;
  listRuns(owner: string | string[]): Run[];
  getRun(id: string, owner?: string | string[]): Run | undefined;
  createRun(run: Run, event: Omit<RunEvent, "seq">): Promise<Run>;
  updateRun(id: string, patch: Partial<Run>): Promise<Run>;
  appendEvent(event: Omit<RunEvent, "seq">, options?: AppendEventOptions): Promise<RunEvent>;
  getEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]>;
  subscribe(runId: string, listener: EventListener): () => void;
  deleteRun(id: string): Promise<void>;
}

export class RunStore implements RunStoreLike {
  private data: DatabaseShape = { runs: [], events: {} };
  private listeners = new Map<string, Set<EventListener>>();
  private deliveryIds = new Map<string, Map<string, number>>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, "utf8")) as DatabaseShape;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listRuns(owner: string | string[]) {
    const keys = new Set(Array.isArray(owner) ? owner : [owner]);
    return this.data.runs.filter((run) => keys.has(run.ownerId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getRun(id: string, owner?: string | string[]) {
    const keys = owner === undefined ? undefined : new Set(Array.isArray(owner) ? owner : [owner]);
    return this.data.runs.find((run) => run.id === id && (!keys || keys.has(run.ownerId)));
  }

  async createRun(run: Run, event: Omit<RunEvent, "seq">) {
    this.data.runs.push(run);
    this.data.events[run.id] = [];
    await this.appendEvent(event);
    return run;
  }

  async updateRun(id: string, patch: Partial<Run>) {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return run;
  }

  async appendEvent(event: Omit<RunEvent, "seq">, options: AppendEventOptions = {}) {
    if (options.deliveryId) {
      const seen = this.deliveryIds.get(event.runId);
      const previousSeq = seen?.get(options.deliveryId);
      if (previousSeq !== undefined) {
        const existing = (this.data.events[event.runId] ?? []).find((item) => item.seq === previousSeq);
        if (existing) return existing;
      }
    }
    const events = this.data.events[event.runId] ?? [];
    const record: RunEvent = { ...event, seq: (events.at(-1)?.seq ?? 0) + 1 };
    events.push(record);
    this.data.events[event.runId] = events;
    if (options.deliveryId) {
      const seen = this.deliveryIds.get(event.runId) ?? new Map<string, number>();
      seen.set(options.deliveryId, record.seq);
      this.deliveryIds.set(event.runId, seen);
    }
    const run = this.getRun(event.runId);
    if (run) {
      run.lastSeq = record.seq;
      run.updatedAt = record.at;
    }
    await this.persist();
    for (const listener of this.listeners.get(event.runId) ?? []) listener(record);
    return record;
  }

  async getEvents(runId: string, after = 0, limit = Number.MAX_SAFE_INTEGER) {
    return (this.data.events[runId] ?? []).filter((event) => event.seq > after).slice(0, limit);
  }

  subscribe(runId: string, listener: EventListener) {
    const listeners = this.listeners.get(runId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async deleteRun(id: string) {
    const index = this.data.runs.findIndex((run) => run.id === id);
    if (index === -1) throw new Error(`Run not found: ${id}`);
    this.data.runs.splice(index, 1);
    delete this.data.events[id];
    this.deliveryIds.delete(id);
    this.listeners.delete(id);
    await this.persist();
  }

  private persist() {
    const attempt = this.writeQueue
      .catch((error) => {
        console.error("[store] previous persist failed; continuing with the next write", error);
      })
      .then(async () => {
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, JSON.stringify(this.data, null, 2), "utf8");
        await rename(temporary, this.filePath);
      });
    this.writeQueue = attempt;
    return attempt;
  }
}
