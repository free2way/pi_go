import { createHash } from "node:crypto";
import type { Run, RunEvent } from "../shared/types.js";
import type { Db } from "./db.js";
import type {
  AppendEventOptions,
  ArtifactContent,
  ArtifactRecord,
  EventListener,
  RunStoreLike,
  SaveArtifactInput,
} from "./store.js";

export type JobState = "queued" | "claimed" | "done" | "failed" | "cancelled";

/**
 * AUD-15 / AT-RUN-014: legal run state transitions. Terminal states can never be
 * overwritten by a late worker callback (e.g. cancelled -> completed).
 */
const runTransitions: Record<string, ReadonlyArray<string>> = {
  queued: ["preparing", "developing", "checking", "reviewing", "cancelled", "failed", "needs_human"],
  preparing: ["developing", "checking", "reviewing", "cancelled", "failed", "needs_human"],
  developing: ["checking", "reviewing", "cancelled", "failed", "needs_human"],
  checking: ["developing", "reviewing", "cancelled", "failed", "needs_human"],
  reviewing: ["developing", "completed", "cancelled", "failed", "needs_human"],
  // GAP-04 / AT-RUN-009: a human may approve the delivered worktree (completed)
  // or reject/terminate it (cancelled).
  needs_human: ["queued", "reviewing", "checking", "developing", "completed", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION";
  constructor(readonly from: string, readonly to: string) {
    super(`Illegal run state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export function assertTransition(from: string, to: string) {
  if (from === to) return;
  const allowed = runTransitions[from];
  if (!allowed) throw new InvalidStateTransitionError(from, to);
  if (!allowed.includes(to)) throw new InvalidStateTransitionError(from, to);
}

/** Creates the delivery table used to make internal updates idempotent. */
export async function recordDelivery(db: Db, runId: string, deliveryId: string, seq?: number) {
  await db.query(
    "INSERT INTO run_deliveries (run_id, delivery_id, seq, applied_at) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, delivery_id) DO NOTHING",
    [runId, deliveryId, seq ?? null, new Date().toISOString()],
  );
}

export interface JobRecord {
  id: string;
  runId: string;
  kind: string;
  state: JobState;
  payload: unknown;
  workerId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  /** AUD-05: set only when a worker actually started executing the job. */
  startedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRecord {
  runId: string;
  stageKey: string;
  status: string;
  payload: unknown;
  idempotencyKey: string | null;
  updatedAt: string;
}

export type EventListenerAlias = EventListener;

interface RunRow {
  id: string;
  owner_id: string;
  last_seq: number;
  document_json: string;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * PostgreSQL-backed run store (REL-001).
 *
 * Runs live in a `runs` row (document + indexed columns) with normalized
 * metadata projections for agents/checks/findings/artifacts, the event log is
 * append-only with a monotonic per-run `seq` (REL-004), stage checkpoints carry
 * idempotency keys (REL-003) and jobs are persisted so a restarted worker can
 * reclaim unfinished work (REL-002).
 *
 * Run lookups are served from a warm in-memory cache because the single web
 * process owns every write; events are never cached so a lagging SSE client
 * cannot grow web memory without bound (AT-REL-008).
 */
export class PostgresRunStore implements RunStoreLike {
  private cache = new Map<string, Run>();
  private listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly db: Db) {}

  async init() {
    const result = await this.db.query("SELECT id, owner_id, last_seq, document_json FROM runs");
    for (const row of result.rows as unknown as RunRow[]) {
      const run = JSON.parse(row.document_json) as Run;
      run.lastSeq = Number(row.last_seq);
      this.cache.set(row.id, run);
    }
  }

  listRuns(owner: string | string[]) {
    const keys = new Set(Array.isArray(owner) ? owner : [owner]);
    return [...this.cache.values()]
      .filter((run) => keys.has(run.ownerId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Multi-process safety: load a run created by another web instance (rolling
   * deploy, ops tooling) instead of treating it as missing. A newer cached
   * snapshot is never replaced by an older database row.
   */
  async hydrate(id: string): Promise<Run | undefined> {
    const row = (await this.db.query("SELECT id, owner_id, last_seq, document_json FROM runs WHERE id = $1", [id])).rows[0] as unknown as RunRow | undefined;
    if (!row) return undefined;
    const fromDb = JSON.parse(row.document_json) as Run;
    fromDb.lastSeq = Number(row.last_seq);
    const cached = this.cache.get(row.id);
    if (!cached || String(cached.updatedAt ?? "") < String(fromDb.updatedAt ?? "")) {
      this.cache.set(row.id, fromDb);
    }
    return this.cache.get(row.id);
  }

  getRun(id: string, owner?: string | string[]) {
    const run = this.cache.get(id);
    if (!run) return undefined;
    if (owner === undefined) return run;
    const keys = new Set(Array.isArray(owner) ? owner : [owner]);
    return keys.has(run.ownerId) ? run : undefined;
  }

  async createRun(run: Run, event: Omit<RunEvent, "seq">) {
    const snapshot: Run = { ...run };
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, last_seq, document_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET state = $3, updated_at = $6, last_seq = $7, document_json = $8`,
        [snapshot.id, snapshot.ownerId, snapshot.state, snapshot.mode, snapshot.createdAt, snapshot.updatedAt, snapshot.lastSeq ?? 0, JSON.stringify(snapshot)],
      );
      await this.project(tx, snapshot);
    });
    // AUD-06: the cache is only published after the transaction committed.
    this.cache.set(snapshot.id, snapshot);
    await this.appendEvent(event);
    return this.cache.get(run.id) ?? snapshot;
  }

  /**
   * AUD-06/AUD-15: applies a patch to a copy, validates the state transition,
   * persists it, and only then publishes the new snapshot to the read cache.
   */
  async updateRun(id: string, patch: Partial<Run>) {
    const current = this.cache.get(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.state && patch.state !== current.state) {
      assertTransition(current.state, patch.state);
    }
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `UPDATE runs SET state = $2, updated_at = $3, document_json = $4 WHERE id = $1`,
        [next.id, next.state, next.updatedAt, JSON.stringify(next)],
      );
      await this.project(tx, next);
    });
    this.cache.set(id, next);
    return next;
  }

  /**
   * AUD-15 / AT-REL-004: applies a patch and its event atomically under one
   * delivery key. A repeated delivery is a no-op that returns the stored result,
   * so a late retry can never rewind state or double count usage.
   */
  async applyDelivery(input: {
    runId: string;
    deliveryId: string;
    patch?: Partial<Run>;
    event?: Omit<RunEvent, "seq">;
  }) {
    const seen = (await this.db.query(
      "SELECT seq FROM run_deliveries WHERE run_id = $1 AND delivery_id = $2",
      [input.runId, input.deliveryId],
    )).rows[0];
    if (seen) {
      return { applied: false, seq: seen.seq === null ? undefined : Number(seen.seq) };
    }
    const current = this.cache.get(input.runId);
    if (!current) throw new Error(`Run not found: ${input.runId}`);
    const next = input.patch ? { ...current, ...input.patch, updatedAt: new Date().toISOString() } : current;
    if (input.patch?.state && input.patch.state !== current.state) {
      assertTransition(current.state, input.patch.state);
    }

    const result = await this.db.withTransaction(async (tx) => {
      const inserted = (await tx.query(
        "INSERT INTO run_deliveries (run_id, delivery_id, applied_at) VALUES ($1, $2, $3) ON CONFLICT (run_id, delivery_id) DO NOTHING RETURNING delivery_id",
        [input.runId, input.deliveryId, new Date().toISOString()],
      )).rows[0];
      if (!inserted) return { applied: false, seq: undefined as number | undefined };

      let seq: number | undefined;
      if (input.patch) {
        await tx.query(
          `UPDATE runs SET state = $2, updated_at = $3, last_seq = $4, document_json = $5 WHERE id = $1`,
          [next.id, next.state, next.updatedAt, next.lastSeq ?? 0, JSON.stringify(next)],
        );
        await this.project(tx, next);
      }
      if (input.event) {
        const bumped = await this.nextSequence(tx, input.runId, input.event.at);
        if (!bumped) throw new Error(`Run not found: ${input.runId}`);
        seq = Number(bumped.last_seq);
        await tx.query(
          `INSERT INTO run_events (run_id, seq, at, round, source, type, message, meta_json, delivery_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.event.runId,
            seq,
            input.event.at,
            input.event.round,
            input.event.source,
            input.event.type,
            input.event.message,
            input.event.meta ? JSON.stringify(input.event.meta) : null,
            null,
          ],
        );
        await tx.query("UPDATE run_deliveries SET seq = $3 WHERE run_id = $1 AND delivery_id = $2", [input.runId, input.deliveryId, seq]);
      }
      return { applied: true, seq };
    });

    if (result.applied) {
      const snapshot = { ...next, lastSeq: result.seq ?? next.lastSeq };
      this.cache.set(input.runId, snapshot);
      if (input.event && result.seq !== undefined) {
        const record: RunEvent = { ...input.event, seq: result.seq };
        for (const listener of this.listeners.get(input.runId) ?? []) {
          try {
            listener(record);
          } catch (error) {
            console.error("[store] event listener failed", error);
          }
        }
      }
    }
    return result;
  }

  /**
   * Appends one event with a monotonic per-run sequence. When `deliveryId` was
   * already recorded the stored event is returned unchanged, so a duplicate
   * internal delivery cannot double count state, usage or events (AT-REL-004).
   */
  async appendEvent(event: Omit<RunEvent, "seq">, options: AppendEventOptions = {}) {
    if (options.deliveryId) {
      const existing = (await this.db.query(
        "SELECT seq FROM run_events WHERE run_id = $1 AND delivery_id = $2",
        [event.runId, options.deliveryId],
      )).rows[0];
      if (existing) {
        const events = await this.getEvents(event.runId, Number(existing.seq) - 1, 1);
        if (events[0]) return events[0];
      }
    }
    const seq = await this.db.withTransaction(async (tx) => {
      const next = await this.nextSequence(tx, event.runId, event.at);
      if (!next) throw new Error(`Run not found: ${event.runId}`);
      const value = Number(next.last_seq);
      await tx.query(
        `INSERT INTO run_events (run_id, seq, at, round, source, type, message, meta_json, delivery_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.runId,
          value,
          event.at,
          event.round,
          event.source,
          event.type,
          event.message,
          event.meta ? JSON.stringify(event.meta) : null,
          options.deliveryId ?? null,
        ],
      );
      return value;
    });
    const record: RunEvent = { ...event, seq };
    const run = this.cache.get(event.runId);
    if (run) {
      run.lastSeq = seq;
      run.updatedAt = event.at;
    }
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(record);
      } catch (error) {
        console.error("[store] event listener failed", error);
      }
    }
    return record;
  }

  async getEvents(runId: string, after = 0, limit = 500) {
    const result = await this.db.query(
      `SELECT seq, at, round, source, type, message, meta_json FROM run_events
       WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [runId, after, limit],
    );
    return result.rows.map((row) => ({
      seq: Number(row.seq),
      runId,
      at: String(row.at),
      round: Number(row.round),
      source: String(row.source) as RunEvent["source"],
      type: String(row.type),
      message: String(row.message),
      ...(row.meta_json ? { meta: JSON.parse(String(row.meta_json)) as Record<string, unknown> } : {}),
    }));
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
    if (!this.cache.has(id)) throw new Error(`Run not found: ${id}`);
    this.cache.delete(id);
    this.listeners.delete(id);
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM run_events WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_agents WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_checks WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_findings WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_artifacts WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_usage_role WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM run_checkpoints WHERE run_id = $1", [id]);
      await tx.query("DELETE FROM runs WHERE id = $1", [id]);
    });
  }

  // -------------------------------------------------- artifacts (GAP-04 / AUD-16)

  /** GAP-04: artifact metadata for a run, newest first; content is excluded. */
  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    const result = await this.db.query(
      "SELECT run_id, artifact_id, kind, bytes, sha256, base_sha, created_at FROM run_artifacts WHERE run_id = $1 ORDER BY created_at DESC",
      [runId],
    );
    return result.rows.map((row) => this.mapArtifact(row));
  }

  /** Reads artifact metadata + content from PostgreSQL so the download is authoritative. */
  async getArtifact(runId: string, artifactId: string): Promise<ArtifactContent | undefined> {
    const row = (await this.db.query(
      "SELECT run_id, artifact_id, kind, bytes, sha256, base_sha, created_at, content FROM run_artifacts WHERE run_id = $1 AND artifact_id = $2",
      [runId, artifactId],
    )).rows[0];
    if (!row) return undefined;
    return { ...this.mapArtifact(row), content: row.content === null || row.content === undefined ? null : String(row.content) };
  }

  /**
   * AUD-16: persists the full artifact body. The per-run process is the only
   * writer, so a plain upsert is enough; `content` is never truncated here (the
   * route enforces a download cap separately).
   */
  async saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const bytes = Buffer.byteLength(input.content, "utf8");
    const hash = sha256(input.content);
    await this.db.query(
      `INSERT INTO run_artifacts (run_id, artifact_id, kind, bytes, sha256, base_sha, created_at, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (run_id, artifact_id) DO UPDATE SET
         kind = $3, bytes = $4, sha256 = $5, base_sha = $6, created_at = $7, content = $8`,
      [input.runId, input.artifactId, input.kind, bytes, hash, input.baseSha ?? null, createdAt, input.content],
    );
    return {
      runId: input.runId,
      artifactId: input.artifactId,
      kind: input.kind,
      bytes,
      sha256: hash,
      baseSha: input.baseSha ?? null,
      createdAt,
    };
  }

  private mapArtifact(row: Record<string, unknown>): ArtifactRecord {
    return {
      runId: String(row.run_id),
      artifactId: String(row.artifact_id),
      kind: String(row.kind),
      bytes: Number(row.bytes),
      sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
      baseSha: row.base_sha === null || row.base_sha === undefined ? null : String(row.base_sha),
      createdAt: String(row.created_at),
    };
  }

  // ---------------------------------------------------------------- checkpoints

  async saveCheckpoint(input: { runId: string; stageKey: string; status: string; payload?: unknown; idempotencyKey?: string | null }) {
    await this.db.query(
      `INSERT INTO run_checkpoints (run_id, stage_key, status, payload_json, idempotency_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, stage_key) DO UPDATE SET
         status = $3,
         payload_json = COALESCE($4, run_checkpoints.payload_json),
         idempotency_key = COALESCE($5, run_checkpoints.idempotency_key),
         updated_at = $6`,
      [
        input.runId,
        input.stageKey,
        input.status,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async listCheckpoints(runId: string): Promise<CheckpointRecord[]> {
    const result = await this.db.query(
      "SELECT run_id, stage_key, status, payload_json, idempotency_key, updated_at FROM run_checkpoints WHERE run_id = $1 ORDER BY updated_at ASC, stage_key ASC",
      [runId],
    );
    return result.rows.map((row) => ({
      runId: String(row.run_id),
      stageKey: String(row.stage_key),
      status: String(row.status),
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null,
      idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
      updatedAt: String(row.updated_at),
    }));
  }

  async clearCheckpoints(runId: string, stagePrefix?: string) {
    if (stagePrefix) {
      await this.db.query("DELETE FROM run_checkpoints WHERE run_id = $1 AND stage_key LIKE $2", [runId, `${stagePrefix}%`]);
      return;
    }
    await this.db.query("DELETE FROM run_checkpoints WHERE run_id = $1", [runId]);
  }

  // --------------------------------------------------------------------- jobs

  async createJob(input: { id: string; runId: string; kind: string; payload: unknown; state?: JobState }) {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO jobs (id, run_id, kind, state, payload_json, attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $6)
       ON CONFLICT (id) DO UPDATE SET state = $4, payload_json = $5, updated_at = $6`,
      [input.id, input.runId, input.kind, input.state ?? "queued", JSON.stringify(input.payload), now],
    );
    return this.getJob(input.id);
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    const rows = await this.db.query(
      "SELECT id, run_id, kind, state, payload_json, worker_id, claimed_at, heartbeat_at, started_at, attempts, last_error, created_at, updated_at FROM jobs WHERE id = $1",
      [id],
    );
    return rows.rows[0] ? this.mapJob(rows.rows[0]) : undefined;
  }

  /**
   * Marks a job as dispatched by the web process. The row is already handed to
   * the worker over HTTP, so it must not also be picked up by the periodic
   * reclaim sweep before the worker claims it (REL-002). `started_at` stays NULL:
   * a reserved job has not begun executing (AUD-05).
   */
  async reserveJob(id: string) {
    const now = new Date().toISOString();
    await this.db.query(
      "UPDATE jobs SET state = 'claimed', worker_id = 'web-dispatch', claimed_at = $2, heartbeat_at = $2, updated_at = $2 WHERE id = $1 AND state = 'queued'",
      [id, now],
    );
  }

  /** AUD-05: releases a reservation so a queued job can be claimed again immediately. */
  async releaseReservation(id: string, reason?: string) {
    const now = new Date().toISOString();
    await this.db.query(
      "UPDATE jobs SET state = 'queued', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, last_error = COALESCE($2, last_error), updated_at = $3 WHERE id = $1 AND state IN ('queued','claimed')",
      [id, reason ?? null, now],
    );
  }

  async claimJob(id: string, workerId: string) {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = 'claimed', worker_id = $2, claimed_at = $3, heartbeat_at = $3, started_at = COALESCE(started_at, $3),
         attempts = attempts + 1, updated_at = $3
       WHERE id = $1 AND state IN ('queued', 'claimed') RETURNING id`,
      [id, workerId, now],
    );
    if (result.rows.length === 0) return undefined;
    return this.getJob(id);
  }

  async heartbeatJob(id: string, workerId: string) {
    const now = new Date().toISOString();
    await this.db.query("UPDATE jobs SET heartbeat_at = $3, updated_at = $3 WHERE id = $1 AND worker_id = $2", [id, workerId, now]);
  }

  async finishJob(id: string, state: Exclude<JobState, "queued" | "claimed">, lastError?: string) {
    const now = new Date().toISOString();
    await this.db.query("UPDATE jobs SET state = $2, last_error = $3, updated_at = $4 WHERE id = $1", [id, state, lastError ?? null, now]);
  }

  /**
   * Keeps a claimable job in the queue while recording why it could not be
   * served this cycle (e.g. the run is not visible yet on this web instance).
   * Deliberately does not touch `attempts`/`state`: a transient condition must
   * not burn the job's retry budget or strand the run in `queued`.
   */
  async deferJob(id: string, reason: string) {
    const now = new Date().toISOString();
    await this.db.query("UPDATE jobs SET last_error = $2, updated_at = $3 WHERE id = $1 AND state = 'queued'", [id, reason, now]);
  }

  /**
   * Jobs a worker may pick up: never claimed, or claimed by a worker whose
   * heartbeat went stale (worker restart, AT-REL-002/003).
   */
  async listPendingJobs(input: { staleAfterMs: number; kinds?: string[]; limit?: number }) {
    const cutoff = new Date(Date.now() - input.staleAfterMs).toISOString();
    const result = await this.db.query(
      `SELECT id, run_id, kind, state, payload_json, worker_id, claimed_at, heartbeat_at, started_at, attempts, last_error, created_at, updated_at
       FROM jobs
       WHERE (state = 'queued' AND attempts < 5)
          OR (state = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < $1) AND attempts < 5)
       ORDER BY updated_at ASC LIMIT $2`,
      [cutoff, input.limit ?? 20],
    );
    const jobs = result.rows.map((row) => this.mapJob(row));
    return input.kinds ? jobs.filter((job) => input.kinds!.includes(job.kind)) : jobs;
  }

  async requeueStaleJobs(staleAfterMs: number) {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = 'queued', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = $2
       WHERE state = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < $1) AND attempts < 5 RETURNING id`,
      [cutoff, new Date().toISOString()],
    );
    return result.rows.map((row) => String(row.id));
  }

  /** Row counts per table for backup/restore verification (AT-REL-009). */
  async statistics() {
    const tables = ["runs", "run_events", "run_agents", "run_checks", "run_findings", "run_artifacts", "run_usage_role", "run_checkpoints", "jobs"];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = (await this.db.query(`SELECT COUNT(*) AS total FROM ${table}`)).rows[0];
      counts[table] = Number(row.total);
    }
    const digest = (await this.db.query(
      "SELECT COALESCE(SUM(last_seq), 0) AS seq_total, COALESCE(MAX(updated_at), '') AS newest FROM runs",
    )).rows[0];
    return { counts, seqTotal: Number(digest.seq_total), newest: String(digest.newest) };
  }

  /** sha256 over every stored run document, for restore comparison (AT-REL-009). */
  async contentDigest() {
    const result = await this.db.query("SELECT id, document_json FROM runs ORDER BY id ASC");
    const hash = createHash("sha256");
    for (const row of result.rows) {
      hash.update(`${String(row.id)}\n${String(row.document_json)}\n`);
    }
    return hash.digest("hex");
  }

  /**
   * One-time import of a legacy `runs.json` document (REL-001 migration).
   * Existing rows are never overwritten, so a restart cannot regress state.
   */
  async importLegacy(
    data: { runs: Run[]; events: Record<string, RunEvent[]> },
    options: { defaultOwnerId?: string } = {},
  ) {
    let importedRuns = 0;
    let importedEvents = 0;
    let skippedRuns = 0;
    const now = new Date().toISOString();
    for (const run of data.runs ?? []) {
      if (!run?.id || this.cache.has(run.id)) {
        if (!run?.id) skippedRuns += 1;
        continue;
      }
      // Runs created before owner scoping have no ownerId; they belong to the
      // single pre-migration owner recorded in users.legacy_owner_id.
      const ownerId = run.ownerId || options.defaultOwnerId;
      if (!ownerId) {
        skippedRuns += 1;
        continue;
      }
      const events = (data.events?.[run.id] ?? []).slice().sort((a, b) => a.seq - b.seq);
      const lastSeq = events.at(-1)?.seq ?? run.lastSeq ?? 0;
      const record: Run = {
        ...run,
        ownerId,
        createdAt: run.createdAt || run.updatedAt || now,
        updatedAt: run.updatedAt || run.createdAt || now,
        lastSeq,
      };
      this.cache.set(record.id, record);
      await this.db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, last_seq, document_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [record.id, record.ownerId, record.state, record.mode, record.createdAt, record.updatedAt, lastSeq, JSON.stringify(record)],
        );
        for (const event of events) {
          await tx.query(
            `INSERT INTO run_events (run_id, seq, at, round, source, type, message, meta_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (run_id, seq) DO NOTHING`,
            [event.runId, event.seq, event.at, event.round, event.source, event.type, event.message, event.meta ? JSON.stringify(event.meta) : null],
          );
          importedEvents += 1;
        }
        await this.project(tx, record);
      });
      importedRuns += 1;
    }
    return { importedRuns, importedEvents, skippedRuns };
  }

  /**
   * Allocates the next per-run sequence. A conditional heal first repairs a
   * counter that a legacy/partial write left behind the event log, then the
   * atomic bump serialises concurrent callbacks through the row lock.
   */
  private async nextSequence(tx: Db, runId: string, at: string) {
    const maxRow = (await tx.query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_events WHERE run_id = $1", [runId])).rows[0];
    const maxSeq = Number(maxRow?.max_seq ?? 0);
    if (maxSeq > 0) {
      await tx.query("UPDATE runs SET last_seq = $2 WHERE id = $1 AND last_seq < $2", [runId, maxSeq]);
    }
    return (await tx.query(
      "UPDATE runs SET last_seq = last_seq + 1, updated_at = $2 WHERE id = $1 RETURNING last_seq",
      [runId, at],
    )).rows[0] as { last_seq: number } | undefined;
  }

  private mapJob(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      kind: String(row.kind),
      state: String(row.state) as JobState,
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null,
      workerId: row.worker_id === null ? null : String(row.worker_id),
      claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      heartbeatAt: row.heartbeat_at === null ? null : String(row.heartbeat_at),
      startedAt: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
      attempts: Number(row.attempts),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Rewrites normalized metadata projections for one run inside a transaction. */
  private async project(tx: Db, run: Run) {
    await tx.query("DELETE FROM run_agents WHERE run_id = $1", [run.id]);
    for (const task of run.plan?.tasks ?? []) {
      await tx.query(
        "INSERT INTO run_agents (run_id, agent_id, title, status, branch, summary, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [run.id, task.id, task.title, task.status, task.branch ?? null, task.summary ?? null, task.durationMs ?? null],
      );
    }
    await tx.query("DELETE FROM run_checks WHERE run_id = $1", [run.id]);
    for (const check of run.checks ?? []) {
      await tx.query(
        "INSERT INTO run_checks (run_id, check_id, name, command, status, duration_ms, exit_code) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [run.id, check.id, check.name, check.command, check.status, check.durationMs ?? null, check.exitCode ?? null],
      );
    }
    await tx.query("DELETE FROM run_findings WHERE run_id = $1", [run.id]);
    for (const finding of run.findings ?? []) {
      // AUD-11: findings are upserted by their stable identity, so a reviewer that
      // repeats an id (or reuses it across rounds) can never hit a primary key
      // conflict; observation history is preserved instead.
      await tx.query(
        `INSERT INTO run_findings (run_id, finding_id, severity, file, line, title, resolved, fingerprint, first_seen_round, last_seen_round, observations, consecutive_rounds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (run_id, finding_id) DO UPDATE SET
           severity = $3, file = $4, line = $5, title = $6, resolved = $7,
           fingerprint = COALESCE($8, run_findings.fingerprint),
           first_seen_round = COALESCE(run_findings.first_seen_round, $9),
           last_seen_round = COALESCE($10, run_findings.last_seen_round),
           observations = $11, consecutive_rounds = $12`,
        [
          run.id,
          finding.id,
          finding.severity,
          finding.file,
          finding.line,
          finding.title,
          finding.resolved ? 1 : 0,
          finding.fingerprint ?? null,
          finding.firstSeenRound ?? null,
          finding.lastSeenRound ?? null,
          finding.observations ?? 1,
          finding.consecutiveRounds ?? 0,
        ],
      );
    }
    await tx.query("DELETE FROM run_usage_role WHERE run_id = $1", [run.id]);
    for (const entry of run.usageRoles ?? []) {
      await tx.query(
        `INSERT INTO run_usage_role (run_id, role, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost, calls, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          run.id,
          entry.role,
          entry.model,
          entry.provider,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheReadTokens ?? 0,
          entry.cacheWriteTokens ?? 0,
          entry.estimatedCost,
          entry.calls,
          run.updatedAt,
        ],
      );
    }
    // AUD-16: artifacts are NOT deleted/re-inserted on every projection anymore,
    // so a full diff artifact body saved at terminal state survives later updates.
    // A metadata-only row is created for a run that has a diff but no artifact yet.
    if (run.diff) {
      const existing = (await tx.query("SELECT artifact_id, content FROM run_artifacts WHERE run_id = $1 AND artifact_id = 'diff'", [run.id])).rows[0];
      if (!existing) {
        await tx.query(
          "INSERT INTO run_artifacts (run_id, artifact_id, kind, bytes, sha256, base_sha, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [run.id, "diff", "patch", Buffer.byteLength(run.diff, "utf8"), sha256(run.diff), run.baseSha ?? null, run.updatedAt],
        );
      } else if (existing.content === null || existing.content === undefined) {
        // Keep the metadata in step with the latest preview until a full body is saved.
        await tx.query(
          "UPDATE run_artifacts SET bytes = $2, sha256 = $3, base_sha = COALESCE($4, base_sha), created_at = $5 WHERE run_id = $1 AND artifact_id = 'diff'",
          [run.id, Buffer.byteLength(run.diff, "utf8"), sha256(run.diff), run.baseSha ?? null, run.updatedAt],
        );
      }
    }
  }
}
