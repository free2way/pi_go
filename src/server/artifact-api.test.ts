import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveInternalRunArtifact } from "./artifact-api.js";
import { baseDemoRun } from "./demo-runner.js";
import { RunStore } from "./store.js";

const directories: string[] = [];

async function testStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-artifact-api-"));
  directories.push(directory);
  const store = new RunStore(path.join(directory, "runs.json"));
  await store.init();
  const run = baseDemoRun({ title: "Artifact", task: "A sufficiently long test task", repository: "test/repo" }, "owner-a");
  await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "created", at: new Date().toISOString() });
  return { store, run };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("saveInternalRunArtifact (NEW-07)", () => {
  it("persists a multi-megabyte diff artifact that list/download can serve", async () => {
    const { store, run } = await testStore();
    const content = "x".repeat(3_200_000);

    const result = await saveInternalRunArtifact(store, {
      runId: run.id,
      artifactId: "diff-r2-abcdef123456",
      kind: "patch",
      content,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.bytes).toBe(content.length);
    expect(result.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = await store.listArtifacts(run.id);
    expect(listed.map((artifact) => artifact.artifactId)).toContain("diff-r2-abcdef123456");
    const downloaded = await store.getArtifact(run.id, "diff-r2-abcdef123456");
    expect(downloaded?.content).toBe(content);
  });

  it("rejects an upload for a missing run", async () => {
    const { store } = await testStore();
    const result = await saveInternalRunArtifact(store, {
      runId: "run_missing",
      artifactId: "diff-r1-000000000000",
      kind: "patch",
      content: "diff",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Run not found" });
  });

  it("rejects an upload whose declared owner does not own the run", async () => {
    const { store, run } = await testStore();
    const result = await saveInternalRunArtifact(store, {
      runId: run.id,
      artifactId: "diff-r1-000000000000",
      kind: "patch",
      content: "diff",
      ownerId: "owner-b",
    });
    expect(result).toEqual({ ok: false, status: 403, error: "Artifact owner does not match the run owner" });
    expect(await store.getArtifact(run.id, "diff-r1-000000000000")).toBeUndefined();
  });
});
