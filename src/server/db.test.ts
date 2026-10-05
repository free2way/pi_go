import { describe, expect, it } from "vitest";
import { backfillFindingStableKeys, databaseMigrations, newId, runMigrations } from "./db.js";
import { createTestDb } from "./test-db.js";

describe("database", () => {
  it("applies migrations exactly once", async () => {
    const db = await createTestDb();
    const applied = (await db.query("SELECT id FROM schema_migrations ORDER BY id")).rows.map((row) => Number(row.id));
    expect(applied).toEqual(databaseMigrations.map((migration) => migration.id));

    await db.query("SELECT COUNT(*) FROM users");
    await db.query("SELECT COUNT(*) FROM user_identities");
    await db.query("SELECT COUNT(*) FROM workspaces");

    await runMigrations(db);
    const count = (await db.query("SELECT COUNT(*)::int AS count FROM schema_migrations")).rows[0] as { count: number };
    expect(Number(count.count)).toBe(databaseMigrations.length);
  });

  it("generates prefixed ids", () => {
    expect(newId("ws")).toMatch(/^ws_[a-f0-9]{20}$/);
    expect(newId("ws")).not.toBe(newId("ws"));
  });

  it("adds run_findings.stable_key and back-fills legacy NULL rows", async () => {
    const db = await createTestDb();
    await db.query(
      "INSERT INTO run_findings (run_id, finding_id, severity, file, line, title, resolved, stable_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      ["run_legacy", "F1", "high", "./src/Auth/Session.ts", 3, "-  Refresh  Race. ", 0, null],
    );
    const updated = await backfillFindingStableKeys(db);
    expect(updated).toBe(1);
    const row = (await db.query("SELECT stable_key FROM run_findings WHERE run_id = 'run_legacy'")).rows[0];
    expect(String(row.stable_key)).toBe("src/auth/session.ts|refresh race");
    // Idempotent: nothing left to back-fill.
    expect(await backfillFindingStableKeys(db)).toBe(0);
  });
});
