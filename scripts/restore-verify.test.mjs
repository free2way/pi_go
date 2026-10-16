import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/docker/restore-verify.sh", import.meta.url));
const counts = { users: 1, identities: 1, workspaces: 1, runs: 1, events: 2,
  agents: 1, checks: 1, findings: 0, artifacts: 0, checkpoints: 1, jobs: 1, digest: "a".repeat(32) };
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pigo-restore-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backup = join(root, "backup with 'quotes");
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  mkdirSync(backup);
  mkdirSync(bin);
  const dump = "dummy-backup-content";
  const manifest = { database: counts, databaseDumpSha256: hash(dump), credentialsSha256: "none" };
  writeFileSync(join(backup, "database.dump"), dump);
  const saveManifest = () => writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
  saveManifest();
  writeFileSync(log, "");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RESTORE_TEST_LOG, JSON.stringify(args)+'\\n');
const sql = args.at(-1);
const mode = process.env.RESTORE_TEST_MODE;
if (sql.startsWith('CREATE DATABASE') && mode === 'exists') process.exit(3);
if (args.includes('pg_restore') && mode === 'restore-error') process.exit(4);
if (sql.startsWith('select json_build_object')) {
  if (mode === 'query-error') process.exit(5);
  const counts = JSON.parse(process.env.RESTORE_TEST_COUNTS);
  if (mode === 'mismatch') counts.jobs += 1;
  process.stdout.write(JSON.stringify(counts));
}
if (sql.startsWith('DROP DATABASE') && mode === 'cleanup-error') process.exit(6);
`, { mode: 0o755 });
  const run = (extra = {}) => {
    const result = spawnSync("bash", [script, backup], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_RESTORE_DB: "pigo_restore_verify_test",
      PI_PG_DB: "pigo", PI_PG_USER: "pigo", RESTORE_TEST_LOG: log,
      RESTORE_TEST_COUNTS: JSON.stringify(counts), ...extra,
    } });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls, output: result.stdout + result.stderr };
  };
  return { backup, manifest, saveManifest, run };
}

test("restore succeeds only in its newly created scratch database, including quoted backup paths", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /RESTORE VERIFIED OK/);
  assert.equal(result.calls[0].at(-1), 'CREATE DATABASE "pigo_restore_verify_test" OWNER "pigo"');
  assert.equal(result.calls.at(-1).at(-1), 'DROP DATABASE "pigo_restore_verify_test"');
  assert.ok(result.calls.filter((args) => args.includes("psql")).every((args) => args.includes("ON_ERROR_STOP=1") && args.includes("-X")));
  assert.ok(result.calls.every((args) => !/WITH \(FORCE\)|DROP DATABASE IF EXISTS/.test(args.at(-1))));
});

for (const name of ["pigo", "postgres", "template1", "pigo_restore_verify;DROP DATABASE pigo", "pigo_restore_verify_" + "x".repeat(64)]) {
  test(`restore rejects unsafe scratch name ${name.slice(0, 30)} before Docker`, (t) => {
    const result = fixture(t).run({ PI_RESTORE_DB: name });
    assert.equal(result.status, 2);
    assert.equal(result.calls.length, 0);
  });
}

test("restore refuses source/scratch equality and SQL-bearing roles before Docker", (t) => {
  const { run } = fixture(t);
  for (const env of [{ PI_PG_DB: "pigo_restore_verify_test" }, { PI_PG_USER: 'pigo";DROP DATABASE pigo' }]) {
    const result = run(env);
    assert.equal(result.status, 2);
    assert.equal(result.calls.length, 0);
  }
});

test("existing scratch is never dropped, reused or force-disconnected", (t) => {
  const result = fixture(t).run({ RESTORE_TEST_MODE: "exists" });
  assert.equal(result.status, 3);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].at(-1), /^CREATE DATABASE/);
});

for (const [mode, code] of [["restore-error", 4], ["query-error", 5], ["mismatch", 1]]) {
  test(`${mode} fails and cleans only the database created by this invocation`, (t) => {
    const result = fixture(t).run({ RESTORE_TEST_MODE: mode });
    assert.equal(result.status, code, result.output);
    assert.equal(result.calls.at(-1).at(-1), 'DROP DATABASE "pigo_restore_verify_test"');
    assert.doesNotMatch(result.output, /RESTORE VERIFIED OK/);
  });
}

test("cleanup failure must not report a successful drill", (t) => {
  const result = fixture(t).run({ RESTORE_TEST_MODE: "cleanup-error" });
  assert.equal(result.status, 1);
  assert.match(result.output, /retained for operator inspection/);
  assert.doesNotMatch(result.output, /RESTORE VERIFIED OK/);
});

test("tampered dump is rejected before creating any database", (t) => {
  const { backup, run } = fixture(t);
  writeFileSync(join(backup, "database.dump"), "tampered");
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
});

test("missing credential ciphertext fails closed instead of silently skipping", (t) => {
  const { manifest, saveManifest, run } = fixture(t);
  manifest.credentialsSha256 = "b".repeat(64);
  saveManifest();
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
});

test("valid credential ciphertext is verified without printing its content", (t) => {
  const { backup, manifest, saveManifest, run } = fixture(t);
  const ciphertext = JSON.stringify({ version: 2, users: {}, marker: "dummy-private-ciphertext" });
  writeFileSync(join(backup, "credentials.vault.json"), ciphertext);
  manifest.credentialsSha256 = hash(ciphertext);
  saveManifest();
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no decryption performed/);
  assert.doesNotMatch(result.output, /dummy-private-ciphertext/);
});

test("incomplete database evidence is rejected before Docker", (t) => {
  const { manifest, saveManifest, run } = fixture(t);
  manifest.database = { runs: 1 };
  saveManifest();
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
});
