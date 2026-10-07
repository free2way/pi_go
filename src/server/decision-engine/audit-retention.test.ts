/**
 * AT-JEV-056 (docs/27 §7.6): decision-audit retention and cleanup.
 *
 * Covers the store's real SQL (over pg-mem, which exercises migration 15), the
 * policy defaults, the sweeper contracts (default-off, throttle, never throws,
 * structured cleanup record) and the worker-side trigger that rides the
 * existing maintenance tick. The internal route is exercised end to end with
 * Fastify `inject` — no network, no Docker, no provider.
 *
 * The worker trigger is tested here (instead of in `src/worker/**`) so the
 * single command named by the acceptance task — `vitest run
 * src/server/decision-engine/audit-retention.test.ts` — covers every layer.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  DECISION_AUDIT_RETENTION_DAYS_ENV,
  DECISION_AUDIT_RETENTION_MAX_ROWS_CEILING,
  DECISION_AUDIT_RETENTION_MAX_ROWS_ENV,
  decisionAuditRetentionEnabled,
  decisionAuditRetentionPolicy,
  parseDecisionAuditRetentionDays,
  parseDecisionAuditRetentionMaxRows,
} from "../../shared/decision-retention.js";
import {
  createAuditRetentionTrigger,
  DECISION_AUDIT_RETENTION_PATH as WORKER_RETENTION_PATH,
  DECISION_AUDIT_RETENTION_REQUEST_TIMEOUT_MS,
  DECISION_AUDIT_RETENTION_TRIGGER_INTERVAL_MS,
} from "../../worker/audit-retention.js";
import type { Queryable } from "../db.js";
import {
  DECISION_AUDIT_RETENTION_PATH as ROUTE_RETENTION_PATH,
  registerDecisionRoutes,
  type DecisionRouteDeps,
} from "../decision-routes.js";
import { createTestDb } from "../test-db.js";
import {
  createDecisionAuditRetentionSweeper,
  decisionAuditRetentionCutoff,
  DECISION_AUDIT_RETENTION_MIN_INTERVAL_MS,
} from "./audit-retention.js";
import {
  DecisionAuditStore,
  type DecisionAuditPruneResult,
  type DecisionAuditPruneStore,
} from "./audit-store.js";
import type { DecisionEvaluationRecord } from "./types.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
/** 2026-09-06T12:00:00.000Z — exactly 30 days before NOW. */
const CUTOFF_30D = "2026-09-06T12:00:00.000Z";
const INTERNAL_TOKEN = "internal-worker-token-for-retention-tests";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

function record(overrides: Partial<DecisionEvaluationRecord> = {}): DecisionEvaluationRecord {
  const evaluationId = overrides.evaluationId ?? `eval-${Math.random().toString(36).slice(2)}`;
  return {
    evaluationId,
    runId: "run-retention",
    kind: "review_triage",
    mode: "shadow",
    provider: "typesafe",
    requestedModel: "jev-latest",
    policyVersion: "policy-1",
    stateHash: "state-hash",
    status: "completed",
    answers: [],
    latencyMs: 12,
    createdAt: NOW.toISOString(),
    stateManifest: {},
    questionSchemaHash: "question-schema-hash",
    idempotencyKey: `key-${evaluationId}`,
    ...overrides,
  };
}

/** Inserts one audit row per timestamp and returns the newest-first read cap. */
async function seed(db: TestDb, stamps: string[]): Promise<DecisionAuditStore> {
  const audit = new DecisionAuditStore(db);
  for (const [index, stamp] of stamps.entries()) {
    await audit.insert(record({ evaluationId: `eval-${index}-${stamp}`, createdAt: stamp }));
  }
  return audit;
}

async function rows(db: TestDb): Promise<Array<{ id: string; created_at: string }>> {
  return (await db.query("SELECT id, created_at FROM decision_evaluations ORDER BY created_at ASC, id ASC"))
    .rows as Array<{ id: string; created_at: string }>;
}

async function count(db: TestDb, table: string): Promise<number> {
  const row = (await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0] ?? {};
  return Number(row.count) || 0;
}

/** Wraps a real database and records every statement it receives. */
function recording(inner: Queryable): { db: Queryable; statements: Array<{ text: string; params?: unknown[] }> } {
  const statements: Array<{ text: string; params?: unknown[] }> = [];
  return {
    statements,
    db: {
      query: async (text: string, params?: unknown[]) => {
        statements.push({ text, params });
        return inner.query(text, params);
      },
    },
  };
}

describe("AT-JEV-056 retention policy defaults", () => {
  it("defaults to 0 days / 0 rows (never delete) for unset, blank or mistyped values", () => {
    expect(decisionAuditRetentionPolicy({})).toEqual({ retentionDays: 0, maxRows: 0 });
    expect(decisionAuditRetentionEnabled({})).toBe(false);
    for (const value of ["", "   ", "0", "-1", "7.5", "7d", "yes", "1e3", "0x10"]) {
      expect(parseDecisionAuditRetentionDays(value)).toBe(0);
      expect(decisionAuditRetentionEnabled({ [DECISION_AUDIT_RETENTION_DAYS_ENV]: value })).toBe(false);
    }
    for (const value of ["", "0", "-5", "many", "2.5"]) {
      expect(parseDecisionAuditRetentionMaxRows(value)).toBe(0);
    }
  });

  it("accepts an explicit positive window (with surrounding whitespace) and a positive row cap", () => {
    expect(parseDecisionAuditRetentionDays(" 30 ")).toBe(30);
    expect(parseDecisionAuditRetentionMaxRows("250")).toBe(250);
    const policy = decisionAuditRetentionPolicy({
      [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30",
      [DECISION_AUDIT_RETENTION_MAX_ROWS_ENV]: "250",
    });
    expect(policy).toEqual({ retentionDays: 30, maxRows: 250 });
    expect(decisionAuditRetentionEnabled({ [DECISION_AUDIT_RETENTION_DAYS_ENV]: "1" })).toBe(true);
  });

  it("derives the cutoff as now minus the retention window (ISO-8601 UTC)", () => {
    expect(decisionAuditRetentionCutoff(NOW, 30)).toBe(CUTOFF_30D);
    expect(decisionAuditRetentionCutoff(NOW, 1)).toBe("2026-10-05T12:00:00.000Z");
  });
});

describe("AT-JEV-056 DecisionAuditStore.pruneOlderThan", () => {
  it("deletes only rows strictly older than the cutoff; a row exactly at the cutoff is retained", async () => {
    const db = await createTestDb();
    const cutoff = "2026-09-06T12:00:00.000Z";
    await seed(db, [
      "2026-09-06T11:59:59.999Z", // 1ms past the window -> deleted
      cutoff, // exactly at the cutoff -> RETAINED
      "2026-09-06T12:00:00.001Z",
      "2026-10-06T12:00:00.000Z",
    ]);
    const audit = new DecisionAuditStore(db);

    const result = await audit.pruneOlderThan(cutoff, 0);
    expect(result).toEqual({
      cutoff,
      limit: 0,
      deleted: 1,
      oldestDeletedAt: "2026-09-06T11:59:59.999Z",
      newestDeletedAt: "2026-09-06T11:59:59.999Z",
    });
    const remaining = await rows(db);
    expect(remaining.map((row) => row.created_at)).toEqual([
      cutoff,
      "2026-09-06T12:00:00.001Z",
      "2026-10-06T12:00:00.000Z",
    ]);
  });

  it("caps one sweep at MAX_ROWS, always taking the OLDEST rows first", async () => {
    const db = await createTestDb();
    const cutoff = "2026-09-06T12:00:00.000Z";
    await seed(db, [
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-10-06T00:00:00.000Z", // inside the window
    ]);
    const audit = new DecisionAuditStore(db);

    const result = await audit.pruneOlderThan(cutoff, 2);
    expect(result.limit).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.oldestDeletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.newestDeletedAt).toBe("2026-02-01T00:00:00.000Z");
    expect((await rows(db)).map((row) => row.created_at)).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-10-06T00:00:00.000Z",
    ]);

    // A second sweep removes the next-oldest batch; nothing inside the window goes.
    const second = await audit.pruneOlderThan(cutoff, 2);
    expect(second.deleted).toBe(2);
    expect((await rows(db)).map((row) => row.created_at)).toEqual(["2026-10-06T00:00:00.000Z"]);
  });

  it("treats a non-positive cap as unlimited and clamps an absurd cap to the ceiling", async () => {
    const db = await createTestDb();
    const cutoff = "2026-09-06T12:00:00.000Z";
    await seed(db, ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z"]);
    const audit = new DecisionAuditStore(db);

    const clamped = await audit.pruneOlderThan(cutoff, 1_000_000_000);
    expect(clamped.limit).toBe(DECISION_AUDIT_RETENTION_MAX_ROWS_CEILING);
    expect(clamped.deleted).toBe(2);

    await seed(db, ["2026-03-01T00:00:00.000Z"]);
    const unlimited = await audit.pruneOlderThan(cutoff, -1);
    expect(unlimited.limit).toBe(0);
    expect(unlimited.deleted).toBe(1);
  });

  it("is a no-op (and reports zero) when every row is inside the window", async () => {
    const db = await createTestDb();
    await seed(db, ["2026-10-06T00:00:00.000Z"]);
    const audit = new DecisionAuditStore(db);

    expect(await audit.pruneOlderThan("2026-09-06T12:00:00.000Z", 0)).toEqual({
      cutoff: "2026-09-06T12:00:00.000Z",
      limit: 0,
      deleted: 0,
    });
    // The bounded branch must not issue a DELETE either.
    expect(await audit.pruneOlderThan("2026-09-06T12:00:00.000Z", 10)).toEqual({
      cutoff: "2026-09-06T12:00:00.000Z",
      limit: 10,
      deleted: 0,
    });
    expect(await count(db, "decision_evaluations")).toBe(1);
  });

  it("never touches run master data (runs / run_events / run_artifacts)", async () => {
    const db = await createTestDb();
    await db.query(
      "INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, document_json) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["run-retention", "owner-a", "completed", "real", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "{}"],
    );
    await db.query(
      "INSERT INTO run_events (run_id, seq, at, round, source, type, message) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["run-retention", 1, "2025-01-01T00:00:00.000Z", 1, "system", "run.created", "created"],
    );
    await db.query(
      "INSERT INTO run_artifacts (run_id, artifact_id, kind, bytes, created_at) VALUES ($1,$2,$3,$4,$5)",
      ["run-retention", "art-1", "diff", 10, "2025-01-01T00:00:00.000Z"],
    );
    const audit = await seed(db, ["2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z"]);

    const result = await audit.pruneOlderThan("2026-09-06T12:00:00.000Z", 0);

    expect(result.deleted).toBe(2);
    expect(await count(db, "decision_evaluations")).toBe(0);
    expect(await count(db, "runs")).toBe(1);
    expect(await count(db, "run_events")).toBe(1);
    expect(await count(db, "run_artifacts")).toBe(1);
  });

  it("issues DELETE statements against decision_evaluations only", async () => {
    const inner = await createTestDb();
    const { db, statements } = recording(inner);
    await seed(inner, ["2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z", "2020-01-03T00:00:00.000Z"]);
    const audit = new DecisionAuditStore(db);

    await audit.pruneOlderThan("2026-09-06T12:00:00.000Z", 2); // bounded branch
    await audit.pruneOlderThan("2026-09-06T12:00:00.000Z", 0); // unlimited branch

    const deletes = statements.filter((statement) => /^\s*delete\s/i.test(statement.text));
    expect(deletes).toHaveLength(2);
    for (const statement of deletes) {
      expect(statement.text).toMatch(/decision_evaluations/);
      for (const table of ["runs", "run_events", "run_artifacts"]) {
        expect(statement.text).not.toMatch(new RegExp(`\\b${table}\\b`));
      }
    }
    // Every statement the sweep issues (SELECT/DELETE) names the audit table.
    for (const statement of statements) {
      expect(statement.text).toMatch(/decision_evaluations/);
      expect(statement.text).not.toMatch(/\b(?:runs|run_events|run_artifacts)\b/);
    }
  });
});

describe("AT-JEV-056 retention sweeper", () => {
  it("with the default 0 days performs no query, no delete and writes no log", async () => {
    const pruneOlderThan = vi.fn(async (): Promise<DecisionAuditPruneResult> => ({ cutoff: "", limit: 0, deleted: 0 }));
    const warn = vi.fn();
    const sweep = createDecisionAuditRetentionSweeper({
      store: { pruneOlderThan } as DecisionAuditPruneStore,
      env: {},
      now: () => NOW,
      warn,
    });

    expect(await sweep()).toBeUndefined();
    expect(await sweep({ force: true })).toBeUndefined();
    expect(pruneOlderThan).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("with a positive window prunes strictly-older rows and records the cleanup", async () => {
    const db = await createTestDb();
    const audit = await seed(db, [
      "2026-01-01T00:00:00.000Z",
      CUTOFF_30D,
      "2026-09-06T12:00:00.001Z",
      NOW.toISOString(),
    ]);
    const warn = vi.fn();
    const sweep = createDecisionAuditRetentionSweeper({
      store: audit,
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30" },
      now: () => NOW,
      warn,
    });

    const result = await sweep();

    expect(result).toEqual({
      retentionDays: 30,
      maxRows: 0,
      cutoff: CUTOFF_30D,
      deleted: 1,
      limit: 0,
      oldestDeletedAt: "2026-01-01T00:00:00.000Z",
      newestDeletedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await rows(db)).map((row) => row.created_at)).toEqual([
      CUTOFF_30D,
      "2026-09-06T12:00:00.001Z",
      NOW.toISOString(),
    ]);
    // The cleanup record: one structured line carrying policy + window + count.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, details] = warn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(message).toBe("[decisions] audit retention sweep");
    expect(details).toMatchObject({ retentionDays: 30, cutoff: CUTOFF_30D, deleted: 1 });
  });

  it("throttles repeated calls and honours the MAX_ROWS policy", async () => {
    const calls: Array<{ cutoff: string; maxRows?: number }> = [];
    const store: DecisionAuditPruneStore = {
      pruneOlderThan: async (cutoff, maxRows) => {
        calls.push({ cutoff, maxRows });
        return { cutoff, limit: maxRows ?? 0, deleted: 0 };
      },
    };
    let at = NOW.getTime();
    const sweep = createDecisionAuditRetentionSweeper({
      store,
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "7", [DECISION_AUDIT_RETENTION_MAX_ROWS_ENV]: "25" },
      now: () => new Date(at),
      warn: vi.fn(),
    });

    expect(await sweep()).toBeDefined();
    expect(await sweep()).toBeUndefined(); // inside the throttle window
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cutoff: "2026-09-29T12:00:00.000Z", maxRows: 25 });

    at += DECISION_AUDIT_RETENTION_MIN_INTERVAL_MS;
    expect(await sweep()).toBeDefined();
    expect(calls).toHaveLength(2);
    // `force` bypasses the throttle (used by tests/ops, not by the worker tick).
    expect(await sweep({ force: true })).toBeDefined();
    expect(calls).toHaveLength(3);
  });

  it("never rejects: a failing store logs one bounded warning and the loop continues", async () => {
    const SECRET = "sk-DO-NOT-LEAK-0123456789";
    const warn = vi.fn();
    const sweep = createDecisionAuditRetentionSweeper({
      store: {
        pruneOlderThan: async () => {
          throw new Error("connection refused while deleting audit rows");
        },
      },
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30", TYPESAFE_API_KEY: SECRET },
      now: () => NOW,
      warn,
    });

    await expect(sweep()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, details] = warn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(message).toBe("[decisions] audit retention sweep failed");
    expect(details).toMatchObject({ retentionDays: 30, cutoff: CUTOFF_30D });
    // The failure text is bounded and the environment is never dumped: the log
    // carries policy numbers + the error only, never a credential.
    expect(String(details.error).length).toBeLessThanOrEqual(300);
    expect(Object.keys(details).sort()).toEqual(["cutoff", "error", "maxRows", "retentionDays"]);
    expect(JSON.stringify(details)).not.toContain(SECRET);
    expect(JSON.stringify(details)).not.toContain("TYPESAFE_API_KEY");
  });
});

describe("AT-JEV-056 worker retention trigger", () => {
  it("sends nothing at all while the default 0 days is in force (zero queries, zero deletes)", async () => {
    const send = vi.fn(async () => ({}));
    const trigger = createAuditRetentionTrigger({ send, env: {}, now: () => NOW.getTime() });

    expect(await trigger()).toBe(false);
    expect(await trigger()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("requests one sweep per hour via the internal path when a window is configured", async () => {
    const send = vi.fn(async () => ({}));
    let at = NOW.getTime();
    const trigger = createAuditRetentionTrigger({
      send,
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30" },
      now: () => at,
    });

    expect(await trigger()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [pathName, init, timeoutMs] = send.mock.calls[0] as unknown as [string, RequestInit, number];
    expect(pathName).toBe(WORKER_RETENTION_PATH);
    expect(pathName).toBe("/decisions/audit/retention");
    expect(init.method).toBe("POST");
    expect(timeoutMs).toBe(DECISION_AUDIT_RETENTION_REQUEST_TIMEOUT_MS);

    expect(await trigger()).toBe(false); // throttled
    expect(send).toHaveBeenCalledTimes(1);

    at += DECISION_AUDIT_RETENTION_TRIGGER_INTERVAL_MS;
    expect(await trigger()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("swallows a failing sweep into one warning so the maintenance loop is unaffected", async () => {
    const warn = vi.fn();
    let at = NOW.getTime();
    const send = vi.fn(async () => {
      throw new Error("Internal request failed: 503");
    });
    const trigger = createAuditRetentionTrigger({
      send,
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30" },
      now: () => at,
      warn,
    });

    await expect(trigger()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[decisions] audit retention sweep trigger failed");
    expect(warn.mock.calls[0][0]).not.toContain("Bearer");

    // The next window still attempts a sweep instead of staying wedged.
    at += DECISION_AUDIT_RETENTION_TRIGGER_INTERVAL_MS;
    await expect(trigger()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("AT-JEV-056 internal retention route", () => {
  async function buildApp(options: { audit: DecisionRouteDeps["audit"]; env?: NodeJS.ProcessEnv }) {
    const app = Fastify();
    const deps: DecisionRouteDeps = {
      store: {
        getRun: () => undefined,
        appendEvent: async () => undefined,
      },
      audit: options.audit,
      env: options.env ?? {},
      now: () => NOW,
      loadConfig: (() => ({ ok: false, reason: "disabled", detail: "test" })) as unknown as DecisionRouteDeps["loadConfig"],
      createEngine: (() => {
        throw new Error("no engine in this test");
      }) as unknown as DecisionRouteDeps["createEngine"],
      buildBatches: (() => []) as unknown as DecisionRouteDeps["buildBatches"],
      internalAuthorized: (request) => request.headers.authorization === `Bearer ${INTERNAL_TOKEN}`,
      ownerKeysFor: () => "owner-a",
    };
    registerDecisionRoutes(app, deps);
    await app.ready();
    return app;
  }

  it("rejects an unauthenticated call (internal token only)", async () => {
    const db = await createTestDb();
    const app = await buildApp({ audit: new DecisionAuditStore(db), env: {} });
    try {
      const response = await app.inject({ method: "POST", url: ROUTE_RETENTION_PATH });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("performs a sweep and returns the cleanup record", async () => {
    const db = await createTestDb();
    const audit = await seed(db, ["2026-01-01T00:00:00.000Z", "2026-09-06T12:00:00.001Z", NOW.toISOString()]);
    const app = await buildApp({ audit, env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30" } });
    try {
      const response = await app.inject({
        method: "POST",
        url: ROUTE_RETENTION_PATH,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        skipped: false,
        sweep: {
          retentionDays: 30,
          maxRows: 0,
          cutoff: CUTOFF_30D,
          deleted: 1,
          limit: 0,
          oldestDeletedAt: "2026-01-01T00:00:00.000Z",
          newestDeletedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      expect((await rows(db)).map((row) => row.created_at)).toEqual([
        "2026-09-06T12:00:00.001Z",
        NOW.toISOString(),
      ]);
    } finally {
      await app.close();
    }
  });

  it("reports skipped (and deletes nothing) while retention is disabled", async () => {
    const db = await createTestDb();
    const inner = await seed(db, ["2020-01-01T00:00:00.000Z"]);
    const probe = recording(db);
    const wrapped = new DecisionAuditStore(probe.db);
    void inner;
    const app = await buildApp({ audit: wrapped, env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "0" } });
    try {
      const response = await app.inject({
        method: "POST",
        url: ROUTE_RETENTION_PATH,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, skipped: true, sweep: null });
      expect(probe.statements).toEqual([]); // zero queries, zero deletes
      expect(await count(db, "decision_evaluations")).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("answers 501 for a store without the retention seam", async () => {
    const app = await buildApp({
      audit: {
        findByIdempotencyKey: async () => undefined,
        insert: async () => {
          throw new Error("unused");
        },
        listByRun: async () => [],
        aggregate: async () => ({ total: 0, byStatus: {}, byKind: {} }),
        findLatestCompletedByRequestedModel: async () => undefined,
      },
      env: { [DECISION_AUDIT_RETENTION_DAYS_ENV]: "30" },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: ROUTE_RETENTION_PATH,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });
});
