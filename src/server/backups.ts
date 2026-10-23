import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, stat, statfs, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { BackupEntry, BackupOverview } from "../shared/backups.js";

const ID = /^backup_[a-f0-9]{32}$/;
const PAYLOADS = ["database.dump", "credentials.vault.json", "release-settings.json", "scm-settings.json"] as const;
type Manifest = Omit<BackupEntry, "protected"> & { schemaVersion: 1; previousState?: "ready" | "failed"; checksums: Partial<Record<typeof PAYLOADS[number], string>> };
export class BackupError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

/** Native, consistent PostgreSQL dump. Credentials never enter argv or logs. */
export async function dumpBackup(databaseUrl: string, destination: string): Promise<void> {
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new BackupError("BACKUP_UNAVAILABLE", 503);
  const connection = new URL(databaseUrl);
  if (!connection.hostname || !connection.pathname.slice(1) || !connection.username) throw new BackupError("BACKUP_UNAVAILABLE", 503);
  const pass = decodeURIComponent(connection.password);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: connection.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: connection.port || "5432",
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: pass,
    PGCONNECT_TIMEOUT: "10", PGAPPNAME: "application-backup",
  };
  // libpq's PGDATABASE environment variable does not expand a connection URI.
  // Forward transport policy explicitly rather than silently dropping TLS.
  const transport: Record<string, string> = {
    sslmode: "PGSSLMODE", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", sslrootcert: "PGSSLROOTCERT", sslcrl: "PGSSLCRL",
    channel_binding: "PGCHANNELBINDING", ssl_min_protocol_version: "PGSSLMINPROTOCOLVERSION", ssl_max_protocol_version: "PGSSLMAXPROTOCOLVERSION",
    target_session_attrs: "PGTARGETSESSIONATTRS", options: "PGOPTIONS",
  };
  for (const [name, value] of connection.searchParams) {
    if (!Object.hasOwn(transport, name)) throw new BackupError("BACKUP_UNAVAILABLE", 503);
    env[transport[name]] = value;
  }
  const file = await open(destination, "wx", 0o600);
  try {
    const space = await statfs(path.dirname(destination));
    const maxBytes = Math.min(512 * 1024 * 1024, space.bavail * space.bsize - 256 * 1024 * 1024);
    if (maxBytes <= 0) throw new BackupError("BACKUP_SPACE_LOW");
    const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--no-password", "--lock-wait-timeout=10000"], {
        env,
        stdio: ["ignore", "pipe", "ignore"], timeout: 300_000,
      });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new BackupError("BACKUP_CREATE_FAILED", 503)));
      child.once("close", (code) => code === 0 ? resolve() : reject(new BackupError("BACKUP_CREATE_FAILED", 503)));
    });
    let bytes = 0;
    const bound = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new BackupError("BACKUP_SIZE_LIMIT") : null, bytes > maxBytes ? undefined : chunk);
    } });
    try {
      await Promise.all([exited, pipeline(child.stdout!, bound, createWriteStream(destination, { fd: file.fd, autoClose: false }))]);
      await file.sync();
    } catch { child.kill("SIGKILL"); throw new BackupError("BACKUP_CREATE_FAILED", 503); }
  } finally { await file.close(); }
}

/** Operator-owned root, no caller-supplied paths and no recursive deletion. */
export class BackupManager {
  private running?: Promise<void>;
  constructor(private readonly options: {
    root: string;
    dump: (destination: string) => Promise<void>;
    sources: Partial<Record<Exclude<typeof PAYLOADS[number], "database.dump">, string>>;
    now?: () => Date;
  }) {}

  private async root() {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError("BACKUP_STORAGE_UNSAFE", 503);
    await chmod(this.options.root, 0o700);
    return realpath(this.options.root);
  }
  private async directory(root: string, id: string) {
    if (!ID.test(id)) throw new BackupError("BACKUP_NOT_FOUND", 404);
    const dir = path.join(root, id);
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new BackupError("BACKUP_NOT_FOUND", 404);
    return dir;
  }
  private async read(dir: string): Promise<Manifest> {
    const file = await open(path.join(dir, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 16_384) throw new Error("size");
      const value = JSON.parse(await file.readFile("utf8")) as Manifest;
      if (value.schemaVersion !== 1 || !ID.test(value.id) || value.id !== path.basename(dir)
        || !["creating", "ready", "failed", "deleted"].includes(value.state)
        || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isSafeInteger(value.bytes) || value.bytes < 0
        || !Number.isSafeInteger(value.files) || value.files < 0 || value.files > PAYLOADS.length
        || !value.checksums || typeof value.checksums !== "object" || Array.isArray(value.checksums)
        || Object.entries(value.checksums).some(([name, hash]) => !PAYLOADS.includes(name as typeof PAYLOADS[number]) || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("schema");
      return value;
    } catch { throw new BackupError("BACKUP_INTEGRITY_FAILED", 409); }
    finally { await file.close(); }
  }
  private async save(dir: string, manifest: Manifest) {
    const temp = path.join(dir, `.manifest-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    await rename(temp, path.join(dir, "manifest.json"));
  }
  private async audit(root: string, actorId: string, action: string, backupId: string) {
    const file = await open(path.join(root, "audit.jsonl"), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ at: new Date().toISOString(), actorId, action, backupId }) + "\n"); await file.sync(); }
    finally { await file.close(); }
  }
  private async lock(root: string) {
    try {
      const file = await open(path.join(root, ".operation-lock"), "wx", 0o600);
      await file.close();
    } catch { throw new BackupError("BACKUP_BUSY", 409); }
    // Only remove our exact lock file. A crash intentionally fails closed;
    // operators must inspect the interrupted job before clearing a stale lock.
    return async () => { const { unlink } = await import("node:fs/promises"); await unlink(path.join(root, ".operation-lock")); };
  }
  private async entries(root: string) {
    const names = (await readdir(root)).filter(name => ID.test(name));
    if (names.length > 2000) throw new BackupError("BACKUP_LIMIT", 409);
    const rows: Manifest[] = [];
    for (const name of names) {
      const dir = await this.directory(root, name);
      rows.push(await this.read(dir));
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async overview(): Promise<BackupOverview> {
    const root = await this.root(), rows = await this.entries(root);
    const latest = rows.find(row => row.state === "ready")?.id;
    let audit: BackupOverview["audit"] = [];
    try {
      const file = await open(path.join(root, "audit.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await file.stat()).size, offset = Math.max(0, size - 65_536), bytes = Buffer.alloc(size - offset);
        await file.read(bytes, 0, bytes.length, offset);
        const lines = bytes.toString("utf8").split("\n");
        if (offset) lines.shift();
        audit = lines.filter(Boolean).slice(-50).map(line => JSON.parse(line)).reverse();
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new BackupError("BACKUP_AUDIT_UNAVAILABLE", 503); }
    return {
      backups: rows.map(({ id, state, createdAt, bytes, files }) => ({ id, state, createdAt, bytes, files, protected: id === latest })),
      busy: Boolean(await stat(path.join(root, ".operation-lock")).catch(() => undefined)),
      encryption: "none", scope: "application-data",
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 3, automaticDeletion: false }, audit,
    };
  }
  async create(actorId: string): Promise<BackupEntry> {
    const root = await this.root(), unlock = await this.lock(root);
    const id = `backup_${randomUUID().replaceAll("-", "")}`, dir = path.join(root, id);
    const manifest: Manifest = { schemaVersion: 1, id, createdAt: (this.options.now?.() ?? new Date()).toISOString(), state: "creating", bytes: 0, files: 0, checksums: {} };
    try {
      if ((await this.entries(root)).length >= 2000) throw new BackupError("BACKUP_LIMIT");
      const recent = (await this.entries(root)).some(row => (this.options.now?.() ?? new Date()).getTime() - Date.parse(row.createdAt) < 60_000);
      if (recent) throw new BackupError("BACKUP_RATE_LIMITED", 429);
      const space = await statfs(root);
      if (space.bavail * space.bsize < 256 * 1024 * 1024) throw new BackupError("BACKUP_SPACE_LOW");
      await this.audit(root, actorId, "backup.create_requested", id);
      await mkdir(dir, { mode: 0o700 });
      await this.save(dir, manifest);
    } catch (error) { await unlock(); throw error; }
    this.running = (async () => {
      try {
        await this.options.dump(path.join(dir, "database.dump"));
        await chmod(path.join(dir, "database.dump"), 0o600);
        const dump = await open(path.join(dir, "database.dump"), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const header = Buffer.alloc(5); await dump.read(header, 0, 5, 0);
          if (header.toString() !== "PGDMP") throw new BackupError("BACKUP_INTEGRITY_FAILED");
        } finally { await dump.close(); }
        for (const [name, source] of Object.entries(this.options.sources)) {
          if (!PAYLOADS.includes(name as typeof PAYLOADS[number]) || name === "database.dump") throw new BackupError("BACKUP_STORAGE_UNSAFE");
          const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
          if (!file) continue;
          try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new BackupError("BACKUP_STORAGE_UNSAFE");
            await writeFile(path.join(dir, name), await file.readFile(), { flag: "wx", mode: 0o600 });
          } finally { await file.close(); }
        }
        for (const name of PAYLOADS) {
          const file = path.join(dir, name), info = await lstat(file).catch(() => undefined);
          if (!info) continue;
          if (!info.isFile() || info.isSymbolicLink()) throw new BackupError("BACKUP_STORAGE_UNSAFE");
          const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
          manifest.checksums[name] = hash.digest("hex"); manifest.bytes += info.size; manifest.files++;
        }
        await this.audit(root, actorId, "backup.create_completed", id);
        manifest.state = "ready";
      } catch {
        manifest.state = "failed";
        await this.audit(root, actorId, "backup.create_failed", id);
      } finally {
        await this.save(dir, manifest);
        await unlock();
      }
    })();
    // Retain a join seam for orderly tests; the background rejection never logs
    // pg_dump stderr, connection strings, file contents or private paths.
    void this.running.catch(() => undefined);
    return { id, state: "creating", createdAt: manifest.createdAt, bytes: 0, files: 0, protected: false };
  }
  async waitForIdle() { await this.running; }
  private async verify(dir: string, row: Manifest) {
    if (!row.checksums["database.dump"] || Object.keys(row.checksums).length !== row.files) throw new BackupError("BACKUP_INTEGRITY_FAILED");
    for (const [name, expected] of Object.entries(row.checksums)) {
      const file = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new BackupError("BACKUP_INTEGRITY_FAILED");
        const hash = createHash("sha256"); for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest("hex") !== expected) throw new BackupError("BACKUP_INTEGRITY_FAILED");
      } finally { await file.close(); }
    }
  }
  async changeState(id: string, deleted: boolean, actorId: string) {
    const root = await this.root(), unlock = await this.lock(root);
    try {
      const dir = await this.directory(root, id), row = await this.read(dir);
      const allowed = deleted ? ["ready", "failed"] : ["deleted"];
      if (!allowed.includes(row.state)) throw new BackupError("BACKUP_INVALID_STATE");
      const rows = await this.entries(root);
      const latest = rows.find(item => item.state === "ready");
      if (deleted && latest?.id === id) throw new BackupError("BACKUP_LATEST_PROTECTED");
      // A damaged newer backup must not authorize removal of an older usable
      // one. Check its payload, not merely its ready marker.
      if (deleted && row.state === "ready" && latest) await this.verify(await this.directory(root, latest.id), latest);
      // No file is erased. A tombstone is the recoverable quarantine; raw
      // payloads remain inaccessible through HTTP in either state.
      await this.audit(root, actorId, deleted ? "backup.delete_requested" : "backup.restore_requested", id);
      if (!deleted && row.previousState === "ready") {
        await this.verify(dir, row);
      }
      if (deleted) { row.previousState = row.state as "ready" | "failed"; row.state = "deleted"; }
      else {
        if (row.previousState !== "ready" && row.previousState !== "failed") throw new BackupError("BACKUP_INTEGRITY_FAILED");
        row.state = row.previousState;
        delete row.previousState;
      }
      await this.save(dir, row);
      await this.audit(root, actorId, deleted ? "backup.deleted" : "backup.restored", id);
    } finally { await unlock(); }
  }
}
