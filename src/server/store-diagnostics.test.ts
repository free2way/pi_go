import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../shared/types.js";
import { CredentialVault } from "./credential-vault.js";
import { baseRealRun } from "./real-run.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { RunStore } from "./store.js";
import { createTestDb } from "./test-db.js";

const event = (runId: string): Omit<RunEvent, "seq"> => ({
  runId, round: 1, source: "system", type: "run.created", message: "created", at: new Date().toISOString(),
});
const makeRun = () => baseRealRun({ title: "Storage fixture", task: "Storage fixture", repository: "fixture", mode: "real" }, "fixture");

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("storage console diagnostic boundaries", () => {
  it.each(["runs", "vault"] as const)("recovers a real failed %s write without logging its private file path", async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-storage-diagnostic-"));
    const file = path.join(directory, `${kind}.json`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = new RunStore(file);
      const vault = new CredentialVault(file, Buffer.alloc(32, 9).toString("base64"));
      const run = makeRun();
      const target = kind === "runs" ? store : vault;
      await target.init();
      const write = kind === "runs"
        ? () => store.appendEvent(event(run.id))
        : () => vault.set("fixture", { provider: "deepseek", apiKey: ["DUMMY", "write"].join("_") });
      // A directory at the atomic-write path reliably fails on root and non-root.
      await mkdir(`${file}.tmp`);
      const failure = await write().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toBe("EISDIR");
      expect((failure as Error).message).toContain(file);
      await rm(`${file}.tmp`, { recursive: true });
      await write();
      const persisted = JSON.parse(await readFile(file, "utf8"));
      if (kind === "runs") expect(persisted.events[run.id]).toHaveLength(2);
      else expect(vault.get("fixture", "deepseek")).toBe(["DUMMY", "write"].join("_"));
      expect(log).toHaveBeenCalledTimes(1);
      const wire = format(...log.mock.calls[0]);
      expect(wire).toContain("EISDIR");
      expect(wire).not.toContain(directory);
      expect(wire).not.toContain(file);
      expect(log.mock.calls[0].every(value => typeof value === "string")).toBe(true);
      expect((failure as Error).message).toContain(file);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["append", "delivery"] as const)("isolates a failing %s listener without serializing the original Error", async (operation) => {
    const db = await createTestDb();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = ["DUMMY", 'opaque/+"', "x".repeat(2_100)].join("_");
    vi.stubEnv("PI_INTERNAL_TOKEN", secret);
    const privateRoot = path.join(tmpdir(), ["DUMMY", "private"].join("_"));
    vi.stubEnv("PI_WORKSPACE_ROOT", privateRoot);
    const store = new PostgresRunStore(db);
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run.id));
    const message = `ECONNRESET ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)} ${privateRoot}`;
    const failure = new Error(message, { cause: new Error(["DUMMY", "cause"].join("_")) });
    const stack = `${failure.name}: ${message}\n    at ${privateRoot}/handler.ts:1:1 ${["DUMMY", "stack"].join("_")}`;
    failure.stack = stack;
    const healthy = vi.fn();
    store.subscribe(run.id, () => { throw failure; });
    store.subscribe(run.id, healthy);
    const payload = { ...event(run.id), type: "run.step", message: secret };
    if (operation === "append") {
      expect((await store.appendEvent(payload)).seq).toBe(2);
    } else {
      const input = { runId: run.id, deliveryId: "fixture-delivery", patch: { summary: "committed" }, event: payload };
      expect(await store.applyDelivery(input)).toMatchObject({ applied: true, seq: 2 });
      expect(await store.applyDelivery(input)).toMatchObject({ applied: false, seq: 2 });
      expect(store.getRun(run.id)?.summary).toBe("committed");
    }
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(healthy.mock.calls[0][0]).toMatchObject({ seq: 2, message: secret });
    expect((await store.getEvents(run.id)).map(e => e.message)).toEqual(["created", secret]);
    expect(log).toHaveBeenCalledTimes(1);
    const wire = format(...log.mock.calls[0]);
    expect(wire).toContain("ECONNRESET");
    expect(wire).not.toContain("DUMMY");
    expect(wire).not.toContain(privateRoot);
    expect(log.mock.calls[0].every(value => typeof value === "string")).toBe(true);
    expect(String(log.mock.calls[0][1]).length).toBeLessThanOrEqual(2_000);
    expect(failure.message).toBe(message);
    expect(failure.stack).toBe(stack);
  });
});
