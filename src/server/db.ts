import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type QueryResult = { rows: Record<string, unknown>[] };

export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PoolLike = Queryable & {
  connect: () => Promise<{ query: Queryable["query"]; release: () => void }>;
};

export type Db = Queryable & {
  withTransaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
};

export function createPool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10_000 });
}

/** Wraps a pg-compatible pool (or pg-mem in tests) with a transaction helper. */
export function createDb(pool: PoolLike): Db {
  const withTransaction = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx: Db = {
        query: (text, params) => client.query(text, params),
        withTransaction: (nested) => nested(tx),
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query: (text, params) => pool.query(text, params),
    withTransaction,
  };
}

type Migration = {
  id: number;
  name: string;
  sql: string;
};

export const databaseMigrations: Migration[] = [
  {
    id: 1,
    name: "initial-users-workspaces",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        legacy_owner_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_users_email ON users(email);

      CREATE TABLE user_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        identity_provider TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (issuer, subject)
      );
      CREATE INDEX idx_identities_user ON user_identities(user_id);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        node_id TEXT NOT NULL DEFAULT 'server',
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'server',
        root_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        repository_url TEXT,
        default_branch TEXT,
        default_checks_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        git_branch TEXT,
        git_head TEXT,
        git_dirty INTEGER,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );
      CREATE INDEX idx_workspaces_owner ON workspaces(owner_id, status);
    `,
  },
  {
    id: 2,
    name: "workspace-dirty-files",
    sql: `
      ALTER TABLE workspaces ADD COLUMN git_dirty_files_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 3,
    name: "runs-events-agents-checks-findings-checkpoints-jobs",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        state TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        document_json TEXT NOT NULL
      );
      CREATE INDEX idx_runs_owner ON runs(owner_id, updated_at);
      CREATE INDEX idx_runs_state ON runs(state, updated_at);

      CREATE TABLE run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        meta_json TEXT,
        delivery_id TEXT,
        PRIMARY KEY (run_id, seq)
      );
      CREATE UNIQUE INDEX idx_run_events_delivery ON run_events(run_id, delivery_id);
      CREATE INDEX idx_run_events_at ON run_events(run_id, seq);

      CREATE TABLE run_agents (
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        branch TEXT,
        summary TEXT,
        duration_ms INTEGER,
        PRIMARY KEY (run_id, agent_id)
      );

      CREATE TABLE run_checks (
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        PRIMARY KEY (run_id, check_id)
      );

      CREATE TABLE run_findings (
        run_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        file TEXT,
        line INTEGER,
        title TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, finding_id)
      );

      CREATE TABLE run_artifacts (
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, artifact_id)
      );

      CREATE TABLE run_checkpoints (
        run_id TEXT NOT NULL,
        stage_key TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT,
        idempotency_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, stage_key)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        worker_id TEXT,
        claimed_at TEXT,
        heartbeat_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_state ON jobs(state, updated_at);
      CREATE INDEX idx_jobs_run ON jobs(run_id, created_at);
    `,
  },
  {
    id: 4,
    name: "run-usage-per-role",
    sql: `
      CREATE TABLE run_usage_role (
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, role, model)
      );
    `,
  },
  {
    id: 5,
    name: "finding-observations-and-deliveries",
    sql: `
      ALTER TABLE run_findings ADD COLUMN fingerprint TEXT;
      ALTER TABLE run_findings ADD COLUMN first_seen_round INTEGER;
      ALTER TABLE run_findings ADD COLUMN last_seen_round INTEGER;
      ALTER TABLE run_findings ADD COLUMN observations INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE run_findings ADD COLUMN consecutive_rounds INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE jobs ADD COLUMN started_at TEXT;

      CREATE TABLE run_deliveries (
        run_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        seq INTEGER,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (run_id, delivery_id)
      );

      CREATE TABLE workspace_grants (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        granted_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE UNIQUE INDEX idx_workspaces_canonical ON workspaces(canonical_path);
    `,
  },
  {
    id: 6,
    name: "artifact-content-and-check-exit-code",
    sql: `
      ALTER TABLE run_artifacts ADD COLUMN content TEXT;
      ALTER TABLE run_artifacts ADD COLUMN base_sha TEXT;
      ALTER TABLE run_checks ADD COLUMN exit_code INTEGER;
    `,
  },
];

export async function runMigrations(db: Db) {
  // EXISTS-check via information_schema first: pg-mem cannot re-run
  // CREATE TABLE IF NOT EXISTS when the table already exists.
  const hasMigrationsTable = (await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations'",
  )).rows.length > 0;
  if (!hasMigrationsTable) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }
  const applied = new Set(
    (await db.query("SELECT id FROM schema_migrations")).rows.map((row) => Number(row.id)),
  );
  for (const migration of databaseMigrations) {
    if (applied.has(migration.id)) continue;
    await db.withTransaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)", [
        migration.id,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
