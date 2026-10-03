import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseMigrations, newId, openDatabase } from "./db.js";

describe("database", () => {
  it("applies migrations exactly once", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-db-"));
    const file = path.join(directory, "pigo.db");

    const first = openDatabase(file);
    const appliedRows = first.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>;
    expect(appliedRows.map((row) => Number(row.id))).toEqual(databaseMigrations.map((migration) => migration.id));
    const tables = (first.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["users", "user_identities", "workspaces", "schema_migrations"]));
    first.close();

    const second = openDatabase(file);
    const count = second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    expect(Number(count.count)).toBe(databaseMigrations.length);
    second.close();
  });

  it("generates prefixed ids", () => {
    expect(newId("ws")).toMatch(/^ws_[a-f0-9]{20}$/);
    expect(newId("ws")).not.toBe(newId("ws"));
  });
});
