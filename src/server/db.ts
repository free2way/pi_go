import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// esbuild (tsup) strips the `node:` prefix from unknown builtins such as
// `node:sqlite`, which breaks the bundle. Resolve it at runtime instead.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type Database = DatabaseSync;

type Migration = {
  id: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
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
];

export function openDatabase(filePath: string): Database {
  if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new SqliteDatabase(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((row) => Number(row.id)),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function closeDatabase(db: Database) {
  try {
    db.close();
  } catch {
    // already closed
  }
}

export const databaseMigrations = migrations;
