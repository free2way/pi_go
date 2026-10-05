import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { findingFingerprint } from "../shared/finding-fingerprint.js";

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
  {
    // NEW-05: monotonic per-run revision used as the compare-and-swap guard for
    // updateRun/applyDelivery, so a stale multi-instance cache cannot clobber a
    // newer committed state.
    id: 7,
    name: "runs-revision",
    sql: `
      ALTER TABLE runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // B4: separate "can view/run" from "can modify" for shared workspaces.
    // Existing rows default to `read` so a previously granted user cannot keep
    // changing the owner's default checks or unregister the workspace.
    id: 8,
    name: "workspace-grant-permission",
    sql: `
      ALTER TABLE workspace_grants ADD COLUMN permission TEXT NOT NULL DEFAULT 'read';
    `,
  },
  {
    // Sprint 3 batch 1: agile domain (projects → stories/sprints/releases) on
    // top of the existing Run, which stays the execution unit. One story can
    // accumulate several runs (repairs/retries) through `story_runs`.
    id: 9,
    name: "agile-projects-stories-sprints-releases-story-runs",
    sql: `
      CREATE TABLE agile_projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        project_key TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, project_key)
      );
      CREATE INDEX idx_agile_projects_owner ON agile_projects(owner_id, updated_at);

      CREATE TABLE agile_sprints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES agile_projects(id),
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agile_sprints_project ON agile_sprints(project_id, updated_at);

      CREATE TABLE agile_stories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES agile_projects(id),
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        priority TEXT NOT NULL DEFAULT 'should',
        estimate INTEGER,
        definition_of_done_json TEXT NOT NULL DEFAULT '[]',
        developer_model_json TEXT,
        reviewer_model_json TEXT,
        budget_json TEXT,
        max_parallel INTEGER,
        sprint_id TEXT,
        workspace_id TEXT,
        status TEXT NOT NULL DEFAULT 'backlog',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agile_stories_project ON agile_stories(project_id, updated_at);
      CREATE INDEX idx_agile_stories_sprint ON agile_stories(sprint_id);

      CREATE TABLE agile_releases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES agile_projects(id),
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        story_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agile_releases_project ON agile_releases(project_id, updated_at);

      CREATE TABLE story_runs (
        story_id TEXT NOT NULL REFERENCES agile_stories(id),
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (story_id, run_id)
      );
      CREATE INDEX idx_story_runs_run ON story_runs(run_id);
    `,
  },
  {
    // 账户管理: durable audit trail for account role/status changes. There was no
    // existing audit table (alerts are in-memory), so role/status PATCHes append
    // a row here with actor + target + before/after.
    id: 10,
    name: "user-audit",
    sql: `
      CREATE TABLE user_audit (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field TEXT NOT NULL,
        before_value TEXT,
        after_value TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_audit_target ON user_audit(target_user_id, created_at);
      CREATE INDEX idx_user_audit_actor ON user_audit(actor_id, created_at);
    `,
  },
  {
    // Sprint 4: lightweight, owner-scoped saved model combinations. Additive;
    // no data is seeded and existing rows are untouched.
    id: 11,
    name: "model-templates",
    sql: `
      CREATE TABLE model_templates (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        developer_model_json TEXT NOT NULL,
        reviewer_model_json TEXT NOT NULL,
        budget_json TEXT,
        max_parallel INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );
      CREATE INDEX idx_model_templates_owner ON model_templates(owner_id, updated_at);
    `,
  },
  {
    // Kanban blocked-management + release publish action (Sprint 5, additive).
    // `blocked_reason/at/by` hold the *manual* block; `status_before_block`
    // preserves the pre-block planning status so unblocking restores it when no
    // run is linked. `released_at/by` + `deploy_json` record an explicit publish
    // and its deploy-hook outcome; `agile_release_audit` is the append-only trail.
    id: 12,
    name: "story-manual-block-and-release-publish",
    sql: `
      ALTER TABLE agile_stories ADD COLUMN blocked_reason TEXT;
      ALTER TABLE agile_stories ADD COLUMN blocked_at TEXT;
      ALTER TABLE agile_stories ADD COLUMN blocked_by TEXT;
      ALTER TABLE agile_stories ADD COLUMN status_before_block TEXT;

      ALTER TABLE agile_releases ADD COLUMN released_at TEXT;
      ALTER TABLE agile_releases ADD COLUMN released_by TEXT;
      ALTER TABLE agile_releases ADD COLUMN deploy_json TEXT;

      CREATE TABLE agile_release_audit (
        id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL REFERENCES agile_releases(id),
        owner_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL,
        deploy_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_agile_release_audit_release ON agile_release_audit(release_id, created_at);
    `,
  },
  {
    // Incident run_e7c565d6335a4bc7: cross-round finding identity must not depend
    // on the model-provided id. `stable_key` is the content fingerprint
    // (`<normalized file>|<normalized title>`, see src/shared/finding-fingerprint)
    // so a reworded/re-id'd repeat is recognised as the SAME finding.
    //
    // Legacy rows are back-filled in JS after the migration (`findings` come from
    // the run document, and pg-mem — used by the tests — supports neither
    // `trim`/`btrim` nor `regexp_replace`, so a faithful SQL normalization is not
    // portable). A NULL key is always valid and is recomputed on read.
    id: 13,
    name: "finding-stable-key",
    sql: `
      ALTER TABLE run_findings ADD COLUMN stable_key TEXT;
      CREATE INDEX idx_run_findings_stable ON run_findings(run_id, stable_key);
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
  await backfillFindingStableKeys(db);
}

/**
 * Best-effort back-fill of `run_findings.stable_key` for legacy rows written
 * before the content fingerprint existed. Rows that already carry a key are left
 * untouched, and a row whose key cannot be derived (empty title/file) still gets
 * a deterministic placeholder key. Idempotent: only NULL keys are updated.
 */
export async function backfillFindingStableKeys(db: Db) {
  const rows = (
    await db.query("SELECT run_id, finding_id, file, title FROM run_findings WHERE stable_key IS NULL")
  ).rows as Array<{ run_id: string; finding_id: string; file: string | null; title: string | null }>;
  for (const row of rows) {
    await db.query("UPDATE run_findings SET stable_key = $1 WHERE run_id = $2 AND finding_id = $3", [
      findingFingerprint({ file: row.file, title: row.title }),
      row.run_id,
      row.finding_id,
    ]);
  }
  return rows.length;
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
