import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { RunStore } from "./store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-demo-"));
  const store = new RunStore(path.join(directory, "runs.json"));
  await store.init();
  const run = baseDemoRun({
    title: "Demo run",
    task: "A sufficiently long demo task description for the runner",
    repository: "demo/auth-service",
  });
  await store.createRun(run, {
    runId: run.id,
    round: 1,
    source: "system",
    type: "run.created",
    message: "created",
    at: new Date().toISOString(),
  });
  return { store, run };
}

describe("runDemo", () => {
  it("emits a multi-channel chat transcript for a completed run", async () => {
    const { store, run } = await createStore();

    await runDemo(store, run.id, { delayMs: 1 });

    const events = await store.getEvents(run.id);
    const chatChannels = new Set(
      events
        .filter((event) => event.type === "chat.message")
        .map((event) => (event.meta?.chat as { channel: string } | undefined)?.channel),
    );

    expect(store.getRun(run.id)?.state).toBe("completed");
    expect(chatChannels).toEqual(new Set(["developer", "checks", "reviewer", "handoff"]));
    expect(events.some((event) => event.type === "review.changes_requested")).toBe(true);
  });

  it("does not append chat messages after the run is cancelled", async () => {
    const { store, run } = await createStore();
    const demo = runDemo(store, run.id, { delayMs: 60 });

    // Wait until the first step has landed, then cancel while the runner sleeps.
    while (!(await store.getEvents(run.id)).some((event) => event.type === "workspace.created")) {
      await sleep(1);
    }
    await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
    await store.appendEvent({
      runId: run.id,
      round: 1,
      source: "system",
      type: "run.cancelled",
      message: "任务已取消",
      at: new Date().toISOString(),
    });
    await demo;

    const events = await store.getEvents(run.id);
    expect(events.some((event) => event.type === "chat.message")).toBe(false);
    const cancelIndex = events.findIndex((event) => event.type === "run.cancelled");
    expect(events.slice(cancelIndex + 1).filter((event) => event.type === "chat.message")).toEqual([]);
  });
});
