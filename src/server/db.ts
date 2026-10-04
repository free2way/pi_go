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
