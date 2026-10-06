/**
 * Decision-plane audit persistence (docs/26-jev-decision-engine-design.md §8.3/§13).
 *
 * One durable row per evaluation in `decision_evaluations`. The store is
 * deliberately dumb: it owns the parameterised SQL, the JSON column mapping and
 * the idempotency seam, and nothing else. All judgement (which status, whether a
 * cost is trustworthy) happens before the row is handed over — but the store
 * still refuses to invent a cost: a missing/non-finite `estimatedCostUsd` is
 * written as NULL, never as 0 (AT-JEV-062).
 *
 * Idempotency mirrors `agile_release_deploy_claims` (`agile.ts`):
 * `idempotency_key` is UNIQUE, `INSERT … ON CONFLICT DO NOTHING` means a
 * repeated `evaluationId` can never create a second row, and the winner is the
 * caller whose freshly generated `id` is the one stored (pg-mem returns the
 * conflicting row from `DO NOTHING … RETURNING`, real PostgreSQL returns none,
 * so `created` is decided by comparing ids instead of by the insert result).
 */

import type { Queryable } from "../db.js";
import type { DecisionEvaluationRecord } from "./types.js";

/** Newest-first read cap for `GET /api/runs/:runId/decisions`. */
export const DECISION_AUDIT_MAX_ROWS = 200;
export const DECISION_AUDIT_DEFAULT_ROWS = 50;

const COLUMNS = [
  "id",
  "run_id",
  "kind",
  "mode",
  "provider",
  "requested_model",
  "resolved_model",
  "policy_version",
  "state_hash",
  "question_schema_hash",
  "state_manifest_json",
  "answers_json",
  "status",
  "fallback_reason",
  "detail",
  "applied_outcome",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "estimated_cost_usd",
  "created_at",
  "idempotency_key",
].join(", ");

/** Insert order: `id` first, then the same COLUMNS list. */
const INSERT_COLUMNS = COLUMNS;
const INSERT_PLACEHOLDERS = COLUMNS.split(", ").map((_column, index) => `$${index + 1}`).join(", ");

export interface DecisionAuditAggregate {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
}

/** Small surface the routes depend on, so tests can inject a fake. */
export interface DecisionAuditStoreLike {
  findByIdempotencyKey(idempotencyKey: string): Promise<DecisionEvaluationRecord | undefined>;
  insert(record: DecisionEvaluationRecord): Promise<{ record: DecisionEvaluationRecord; created: boolean }>;
  listByRun(runId: string, limit?: number): Promise<DecisionEvaluationRecord[]>;
  aggregate(): Promise<DecisionAuditAggregate>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function nullableStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function intOrNull(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/**
 * `estimated_cost_usd` is the only float column. pg and pg-mem both surface it
 * as a JS number, but a differently-configured driver could return a numeric
 * string, so it is normalised explicitly (and never truncated to an integer).
 */
function floatOrNull(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A trustworthy cost is a finite, non-negative number. Anything else (missing,
 * NaN, negative) is stored as NULL — reporting an unknown cost as `0` would
 * make an unmetered provider look free.
 */
export function reliableCost(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseJsonColumn(value: unknown, fallback: unknown) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

/** Maps one `decision_evaluations` row into the typed audit record. */
export function decisionRowToRecord(row: Record<string, unknown>): DecisionEvaluationRecord {
  const manifest = parseJsonColumn(row.state_manifest_json, {});
  const answers = parseJsonColumn(row.answers_json, []);
  return {
    evaluationId: str(row.id),
    runId: str(row.run_id),
    kind: str(row.kind) as DecisionEvaluationRecord["kind"],
    mode: str(row.mode) as DecisionEvaluationRecord["mode"],
    provider: str(row.provider) as DecisionEvaluationRecord["provider"],
    requestedModel: str(row.requested_model),
    ...(nullableStr(row.resolved_model) !== undefined ? { resolvedModel: String(row.resolved_model) } : {}),
    policyVersion: str(row.policy_version),
    stateHash: str(row.state_hash),
    status: str(row.status) as DecisionEvaluationRecord["status"],
    answers: Array.isArray(answers) ? (answers as DecisionEvaluationRecord["answers"]) : [],
    ...(nullableStr(row.applied_outcome) !== undefined ? { appliedOutcome: String(row.applied_outcome) } : {}),
    ...(nullableStr(row.fallback_reason) !== undefined
      ? { fallbackReason: String(row.fallback_reason) as DecisionEvaluationRecord["fallbackReason"] }
      : {}),
    ...(nullableStr(row.detail) !== undefined ? { detail: String(row.detail) } : {}),
    latencyMs: intOrNull(row.latency_ms) ?? 0,
    ...(intOrNull(row.input_tokens) !== undefined ? { inputTokens: intOrNull(row.input_tokens) } : {}),
    ...(intOrNull(row.output_tokens) !== undefined ? { outputTokens: intOrNull(row.output_tokens) } : {}),
    ...(floatOrNull(row.estimated_cost_usd) !== undefined ? { estimatedCostUsd: floatOrNull(row.estimated_cost_usd) } : {}),
    createdAt: str(row.created_at),
    stateManifest:
      manifest && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as Record<string, unknown>) : {},
    questionSchemaHash: str(row.question_schema_hash),
    idempotencyKey: str(row.idempotency_key),
  };
}

export class DecisionAuditStore implements DecisionAuditStoreLike {
  constructor(private readonly db: Queryable) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<DecisionEvaluationRecord | undefined> {
    const row = (await this.db.query(
      `SELECT ${COLUMNS} FROM decision_evaluations WHERE idempotency_key = $1`,
      [idempotencyKey],
    )).rows[0];
    return row ? decisionRowToRecord(row) : undefined;
  }

  async findById(id: string): Promise<DecisionEvaluationRecord | undefined> {
    const row = (await this.db.query(`SELECT ${COLUMNS} FROM decision_evaluations WHERE id = $1`, [id])).rows[0];
    return row ? decisionRowToRecord(row) : undefined;
  }

  /**
   * Idempotent by `idempotencyKey`. A duplicate returns the STORED row with
   * `created: false`; the caller can then skip the provider call and the event
   * pair, so a replay never double-counts.
   */
  async insert(record: DecisionEvaluationRecord): Promise<{ record: DecisionEvaluationRecord; created: boolean }> {
    const existing = await this.findByIdempotencyKey(record.idempotencyKey);
    if (existing) return { record: existing, created: false };
    await this.db.query(
      `INSERT INTO decision_evaluations (${INSERT_COLUMNS})
       VALUES (${INSERT_PLACEHOLDERS})
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        record.evaluationId,
        record.runId,
        record.kind,
        record.mode,
        record.provider,
        record.requestedModel,
        record.resolvedModel ?? null,
        record.policyVersion,
        record.stateHash,
        record.questionSchemaHash,
        JSON.stringify(record.stateManifest ?? {}),
        JSON.stringify(record.answers ?? []),
        record.status,
        record.fallbackReason ?? null,
        record.detail ?? null,
        record.appliedOutcome ?? null,
        Number.isFinite(record.latencyMs) ? Math.max(0, Math.trunc(record.latencyMs)) : 0,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        reliableCost(record.estimatedCostUsd),
        record.createdAt,
        record.idempotencyKey,
      ],
    );
    const stored = await this.findByIdempotencyKey(record.idempotencyKey);
    if (!stored) throw new Error("decision evaluation insert did not persist");
    return { record: stored, created: stored.evaluationId === record.evaluationId };
  }

  /** Newest first; the read is bounded so a long-lived run cannot flood the API. */
  async listByRun(runId: string, limit = DECISION_AUDIT_DEFAULT_ROWS): Promise<DecisionEvaluationRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || DECISION_AUDIT_DEFAULT_ROWS, 1), DECISION_AUDIT_MAX_ROWS);
    const rows = (await this.db.query(
      `SELECT ${COLUMNS} FROM decision_evaluations WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [runId, bounded],
    )).rows;
    return rows.map(decisionRowToRecord);
  }

  /**
   * Bounded counts by status/kind for the config and metrics surfaces. Labels
   * are fixed columns (never a run/evaluation id), so the projection stays
   * low-cardinality (AT-JEV-064).
   */
  async aggregate(): Promise<DecisionAuditAggregate> {
    const byStatusRows = (await this.db.query(
      "SELECT status, COUNT(*)::int AS count FROM decision_evaluations GROUP BY status",
    )).rows as Array<{ status: unknown; count: unknown }>;
    const byKindRows = (await this.db.query(
      "SELECT kind, COUNT(*)::int AS count FROM decision_evaluations GROUP BY kind",
    )).rows as Array<{ kind: unknown; count: unknown }>;
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let total = 0;
    for (const row of byStatusRows) {
      const count = Number(row.count) || 0;
      byStatus[str(row.status)] = count;
      total += count;
    }
    for (const row of byKindRows) byKind[str(row.kind)] = Number(row.count) || 0;
    return { total, byStatus, byKind };
  }
}
