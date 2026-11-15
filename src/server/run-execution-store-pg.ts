import type { Db } from "./db.js";

export type JobState = "queued" | "claimed" | "done" | "failed" | "cancelled";

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

export type SaveCheckpointInput = { runId: string; stageKey: string; status: string; payload?: unknown; idempotencyKey?: string | null };
export type CreateJobInput = { id: string; runId: string; kind: string; payload: unknown; state?: JobState };
export type SettledJobState = Exclude<JobState, "queued" | "claimed">;
export type LeaseJobsInput = { workerId: string; capacity: number; staleAfterMs: number };
export type PendingJobsQuery = { staleAfterMs: number; kinds?: string[]; limit?: number };

export class JobLeaseLostError extends Error {
  readonly code = "JOB_LEASE_LOST";
  constructor(readonly jobId: string) {
    super(`Job lease lost: ${jobId}`);
    this.name = "JobLeaseLostError";
  }
}

/** Records a delivery marker for an idempotent internal update. */
export async function recordDelivery(db: Db, runId: string, deliveryId: string, seq?: number) {
  await db.query(
    "INSERT INTO run_deliveries (run_id, delivery_id, seq, applied_at) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, delivery_id) DO NOTHING",
    [runId, deliveryId, seq ?? null, new Date().toISOString()],
  );
}

/** Checks ownership under the same transaction as the worker's Run update. */
export async function assertJobLease(tx: Db, runId: string, jobId: string, workerId: string) {
  const lease = (await tx.query(
    "SELECT run_id, worker_id, state FROM jobs WHERE id = $1 FOR SHARE",
    [jobId],
  )).rows[0];
  if (!lease
    || String(lease.run_id) !== runId
    || String(lease.worker_id) !== workerId
    || String(lease.state) !== "claimed") {
    throw new JobLeaseLostError(jobId);
  }
}

/** PostgreSQL persistence for durable Worker jobs and execution checkpoints. */
export class PostgresRunExecutionStore {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- checkpoints

  async saveCheckpoint(input: SaveCheckpointInput) {
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

  async createJob(input: CreateJobInput) {
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
  async releaseReservation(id: string, workerId: string, reason?: string) {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = 'queued', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
         last_error = COALESCE($3, last_error), updated_at = $4
       WHERE id = $1 AND state = 'claimed' AND worker_id = $2 RETURNING id`,
      [id, workerId, reason ?? null, now],
    );
    return result.rows.length > 0;
  }

  async claimJob(id: string, workerId: string, staleAfterMs = 120_000) {
    const now = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = 'claimed', worker_id = $2, claimed_at = $3, heartbeat_at = $3, started_at = COALESCE(started_at, $3),
         attempts = attempts + CASE WHEN worker_id = $2 THEN 0 ELSE 1 END, updated_at = $3
       WHERE id = $1 AND (
         (state = 'claimed' AND worker_id = $2)
         OR (attempts < 5 AND (
           state = 'queued'
           OR (state = 'claimed' AND worker_id = 'web-dispatch')
           OR (state = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < $4))
         ))
       ) RETURNING id`,
      [id, workerId, now, staleCutoff],
    );
    if (result.rows.length === 0) return undefined;
    return this.getJob(id);
  }

  async heartbeatJob(id: string, workerId: string) {
    const now = new Date().toISOString();
    const result = await this.db.query(
      "UPDATE jobs SET heartbeat_at = $3, updated_at = $3 WHERE id = $1 AND worker_id = $2 AND state = 'claimed' RETURNING id",
      [id, workerId, now],
    );
    return result.rows.length > 0;
  }

  async finishJob(id: string, workerId: string, state: SettledJobState, lastError?: string) {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = $3, last_error = $4, updated_at = $5
       WHERE id = $1 AND worker_id = $2 AND state = 'claimed' RETURNING id`,
      [id, workerId, state, lastError ?? null, now],
    );
    if (result.rows.length > 0) return { ok: true, idempotent: false };
    const current = await this.getJob(id);
    if (current?.workerId === workerId && current.state === state) return { ok: true, idempotent: true };
    return { ok: false, idempotent: false };
  }

  /** Web-only terminal path for missing/terminal runs or unavailable credentials. */
  async finishJobAsSystem(id: string, state: SettledJobState, reason?: string) {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE jobs SET state = $2, last_error = $3, updated_at = $4
       WHERE id = $1 AND state IN ('queued', 'claimed') RETURNING id`,
      [id, state, reason ?? null, now],
    );
    return result.rows.length > 0;
  }

  /** Atomically leases the oldest claimable jobs to one worker. */
  async leaseJobs(input: LeaseJobsInput) {
    const now = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - input.staleAfterMs).toISOString();
    const capacity = Math.min(4, Math.max(1, Math.trunc(input.capacity)));
    const result = await this.db.query(
      `WITH picked AS (
         SELECT id, started_at AS prev_started_at FROM jobs
          WHERE attempts < 5 AND (
            state = 'queued'
            OR (state = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < $1))
          )
          ORDER BY updated_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE jobs j SET state = 'claimed', worker_id = $3, claimed_at = $4, heartbeat_at = $4,
         attempts = j.attempts + 1, updated_at = $4
       FROM picked WHERE j.id = picked.id
       RETURNING j.id, j.run_id, j.kind, j.state, j.payload_json, j.worker_id, j.claimed_at,
         j.heartbeat_at, j.started_at, j.attempts, j.last_error, j.created_at, j.updated_at,
         picked.prev_started_at`,
      [staleCutoff, capacity, input.workerId, now],
    );
    return result.rows.map((row) => ({ job: this.mapJob(row), wasStarted: row.prev_started_at !== null }));
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
  async listPendingJobs(input: PendingJobsQuery) {
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
}
