import { describe, expect, it } from "vitest";
import { databaseMigrations, newId, runMigrations } from "./db.js";
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
});
