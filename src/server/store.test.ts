import { mkdtemp, readFile } from "node:fs/promises";
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
    const run = baseDemoRun({ title: "Test run", task: "A sufficiently long test task", repository: "test/repo" });

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

    expect(store.getEvents(run.id).map((event) => event.seq)).toEqual([1, 2]);
    expect(JSON.parse(await readFile(file, "utf8")).runs).toHaveLength(1);
  });
});

