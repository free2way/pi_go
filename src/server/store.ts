import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run, RunEvent } from "../shared/types.js";

interface DatabaseShape {
  runs: Run[];
  events: Record<string, RunEvent[]>;
}

type EventListener = (event: RunEvent) => void;

export class RunStore {
  private data: DatabaseShape = { runs: [], events: {} };
  private listeners = new Map<string, Set<EventListener>>();
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

  listRuns(ownerId: string) {
    return this.data.runs.filter((run) => run.ownerId === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getRun(id: string, ownerId?: string) {
    return this.data.runs.find((run) => run.id === id && (!ownerId || run.ownerId === ownerId));
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

  async appendEvent(event: Omit<RunEvent, "seq">) {
    const events = this.data.events[event.runId] ?? [];
    const record: RunEvent = { ...event, seq: (events.at(-1)?.seq ?? 0) + 1 };
    events.push(record);
    this.data.events[event.runId] = events;
    const run = this.getRun(event.runId);
    if (run) {
      run.lastSeq = record.seq;
      run.updatedAt = record.at;
    }
    await this.persist();
    for (const listener of this.listeners.get(event.runId) ?? []) listener(record);
    return record;
  }

  getEvents(runId: string, after = 0) {
    return (this.data.events[runId] ?? []).filter((event) => event.seq > after);
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

  private persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(this.data, null, 2), "utf8");
      await rename(temporary, this.filePath);
    });
    return this.writeQueue;
  }
}
