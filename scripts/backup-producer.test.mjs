import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../deploy/docker/backup.sh", import.meta.url));
for (const override of [false, true]) {
  test(`backup never prunes old or unrelated directories (legacy retention override=${override})`, t => {
    const root = mkdtempSync(join(tmpdir(), "pigo-backup-producer-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project"), backups = join(root, "backups"), bin = join(root, "bin");
    for (const dir of [project, backups, bin]) mkdirSync(dir);
    writeFileSync(join(project, "compose.yaml"), "services: {}\n");
    for (const name of ["20200101T000000Z", "unrelated-operator-directory"]) {
      const dir = join(backups, name); mkdirSync(dir); writeFileSync(join(dir, "sentinel"), "DUMMY_KEEP_ME");
      const old = new Date(Date.now() - 60 * 86400000); utimesSync(dir, old, old);
    }
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require('node:fs'); const a=process.argv.slice(2);
if(a[0]==='inspect') console.log('PI_VAULT_FILE=/fixture-vault.json');
else if(a[0]==='cp') fs.writeFileSync(a.at(-1),'{}');
else if(a.includes('pg_dump')) process.stdout.write('DUMMY_DUMP');
else if(a.includes('psql')) console.log(JSON.stringify(Object.fromEntries(['users','identities','workspaces','runs','events','agents','checks','findings','artifacts','checkpoints','jobs','digest'].map(k=>[k,k==='digest'?null:0]))));
else process.exit(2);
`, { mode: 0o700 });
    writeFileSync(join(bin, "sha256sum"), `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_PIGO_DIR: project };
    delete env.PI_BACKUP_KEEP_DAYS;
    if (override) env.PI_BACKUP_KEEP_DAYS = "1";
    const r = spawnSync("bash", [script, backups], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const name of ["20200101T000000Z", "unrelated-operator-directory"]) assert.equal(readFileSync(join(backups, name, "sentinel"), "utf8"), "DUMMY_KEEP_ME");
    assert.equal(readdirSync(backups).length, 3);
    assert.match(r.stdout, /retention not applied/);
  });
}
