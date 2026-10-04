import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseDemoRun } from "./demo-runner.js";
import { RunStore } from "./store.js";

describe("RunStore", () => {
  it("persists runs and assigns monotonic event sequences", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-store-"));
    const file = path.join(directory, "runs.json");
    const store = new RunStore(file);
    await store.init();
    const run = baseDemoRun({ title: "Test run", task: "A sufficiently long test task", repository: "test/repo" }, "owner-a");

    await store.createRun(run, {
      runId: run.id,
      round: 1,
      source: "system",
      type: "run.created",
      message: "created",
      at: new Date().toISOString(),
    });
    await store.appendEvent({
      runId: run.id,
      round: 1,
      source: "developer",
      type: "agent.started",
      message: "started",
      at: new Date().toISOString(),
    });

    expect((await store.getEvents(run.id)).map((event) => event.seq)).toEqual([1, 2]);
    expect(store.listRuns("owner-a")).toHaveLength(1);
    expect(store.listRuns("owner-b")).toHaveLength(0);
    expect(store.getRun(run.id, "owner-b")).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).runs).toHaveLength(1);
  });

  it("keeps persisting after a transient write failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-store-"));
    const file = path.join(directory, "runs.json");
    const store = new RunStore(file);
    await store.init();
    const run = baseDemoRun({ title: "Recovery run", task: "A sufficiently long test task", repository: "test/repo" }, "owner-a");
    await store.createRun(run, {
      runId: run.id,
      round: 1,
      source: "system",
      type: "run.created",
      message: "created",
      at: new Date().toISOString(),
    });

    await chmod(directory, 0o555);
    try {
      await expect(store.appendEvent({
        runId: run.id,
        round: 1,
        source: "developer",
        type: "agent.started",
        message: "failing write",
        at: new Date().toISOString(),
      })).rejects.toThrow();
    } finally {
      await chmod(directory, 0o755);
    }

    await store.appendEvent({
      runId: run.id,
      round: 1,
      source: "developer",
      type: "agent.completed",
      message: "recovered write",
      at: new Date().toISOString(),
    });
    const persisted = JSON.parse(await readFile(file, "utf8")) as { events: Record<string, unknown[]> };
    expect(persisted.events[run.id]).toHaveLength(3);
    expect((await store.getEvents(run.id)).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("deletes a run together with its events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-store-"));
    const file = path.join(directory, "runs.json");
    const store = new RunStore(file);
    await store.init();
    const run = baseDemoRun({ title: "Delete me", task: "A sufficiently long test task", repository: "test/repo" }, "owner-a");
    await store.createRun(run, {
      runId: run.id,
      round: 1,
      source: "system",
      type: "run.created",
      message: "created",
      at: new Date().toISOString(),
    });

    await store.deleteRun(run.id);

    expect(store.getRun(run.id)).toBeUndefined();
    expect(await store.getEvents(run.id)).toEqual([]);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { runs: unknown[]; events: Record<string, unknown[]> };
    expect(persisted.runs).toHaveLength(0);
    expect(persisted.events[run.id]).toBeUndefined();
  });
});
