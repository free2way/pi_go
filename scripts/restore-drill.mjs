#!/usr/bin/env node
// Exercise the operator restore script against a disposable PostgreSQL service.
// No live backup, credential or existing application database is read or changed.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const container = process.env.PI_RESTORE_DRILL_CONTAINER;
const user = process.env.PI_RESTORE_DRILL_PG_USER;
if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)
  || !user || !/^[a-z_][a-z0-9_]{0,62}$/.test(user)) {
  console.error("Set PI_RESTORE_DRILL_CONTAINER and PI_RESTORE_DRILL_PG_USER to an explicitly disposable PostgreSQL service.");
  process.exit(2);
}

const suffix = randomBytes(8).toString("hex");
const source = `pigo_restore_fixture_${suffix}`;
const scratch = `pigo_restore_verify_${suffix}`;
const backup = mkdtempSync(join(tmpdir(), "pigo-restore-drill-"));
const script = fileURLToPath(new URL("../deploy/docker/restore-verify.sh", import.meta.url));
const owned = new Set();
const docker = (args) => execFileSync("docker", ["exec", container, ...args], { maxBuffer: 16 * 1024 * 1024 });
const sql = (database, statement) => docker(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-tAc", statement]).toString().trim();
const create = (name) => {
  sql("postgres", `CREATE DATABASE "${name}" OWNER "${user}"`);
  owned.add(name);
};
const exists = (name) => sql("postgres", `SELECT count(*) FROM pg_database WHERE datname='${name}'`) === "1";
const restore = (name = scratch) => spawnSync("bash", [script, backup], {
  encoding: "utf8", timeout: 60_000, env: {
    ...process.env, PI_PG_CONTAINER: container, PI_PG_USER: user,
    PI_PG_DB: source, PI_RESTORE_DB: name,
  },
});

try {
  create(source);
  const tables = { users: "users", identities: "user_identities", workspaces: "workspaces",
    events: "run_events", agents: "run_agents", checks: "run_checks", findings: "run_findings",
    artifacts: "run_artifacts", checkpoints: "run_checkpoints", jobs: "jobs" };
  for (const table of Object.values(tables)) {
    sql(source, `CREATE TABLE ${table}(id text PRIMARY KEY); INSERT INTO ${table} VALUES ('fixture-1')`);
  }
  sql(source, "CREATE TABLE runs(id text PRIMARY KEY, last_seq integer, document_json text); INSERT INTO runs VALUES ('run-fixture',7,'{}')");
  const database = Object.fromEntries(Object.keys(tables).map((key) => [key, 1]));
  database.runs = 1;
  database.digest = sql(source, "SELECT md5(string_agg(id || ':' || last_seq || ':' || md5(document_json), ',' order by id)) FROM runs");
  const dump = docker(["pg_dump", "-U", user, "-Fc", source]);
  writeFileSync(join(backup, "database.dump"), dump, { mode: 0o600 });
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({ database,
    databaseDumpSha256: createHash("sha256").update(dump).digest("hex"), credentialsSha256: "none" }), { mode: 0o600 });

  let result = restore();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESTORE VERIFIED OK/);
  assert.equal(exists(scratch), false, "successful restore must clean its scratch database");
  console.log("PASS: real pg_dump → pg_restore → counts/digest verification → scratch cleanup");

  create(scratch);
  sql(scratch, "CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('preserve-existing')");
  result = restore();
  assert.notEqual(result.status, 0, "existing database must be refused");
  assert.equal(sql(scratch, "SELECT value FROM sentinel"), "preserve-existing");
  console.log("PASS: existing scratch database and sentinel preserved on collision");

  // A genuine pg_restore error after creation must also clean its own database.
  const brokenName = `pigo_restore_verify_broken_${suffix}`;
  const broken = Buffer.from("deliberately-invalid-dump");
  writeFileSync(join(backup, "database.dump"), broken);
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({ database,
    databaseDumpSha256: createHash("sha256").update(broken).digest("hex"), credentialsSha256: "none" }));
  result = restore(brokenName);
  assert.notEqual(result.status, 0);
  assert.equal(exists(brokenName), false, "failed restore must clean its scratch database");
  assert.equal(sql(scratch, "SELECT value FROM sentinel"), "preserve-existing");
  console.log("PASS: failed pg_restore cleans only its new database, preserving existing databases");
} finally {
  // The set contains only databases successfully CREATEd by this harness.
  let cleanupFailed = false;
  for (const name of owned) {
    try { sql("postgres", `DROP DATABASE "${name}"`); }
    catch { cleanupFailed = true; console.error(`Fixture cleanup failed: ${name}`); }
  }
  rmSync(backup, { recursive: true, force: true });
  if (cleanupFailed) process.exitCode = 1;
}
