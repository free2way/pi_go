import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, linkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/docker/backup-retention.py", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const today = "2026-10-29";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pigo-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = id => {
    const dir = join(root, id); mkdirSync(dir, { mode: 0o700 });
    const data = { "database.dump": "DUMMY_DUMP_" + id, "compose.yaml": "services: {}\n", "credentials.vault.json": "{}" };
    data["manifest.json"] = JSON.stringify({ createdAt: id, database: {}, databaseDumpSha256: hash(data["database.dump"]), credentialsSha256: hash(data["credentials.vault.json"]) });
    for (const [name, value] of Object.entries(data)) writeFileSync(join(dir, name), value, { mode: 0o600 });
    return dir;
  };
  const prove = id => {
    const dir = join(root, id), files = Object.fromEntries(readdirSync(dir).filter(n => n !== "restore-verification.json").map(n => [n, hash(readFileSync(join(dir, n)))]));
    writeFileSync(join(dir, "restore-verification.json"), JSON.stringify({ schemaVersion: 1, result: "verified", scope: "database-stats-and-vault-integrity", verifiedAt: today + "T00:00:00Z", files }), { mode: 0o600 });
  };
  const run = (...args) => {
    const p = spawnSync("python3", [script, root, "--now", today, ...args], { encoding: "utf8" });
    return { ...p, value: p.stdout.trim() ? JSON.parse(p.stdout) : undefined };
  };
  return { root, add, prove, run };
}

test("calendar day/week/month buckets span year, month and leap-day boundaries", t => {
  const f = fixture(t);
  const ids = ["20260731T000000Z", "20260801T000000Z", "20260831T000000Z", "20260901T000000Z", "20260930T000000Z", "20261001T000000Z", "20261005T000000Z", "20261012T000000Z", "20261019T000000Z", "20261023T000000Z", "20261024T000000Z", "20261025T000000Z", "20261026T000000Z", "20261027T000000Z", "20261028T000000Z", "20261029T000000Z"];
  ids.forEach(f.add); f.prove(ids.at(-1));
  const before = readdirSync(f.root);
  const p = f.run(); assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(p.value.move, ["20260731T000000Z", "20260801T000000Z", "20260901T000000Z", "20261001T000000Z", "20261019T000000Z"]);
  assert.ok(p.value.keep["20260831T000000Z"].includes("monthly"));
  assert.ok(p.value.keep["20261005T000000Z"].includes("weekly"));
  assert.equal(Object.values(p.value.keep).filter(v => v.includes("daily")).length, 7);
  assert.equal(existsSync(join(f.root, ".quarantine")), false);
  assert.deepEqual(readdirSync(f.root), before);
});

test("ISO week and month boundaries do not collapse at new year", t => {
  const f = fixture(t), ids = ["20231130T000000Z", "20231231T000000Z", "20240101T000000Z", "20240108T000000Z", "20240115T000000Z", "20240122T000000Z", "20240129T000000Z", "20240201T000000Z", "20240229T000000Z"];
  ids.forEach(f.add); f.prove(ids.at(-1));
  const proof = JSON.parse(readFileSync(join(f.root, ids.at(-1), "restore-verification.json"))); proof.verifiedAt = "2024-02-29T00:00:00Z";
  writeFileSync(join(f.root, ids.at(-1), "restore-verification.json"), JSON.stringify(proof));
  const p = f.run("--now", "2024-02-29"); assert.equal(p.status, 0, p.stderr);
  assert.ok(p.value.keep["20231231T000000Z"].includes("monthly"));
  assert.ok(p.value.keep["20240129T000000Z"].includes("monthly"));
  assert.ok(p.value.keep["20240229T000000Z"].includes("latest_verified"));
});

test("only latest backup in each daily bucket is selected; newest restore point always stays", t => {
  const f = fixture(t); ["20200101T000000Z", "20261029T000000Z", "20261029T010000Z"].forEach(f.add);f.prove("20261029T010000Z");
  const p = f.run();assert.equal(p.status, 0, p.stderr);assert.deepEqual(p.value.move, ["20200101T000000Z", "20261029T000000Z"]);
  assert.ok(p.value.keep["20261029T010000Z"].includes("latest_verified"));
});

test("explicit apply quarantines with original bytes and restore reverses it without overwrite", t => {
  const f = fixture(t); const old = f.add("20200101T000000Z"); f.add("20261029T000000Z");f.prove("20261029T000000Z");
  const original = readFileSync(join(old, "database.dump"));
  const plan = f.run();assert.equal(plan.status, 0, plan.stderr);
  assert.notEqual(f.run("--apply").status, 0);
  const applied = f.run("--apply", "--expect-plan-sha256", plan.value.planSha256);assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(old), false);const quarantined = join(f.root, ".quarantine", applied.value.transaction, "20200101T000000Z");
  assert.deepEqual(readFileSync(join(quarantined, "database.dump")), original);
  assert.equal(statSync(quarantined).mode & 0o777, 0o700);
  const restore = f.run("--restore", applied.value.transaction);assert.equal(restore.status, 0, restore.stderr);
  const done = f.run("--restore", applied.value.transaction, "--apply", "--expect-plan-sha256", restore.value.planSha256);assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(readFileSync(join(old, "database.dump")), original);
});

test("a damaged or unverified new backup never authorizes moving old restore points", t => {
  const f = fixture(t);const old = f.add("20200101T000000Z");const latest=f.add("20261029T000000Z");
  assert.notEqual(f.run().status,0);assert.ok(existsSync(old));f.prove("20261029T000000Z");
  writeFileSync(join(latest,"database.dump"),"CORRUPT");assert.notEqual(f.run().status,0);assert.ok(existsSync(old));
});

test("backup, vault and restore-evidence tampering fail closed", t => {
  const f=fixture(t);const dir=f.add("20261029T000000Z");f.prove("20261029T000000Z");
  for(const name of ["credentials.vault.json","compose.yaml","restore-verification.json"]){const original=readFileSync(join(dir,name));writeFileSync(join(dir,name),"{\"tampered\":true}");assert.notEqual(f.run().status,0,name);writeFileSync(join(dir,name),original);}
});

test("stale plan refuses changed files and newly arrived backups before payload moves", t => {
  const f=fixture(t);const old=f.add("20200101T000000Z");f.add("20261029T000000Z");f.prove("20261029T000000Z");const p=f.run();
  f.add("20261028T000000Z");const result=f.run("--apply","--expect-plan-sha256",p.value.planSha256);assert.notEqual(result.status,0);assert.ok(existsSync(old));
});

test("unknown old directories are not treated as backup payloads", t => {
  const f=fixture(t);f.add("20200101T000000Z");f.add("20261029T000000Z");f.prove("20261029T000000Z");const sentinel=join(f.root,"unrelated-directory");mkdirSync(sentinel);writeFileSync(join(sentinel,"original"),"unchanged");
  const p=f.run();const result=f.run("--apply","--expect-plan-sha256",p.value.planSha256);assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(sentinel,"original"),"utf8"),"unchanged");
});

for(const mode of ["directory-symlink","payload-symlink","hardlink","permissions","future","expired-proof"]){
  test(`unsafe ${mode} is refused without moving backups`,t=>{
    const f=fixture(t),dir=f.add("20261029T000000Z");f.prove("20261029T000000Z");
    if(mode==="directory-symlink")symlinkSync(dir,join(f.root,"20200101T000000Z"));
    if(mode==="payload-symlink"){rmSync(join(dir,"database.dump"));symlinkSync(join(dir,"compose.yaml"),join(dir,"database.dump"));}
    if(mode==="hardlink")linkSync(join(dir,"database.dump"),join(f.root,"external-link"));
    if(mode==="permissions")chmodSync(join(dir,"compose.yaml"),0o644);
    if(mode==="future")f.add("20261030T000000Z");
    if(mode==="expired-proof"){const p=JSON.parse(readFileSync(join(dir,"restore-verification.json")));p.verifiedAt="2026-10-01T00:00:00Z";writeFileSync(join(dir,"restore-verification.json"),JSON.stringify(p));}
    assert.notEqual(f.run().status,0);assert.ok(existsSync(dir));assert.equal(existsSync(join(f.root,".quarantine")),false);
  });
}

test("restore refuses changed quarantined payloads and a conflicting destination",t=>{
  const f=fixture(t);f.add("20200101T000000Z");f.add("20261029T000000Z");f.prove("20261029T000000Z");const p=f.run();const a=f.run("--apply","--expect-plan-sha256",p.value.planSha256);assert.equal(a.status,0,a.stderr);
  const file=join(f.root,".quarantine",a.value.transaction,"20200101T000000Z","database.dump"),original=readFileSync(file);writeFileSync(file,"corrupt");assert.notEqual(f.run("--restore",a.value.transaction).status,0);writeFileSync(file,original);
  f.add("20200101T000000Z");assert.notEqual(f.run("--restore",a.value.transaction).status,0);
});

test("restore recovers multiple renames even if a crash preceded journal updates", t => {
  const f=fixture(t);["20200101T000000Z","20200102T000000Z","20261029T000000Z"].forEach(f.add);f.prove("20261029T000000Z");
  const p=f.run(),a=f.run("--apply","--expect-plan-sha256",p.value.planSha256);assert.equal(a.status,0,a.stderr);
  const journal=join(f.root,".quarantine",a.value.transaction,"journal.json");
  // Keep Python's nanosecond integers exact when simulating the old journal.
  const crash=spawnSync("python3",["-c","import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['moved']=[]; open(p,'w').write(json.dumps(d))",journal],{encoding:"utf8"});assert.equal(crash.status,0,crash.stderr);
  const r=f.run("--restore",a.value.transaction);assert.equal(r.status,0,r.stderr);assert.equal(r.value.move.length,2);
  const restored=f.run("--restore",a.value.transaction,"--apply","--expect-plan-sha256",r.value.planSha256);
  assert.equal(restored.status,0,restored.stderr);
  assert.ok(existsSync(join(f.root,"20200101T000000Z")));assert.ok(existsSync(join(f.root,"20200102T000000Z")));
});

test("non-object manifest is refused without a traceback or moving payloads", t => {
  const f=fixture(t),dir=f.add("20261029T000000Z");writeFileSync(join(dir,"manifest.json"),"[]");
  const r=f.run();assert.equal(r.status,2);assert.doesNotMatch(r.stderr,/Traceback|pigo-retention-/);
  assert.equal(existsSync(join(f.root,".quarantine")),false);
});
