import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run, RunArtifact, RunEvent } from "../shared/types.js";
import { mergeHumanNotes } from "./run-notes.js";

interface DatabaseShape {
  runs: Run[];
  events: Record<string, RunEvent[]>;
}

function artifactSha(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export type EventListener = (event: RunEvent) => void;

export interface AppendEventOptions {
  /** Idempotency key for at-least-once delivery (AT-REL-004). */
  deliveryId?: string;
}

/** GAP-04: run artifact metadata; `content` is only returned by `getArtifact`. */
export type ArtifactRecord = RunArtifact;

export interface ArtifactContent extends ArtifactRecord {
  content: string | null;
}

export interface SaveArtifactInput {
  runId: string;
  artifactId: string;
  kind: string;
  content: string;
  baseSha?: string | null;
  createdAt?: string;
}

/**
 * B1: a guard evaluated against the authoritative run inside the write
 * transaction. Returning `allow: false` performs no write at all.
 */
export type UpdateGuard = (run: Run) => { allow: true } | { allow: false; code: string; message: string };

/** B1: result of a guarded CAS write; a rejection carries the authoritative run. */
export type GuardedUpdateResult =
  | { ok: true; run: Run }
  | { ok: false; code: string; message: string; run: Run };

/** Storage contract shared by the JSON (dev/test) and PostgreSQL (REL-001) stores. */
export interface RunStoreLike {
  init(): Promise<void>;
  listRuns(owner: string | string[]): Run[];
  getRun(id: string, owner?: string | string[]): Run | undefined;
  createRun(run: Run, event: Omit<RunEvent, "seq">): Promise<Run>;
  updateRun(id: string, patch: Partial<Run>): Promise<Run>;
  /**
   * B1: guarded compare-and-swap. The authoritative run is read (and, on the
   * PostgreSQL store, locked) inside the write transaction; the patch is only
   * applied when `guard` allows it. A rejection performs no write and returns
   * the current run so the caller can replan instead of clobbering a
   * concurrent winner.
   */
  updateRunGuarded(id: string, guard: UpdateGuard, patch: Partial<Run>): Promise<GuardedUpdateResult>;
  appendEvent(event: Omit<RunEvent, "seq">, options?: AppendEventOptions): Promise<RunEvent>;
  getEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]>;
  subscribe(runId: string, listener: EventListener): () => void;
  deleteRun(id: string): Promise<void>;
  /** GAP-04: artifact metadata, newest first (content is never returned here). */
  listArtifacts(runId: string): Promise<ArtifactRecord[]>;
  /** GAP-04/AUD-16: one artifact including its stored content, when present. */
  getArtifact(runId: string, artifactId: string): Promise<ArtifactContent | undefined>;
  /** AUD-16: persists the full artifact content (overwrites a metadata-only row). */
  saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord>;
}

export class RunStore implements RunStoreLike {
  private data: DatabaseShape = { runs: [], events: {} };
  private artifacts = new Map<string, ArtifactContent>();
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
    this.projectArtifact(run);
    await this.appendEvent(event);
    return run;
  }

  async updateRun(id: string, patch: Partial<Run>) {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    // 需求历史: humanNotes are append-only and never edited, so merge them
    // instead of letting a replace-style patch drop a concurrently added note.
    const next = patch.humanNotes !== undefined
      ? { ...patch, humanNotes: mergeHumanNotes(run.humanNotes, patch.humanNotes) }
      : patch;
    Object.assign(run, next, { updatedAt: new Date().toISOString() });
    this.projectArtifact(run);
    await this.persist();
    return run;
  }

  /**
   * B1: guarded update for the JSON store. Single-process by design, so the
   * guard is evaluated against the current run before the patch is applied.
   */
  async updateRunGuarded(id: string, guard: UpdateGuard, patch: Partial<Run>): Promise<GuardedUpdateResult> {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    const decision = guard(run);
    if (!decision.allow) return { ok: false, code: decision.code, message: decision.message, run };
    const updated = await this.updateRun(id, patch);
    return { ok: true, run: updated };
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
    for (const key of [...this.artifacts.keys()]) {
      if (this.artifacts.get(key)?.runId === id) this.artifacts.delete(key);
    }
    await this.persist();
  }

  // ------------------------------------------------------------------ artifacts (GAP-04 / AUD-16)

  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getArtifact(runId: string, artifactId: string): Promise<ArtifactContent | undefined> {
    return this.artifacts.get(`${runId}|${artifactId}`);
  }

  async saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
    const record: ArtifactContent = {
      runId: input.runId,
      artifactId: input.artifactId,
      kind: input.kind,
      bytes: Buffer.byteLength(input.content, "utf8"),
      sha256: artifactSha(input.content),
      baseSha: input.baseSha ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      content: input.content,
    };
    this.artifacts.set(`${input.runId}|${input.artifactId}`, record);
    return record;
  }

  /** Metadata-only diff artifact so a run created with a diff is always listed. */
  private projectArtifact(run: Run) {
    if (!run.diff) return;
    const key = `${run.id}|diff`;
    const existing = this.artifacts.get(key);
    if (existing?.content) return;
    this.artifacts.set(key, {
      runId: run.id,
      artifactId: "diff",
      kind: "patch",
      bytes: Buffer.byteLength(run.diff, "utf8"),
      sha256: artifactSha(run.diff),
      baseSha: run.baseSha ?? null,
      createdAt: run.updatedAt,
      content: existing?.content ?? null,
    });
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
