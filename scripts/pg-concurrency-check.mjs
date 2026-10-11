#!/usr/bin/env node
/**
 * NEW-05 real-PostgreSQL concurrency check.
 *
 * The server's own unit tests run against pg-mem, which accepts `SELECT ... FOR
 * UPDATE` but does NOT enforce row locking. That means the pg-mem suite can only
 * prove the revision compare-and-swap on its own — it cannot prove that two web
 * instances (rolling deploy) actually serialize on the row lock. This script
 * runs the same store against a REAL PostgreSQL and asserts both halves of the
 * guarantee:
 *
 *   1. Two `PostgresRunStore` instances (independent caches, one pool) race the
 *      way two web processes would: instance A commits `cancelled`, instance B
 *      applies a stale patch and a stale `state: reviewing` patch. The row must
 *      stay `cancelled`, receive only the stale non-state field, bump `revision`
 *      exactly once per accepted write, never rewind `last_seq`, and treat a
 *      replayed delivery id as a no-op.
 *   2. A real `SELECT ... FOR UPDATE` row lock genuinely blocks a second writer
 *      (observed via `pg_stat_activity.wait_event_type = 'Lock'`) until the
 *      holder commits — the behavior pg-mem cannot provide.
 *
 * HOW TO RUN
 *   npm run build                       # emits dist/server/run-store-pg.js
 *   PI_DATABASE_URL=postgres://user:pass@host:5432/db npm run test:pg:concurrency
 *
 *   `DATABASE_URL` is accepted as a fallback. The target database name is
 *   printed; the password never is.
 *
 * RUNNING INSIDE A DEPLOYED WEB CONTAINER
 *   This file has no build step of its own, so it can be copied next to the
 *   built server and executed in the running image, e.g.:
 *     docker cp scripts/pg-concurrency-check.mjs <container>:/app/scripts/
 *     docker exec <container> node /app/scripts/pg-concurrency-check.mjs
 *   (`/app/dist/server/run-store-pg.js` already exists in the image because the
 *   Dockerfile copies the whole `dist/` directory.)
 *
 * The script creates rows only under a unique `run_pgcheck_<random>` id / owner
 * and deletes them in `finally`. It exits 0 when every assertion passes and 1
 * otherwise. Do not run it against a production database you cannot clean up.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.PI_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "[pg-concurrency-check] Missing connection string. Set PI_DATABASE_URL (or DATABASE_URL) to a real PostgreSQL URL.",
  );
  process.exit(1);
}

// Print the database we are about to touch, but never the credentials.
try {
  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.replace(/^\//, "") || "(unknown)";
  console.log(`[pg-concurrency-check] target database: ${database} @ ${parsed.host}`);
} catch {
  console.log("[pg-concurrency-check] target database: (unparseable connection string)");
}

// The store and migration runner are imported from the BUILT output, exactly as
// the deployed server loads them. `npm run build` must have run first. Running
// the real production migrations here is important: CI starts with a clean
// PostgreSQL database, while deployed databases already have these tables.
const storeModuleUrl = new URL("../dist/server/run-store-pg.js", import.meta.url);
const dbModuleUrl = new URL("../dist/server/db.js", import.meta.url);
let PostgresRunStore;
let createDb;
let runMigrations;
try {
  ({ PostgresRunStore } = await import(storeModuleUrl.href));
  ({ createDb, runMigrations } = await import(dbModuleUrl.href));
} catch (error) {
  console.error("[pg-concurrency-check] Could not load the built store and migration runner from dist/server.");
  console.error("  Run `npm run build` first so dist/ is up to date.");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10_000 });
const db = createDb(pool);

const runId = `run_pgcheck_${randomBytes(8).toString("hex")}`;
const ownerId = `owner_pgcheck_${randomBytes(8).toString("hex")}`;
const deliveryId = `del_pgcheck_${randomBytes(8).toString("hex")}`;
const staleDeliveryId = `del_pgcheck_stale_${randomBytes(8).toString("hex")}`;

const results = [];
function assert(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

function now() {
  return new Date().toISOString();
}

function makeRun(state, lastSeq) {
  const timestamp = now();
  return {
    id: runId,
    ownerId,
    title: "pg concurrency check",
    task: "prove NEW-05 store guarantees on real PostgreSQL",
    repository: "/tmp/pigo-pg-concurrency-check",
    branch: "pigo/pg-concurrency-check",
    mode: "real",
    state,
    round: 1,
    maxRounds: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    developer: { provider: "deepseek", model: "deepseek-chat" },
    reviewer: { provider: "deepseek", model: "deepseek-chat" },
    checks: [],
    findings: [],
    diff: "",
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq,
  };
}

async function readRow() {
  const row = (
    await pool.query("SELECT state, last_seq, revision, document_json FROM runs WHERE id = $1", [runId])
  ).rows[0];
  if (!row) return undefined;
  return {
    state: String(row.state),
    lastSeq: Number(row.last_seq),
    revision: Number(row.revision),
    document: JSON.parse(String(row.document_json)),
  };
}

async function cleanup() {
  const tables = [
    "run_events",
    "run_deliveries",
    "run_artifacts",
    "run_checks",
    "run_findings",
    "run_agents",
    "run_checkpoints",
    "run_usage_role",
    "jobs",
  ];
  for (const table of tables) {
    // Fixed table names (not user input); the run id is always parameterized.
    await pool.query(`DELETE FROM ${table} WHERE run_id = $1`, [runId]).catch(() => undefined);
  }
  await pool.query("DELETE FROM runs WHERE id = $1", [runId]).catch(() => undefined);
}

function printReport() {
  const passed = results.filter((entry) => entry.pass).length;
  console.log("");
  console.log("  #    result  assertion");
  console.log("  ---- ------  ---------");
  for (const [index, entry] of results.entries()) {
    const label = `${String(index + 1).padStart(2, " ")}   ${entry.pass ? "PASS" : "FAIL"}    ${entry.name}${
      entry.detail ? `  [${entry.detail}]` : ""
    }`;
    console.log(`  ${label}`);
  }
  console.log("");
  console.log(
    `[pg-concurrency-check] ${passed}/${results.length} assertions passed — ${passed === results.length ? "PASS" : "FAIL"}`,
  );
  return passed === results.length;
}

let holder;
let exitCode = 1;
try {
  // ---------------------------------------------------------------- setup
  await runMigrations(db);
  console.log("[pg-concurrency-check] production schema ready");
  const storeA = new PostgresRunStore(db);
  const storeB = new PostgresRunStore(db);

  // A fresh run starts in `reviewing` so `reviewing -> cancelled` is legal for A
  // and `cancelled -> reviewing` is an illegal transition for B's stale patch.
  await storeA.createRun(makeRun("reviewing", 0), {
    runId,
    round: 1,
    source: "system",
    type: "check.started",
    message: "pg concurrency check",
    at: now(),
  });
  // Both instances hydrate the same run — the two-web-process situation.
  await storeA.hydrate(runId);
  await storeB.hydrate(runId);

  const initial = await readRow();
  assert("setup: temp run created in reviewing", initial?.state === "reviewing", `state=${initial?.state}`);

  // ------------------------------------------- 1. instance A cancels the run
  await storeA.updateRun(runId, { state: "cancelled" });
  const afterA = await readRow();
  assert("A commits cancelled", afterA?.state === "cancelled", `state=${afterA?.state}`);
  assert("A cancel increments revision once", afterA?.revision === 1, `revision=${afterA?.revision}`);

  // ---------------------- 2. instance B applies a stale non-state patch
  // B's cache still says `reviewing`; the patch must be merged onto the
  // authoritative (locked, cancelled) row, not onto B's stale cache.
  await storeB.updateRun(runId, { modelCalls: 7 });
  const afterStalePatch = await readRow();
  assert(
    "stale non-state patch keeps cancelled state",
    afterStalePatch?.state === "cancelled",
    `state=${afterStalePatch?.state}`,
  );
  assert("stale non-state patch still applies its fields", afterStalePatch?.document.modelCalls === 7);
  assert("accepted stale patch increments revision", afterStalePatch?.revision === 2, `revision=${afterStalePatch?.revision}`);

  // ---------------------- 3. instance B attempts a stale terminal-state write
  let transitionRejected = false;
  let transitionError = "";
  try {
    await storeB.updateRun(runId, { state: "reviewing" });
  } catch (error) {
    transitionRejected = true;
    transitionError = error instanceof Error ? error.name : String(error);
  }
  const afterRejected = await readRow();
  assert("stale state=reviewing patch is rejected", transitionRejected, transitionError);
  assert("rejected patch leaves state cancelled", afterRejected?.state === "cancelled", `state=${afterRejected?.state}`);
  assert("rejected patch leaves revision unchanged", afterRejected?.revision === 2, `revision=${afterRejected?.revision}`);

  // The same rejection must hold through the delivery path (atomic patch+event).
  let deliveryRejected = false;
  try {
    await storeB.applyDelivery({ runId, deliveryId: staleDeliveryId, patch: { state: "reviewing" } });
  } catch {
    deliveryRejected = true;
  }
  const afterDeliveryRejected = await readRow();
  assert("stale delivery patch is rejected too", deliveryRejected);
  assert("rejected delivery leaves state cancelled", afterDeliveryRejected?.state === "cancelled");

  // ------------------------------------------- 4. last_seq can only move forward
  const seqBefore = (await readRow())?.lastSeq ?? 0;
  await storeA.appendEvent({
    runId,
    round: 1,
    source: "system",
    type: "check.tick",
    message: "bump",
    at: now(),
  });
  const seqBumped = (await readRow())?.lastSeq ?? 0;
  await storeB.updateRun(runId, { lastSeq: 0 });
  const seqAfterStale = (await readRow())?.lastSeq ?? 0;
  assert("appending an event advances last_seq", seqBumped > seqBefore, `before=${seqBefore} after=${seqBumped}`);
  assert(
    "stale lastSeq patch cannot rewind last_seq",
    seqAfterStale >= seqBumped,
    `expected>=${seqBumped} got=${seqAfterStale}`,
  );

  // ------------------------------------------- 5. replayed delivery is a no-op
  const firstDelivery = await storeB.applyDelivery({ runId, deliveryId, patch: { modelCalls: 9 } });
  const revisionAfterFirst = (await readRow())?.revision;
  const replayedDelivery = await storeB.applyDelivery({ runId, deliveryId, patch: { modelCalls: 99 } });
  const afterReplay = await readRow();
  assert("first delivery is applied", firstDelivery.applied === true);
  assert("replayed delivery reports not applied", replayedDelivery.applied === false);
  assert("replayed delivery does not re-apply its patch", afterReplay?.document.modelCalls === 9);
  assert("replayed delivery does not increment revision", afterReplay?.revision === revisionAfterFirst);

  // ------------------------------------------- 6. real SELECT ... FOR UPDATE blocks
  // Hold the row lock in one session and start a store write from another pool
  // client. The write must block (its `FOR UPDATE` waits on the lock) until the
  // holder commits — this is the guarantee pg-mem cannot enforce.
  holder = await pool.connect();
  let lockObserved = false;
  let lockDetail = "";
  let writer;
  await holder.query("BEGIN");
  try {
    const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await holder.query("SELECT state, last_seq, revision, document_json FROM runs WHERE id = $1 FOR UPDATE", [runId]);

    const storeC = new PostgresRunStore(db);
    writer = storeC.updateRun(runId, { modelCalls: 11 });

    // Poll pg_stat_activity until the second backend is provably blocked. Same
    // role as the holder, so the query text is visible; filter by wait state and
    // the FOR UPDATE statement to stay deterministic (no fixed sleep guessing).
    const deadline = Date.now() + 5_000;
    try {
      while (Date.now() < deadline) {
        const waiting = (
          await pool.query(
            `SELECT pid FROM pg_stat_activity
               WHERE datname = current_database()
                 AND pid <> $1
                 AND wait_event_type = 'Lock'
                 AND query ILIKE '%FOR UPDATE%'
               LIMIT 1`,
            [holderPid],
          )
        ).rows[0];
        if (waiting) {
          lockObserved = true;
          break;
        }
        await delay(50);
      }
    } catch (error) {
      // pg_stat_activity visibility can be restricted; fall back to asserting
      // the write has not resolved while the lock is held.
      lockDetail = `stat fallback: ${error instanceof Error ? error.message : String(error)}`;
      const outcome = await Promise.race([writer.then(() => "done"), delay(300).then(() => "waiting")]);
      lockObserved = outcome === "waiting";
    }
    assert("second writer blocks on real SELECT ... FOR UPDATE", lockObserved, lockDetail);
  } finally {
    await holder.query("COMMIT").catch(() => undefined);
    holder.release();
    holder = undefined;
  }
  await writer;
  const afterLock = await readRow();
  assert("blocked writer proceeds after the lock is released", afterLock?.document.modelCalls === 11);
} catch (error) {
  console.error("[pg-concurrency-check] Unexpected error:", error);
  assert("script completed without an unexpected error", false, error instanceof Error ? error.message : String(error));
} finally {
  if (holder) holder.release();
  await cleanup();
  exitCode = printReport() ? 0 : 1;
  await pool.end().catch(() => undefined);
}

process.exit(exitCode);
