import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { BackupManager, dumpBackup } from "./backups.js";
import { registerBackupRoutes } from "./backup-routes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(dump?: (destination: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "application-backup-test-")); roots.push(temp);
  const vault = path.join(temp, "vault.json"), root = path.join(temp, "backups");
  await writeFile(vault, '{"ciphertext":"synthetic"}');
  let time = Date.now();
  const manager = new BackupManager({ root, sources: { "credentials.vault.json": vault }, dump: dump || (async target => { await writeFile(target, "PGDMPsynthetic"); }), now: () => new Date(time) });
  return { temp, root, vault, manager, tick: () => { time += 61_000; } };
}
describe("application backup lifecycle", () => {
  it("creates an asynchronous, checksummed owner-only backup without exposing contents or paths", async () => {
    const { manager, root } = await fixture();
    const entry = await manager.create("admin");
    expect(entry.state).toBe("creating"); await manager.waitForIdle();
    const overview = await manager.overview();
    expect(overview.backups[0]).toMatchObject({ id: entry.id, state: "ready", files: 2, protected: true });
    expect(overview.encryption).toBe("none"); expect(overview.retention.automaticDeletion).toBe(false);
    expect(JSON.stringify(overview)).not.toContain("synthetic"); expect(JSON.stringify(overview)).not.toContain(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, entry.id, "database.dump"))).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(path.join(root, entry.id, "manifest.json"), "utf8"));
    expect(manifest.checksums["database.dump"]).toMatch(/^[a-f0-9]{64}$/);
    expect(overview.audit.map(e => e.action)).toEqual(["backup.create_completed", "backup.create_requested"]);
    expect((await new BackupManager({ root, sources: {}, dump: async () => undefined }).overview()).backups).toEqual(overview.backups);
  });
  it("refuses concurrent jobs across manager instances and limits repeated requests", async () => {
    let finish!: () => void;
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const { manager, root } = await fixture(async target => { await hold; await writeFile(target, "PGDMPsynthetic"); });
    await manager.create("admin");
    expect((await manager.overview()).busy).toBe(true);
    const other = new BackupManager({ root, sources: {}, dump: async () => undefined });
    await expect(other.create("admin")).rejects.toMatchObject({ code: "BACKUP_BUSY" });
    finish(); await manager.waitForIdle();
    await expect(manager.create("admin")).rejects.toMatchObject({ code: "BACKUP_RATE_LIMITED" });
  });
  it("protects the latest success and reversibly quarantines an older backup", async () => {
    const { manager, tick, root } = await fixture();
    const first = await manager.create("admin"); await manager.waitForIdle();
    await expect(manager.changeState(first.id, true, "admin")).rejects.toMatchObject({ code: "BACKUP_LATEST_PROTECTED" });
    tick(); const next = await manager.create("admin"); await manager.waitForIdle();
    await manager.changeState(first.id, true, "admin");
    expect((await manager.overview()).backups.find(b => b.id === first.id)?.state).toBe("deleted");
    expect(await readFile(path.join(root, first.id, "database.dump"), "utf8")).toBe("PGDMPsynthetic");
    await manager.changeState(first.id, false, "admin");
    expect((await manager.overview()).backups.find(b => b.id === first.id)?.state).toBe("ready");
    expect((await manager.overview()).backups.find(b => b.id === next.id)?.protected).toBe(true);
  });
  it("refuses tampered payloads on undo and never touches the newer backup", async () => {
    const { manager, tick, root } = await fixture();
    const first = await manager.create("admin"); await manager.waitForIdle(); tick();
    await manager.create("admin"); await manager.waitForIdle();
    await manager.changeState(first.id, true, "admin");
    await writeFile(path.join(root, first.id, "database.dump"), "tampered");
    await expect(manager.changeState(first.id, false, "admin")).rejects.toMatchObject({ code: "BACKUP_INTEGRITY_FAILED" });
    expect((await manager.overview()).backups.find(b => b.id === first.id)?.state).toBe("deleted");
  });
  it("retains failed jobs without logging private errors and preserves failure on undo", async () => {
    const { manager } = await fixture(async () => { throw new Error("synthetic private failure /private-path"); });
    const entry = await manager.create("admin"); await manager.waitForIdle();
    expect((await manager.overview()).backups[0].state).toBe("failed");
    expect(JSON.stringify(await manager.overview())).not.toContain("private");
    await manager.changeState(entry.id, true, "admin"); await manager.changeState(entry.id, false, "admin");
    expect((await manager.overview()).backups[0].state).toBe("failed");
  });
  it("does not let a damaged newer backup authorize deleting an older usable one", async () => {
    const { manager, tick, root } = await fixture();
    const old = await manager.create("admin"); await manager.waitForIdle(); tick();
    const next = await manager.create("admin"); await manager.waitForIdle();
    await writeFile(path.join(root, next.id, "database.dump"), "corrupt");
    await expect(manager.changeState(old.id, true, "admin")).rejects.toMatchObject({ code: "BACKUP_INTEGRITY_FAILED" });
    expect((await manager.overview()).backups.find(b => b.id === old.id)?.state).toBe("ready");
  });
  it("rejects traversal, linked backup directories and linked roots", async () => {
    const { manager, root, temp } = await fixture(); await manager.overview();
    for (const id of ["../vault.json", "/tmp", "backup_x", "..%2Fvault"]) await expect(manager.changeState(id, true, "admin")).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
    const id = "backup_" + "a".repeat(32); await symlink(temp, path.join(root, id));
    await expect(manager.changeState(id, true, "admin")).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
    const link = path.join(temp, "linked"); await symlink(root, link);
    await expect(new BackupManager({ root: link, sources: {}, dump: async () => undefined }).overview()).rejects.toMatchObject({ code: "BACKUP_STORAGE_UNSAFE" });
  });
  it("refuses linked source/audit files without writing through them", async () => {
    const { manager, vault, temp, root } = await fixture();
    const external = path.join(temp, "external"); await writeFile(external, "unchanged");
    await rm(vault); await symlink(external, vault);
    await manager.create("admin"); await manager.waitForIdle();
    expect((await manager.overview()).backups[0].state).toBe("failed");
    await rm(path.join(root, "audit.jsonl")); await symlink(external, path.join(root, "audit.jsonl"));
    await expect(manager.overview()).rejects.toMatchObject({ code: "BACKUP_AUDIT_UNAVAILABLE" });
    expect(await readFile(external, "utf8")).toBe("unchanged");
  });
  it("fails closed for malformed manifests", async () => {
    const { manager, root } = await fixture(); const b = await manager.create("admin"); await manager.waitForIdle();
    await writeFile(path.join(root, b.id, "manifest.json"), '{"state":"ready"}');
    await expect(manager.overview()).rejects.toMatchObject({ code: "BACKUP_INTEGRITY_FAILED" });
  });
  it("rejects invalid dump headers", async () => {
    const { manager } = await fixture(async target => { await writeFile(target, "not a dump"); });
    await manager.create("admin"); await manager.waitForIdle(); expect((await manager.overview()).backups[0].state).toBe("failed");
  });
});
describe("backup HTTP boundary", () => {
  it("requires an administrator for every route, including reads", async () => {
    const { manager } = await fixture(); const app = Fastify();
    registerBackupRoutes(app, { manager, admin: async () => undefined });
    for (const url of ["/api/admin/backups", "/api/admin/backups/x/delete", "/api/admin/backups/x/restore"]) {
      const response = await app.inject({ url, method: url.endsWith("backups") ? "GET" : "POST", payload: { confirm: true } });
      expect(response.statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/api/admin/backups", payload: { confirm: true } })).statusCode).toBe(403);
    await app.close();
  });
  it("requires explicit confirmation, rejects path/command fields and exposes no download or purge", async () => {
    const { manager } = await fixture(); const app = Fastify(); registerBackupRoutes(app, { manager, admin: async () => "admin" });
    for (const payload of [{}, { confirm: false }, { confirm: true, path: "/tmp" }, { confirm: true, command: "echo" }]) {
      expect((await app.inject({ method: "POST", url: "/api/admin/backups", payload })).statusCode).toBe(400);
    }
    const response = await app.inject({ method: "POST", url: "/api/admin/backups", payload: { confirm: true } });
    expect(response.statusCode).toBe(202); await manager.waitForIdle();
    const id = response.json().id;
    expect((await app.inject({ method: "POST", url: `/api/admin/backups/${id}/delete`, payload: { confirm: true } })).json().code).toBe("BACKUP_LATEST_PROTECTED");
    for (const suffix of ["download", "purge"]) expect((await app.inject(`/api/admin/backups/${id}/${suffix}`)).statusCode).toBe(404);
    expect((await app.inject("/api/admin/backups")).json().backups).toHaveLength(1);
    await app.close();
  });
});
describe("native dump execution", () => {
  it("rejects a non-PostgreSQL connection before opening a file", async () => {
    const { temp } = await fixture(); await expect(dumpBackup("https://example.invalid", path.join(temp, "dump"))).rejects.toMatchObject({ code: "BACKUP_UNAVAILABLE" });
  });
  it("keeps connection credentials out of argv and does not inherit platform secrets", async () => {
    const { temp } = await fixture(); const bin = path.join(temp, "bin"); await mkdir(bin);
    // Synthetic executable fixture, not a real credential or a database backup.
    await writeFile(path.join(bin, "pg_dump"), `#!/bin/sh\nprintf '%s' "$*" > '${temp}/argv'\nprintf '%s' "\${PI_INTERNAL_TOKEN-unset}" > '${temp}/inherited'\nprintf '%s/%s/%s' "$PGHOST" "$PGDATABASE" "$PGSSLMODE" > '${temp}/connection'\nprintf 'PGDMPsynthetic'\n`, { mode: 0o700 });
    const previous = process.env.PATH; process.env.PATH = bin;
    try {
      const database = new URL("postgresql://db.example.invalid/fixture");
      database.username = ["DUMMY", "USER"].join("_");
      database.password = ["DUMMY", "VALUE"].join("_");
      database.searchParams.set("sslmode", "verify-full");
      await dumpBackup(database.href, path.join(temp, "dump"));
      expect(await readFile(path.join(temp, "argv"), "utf8")).toBe("--format=custom --no-owner --no-privileges --no-password --lock-wait-timeout=10000");
      expect(await readFile(path.join(temp, "connection"), "utf8")).toBe("db.example.invalid/fixture/verify-full");
      expect(await readFile(path.join(temp, "inherited"), "utf8")).toBe("unset");
      expect(await readFile(path.join(temp, "dump"), "utf8")).toBe("PGDMPsynthetic");
    } finally { process.env.PATH = previous; }
  });
});
