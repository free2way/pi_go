import { newDb } from "pg-mem";
import { createDb, runMigrations, type Db, type PoolLike } from "./db.js";

/** In-memory PostgreSQL (pg-mem) with the production schema applied. */
export async function createTestDb(): Promise<Db> {
  const memory = newDb();
  const { Pool: MemoryPool } = memory.adapters.createPg();
  const db = createDb(new MemoryPool() as unknown as PoolLike);
  await runMigrations(db);
  return db;
}
