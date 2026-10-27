import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactDiagnosticCredentials, redactArtifactDiagnostic, saveInternalRunArtifact } from "./artifact-api.js";
import { createHash } from "node:crypto";
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
  it("sanitizes diagnostic content before persistence and hashes the exact safe body", async () => {
    const { store, run } = await testStore();
    const platform = ["DUMMY", 'platform/+"'].join("_"), file = "/tmp/fixture/internal-config.json";
    const databaseUrl = new URL("postgresql://db.invalid/a");
    databaseUrl.username = ["DUMMY", "user"].join("_");
    databaseUrl.password = ["DUMMY", "db"].join("_");
    const content = `ordinary failure Bearer DUMMY_bearer ${platform} ${encodeURIComponent(platform)} ${JSON.stringify(platform)} ${file} ${databaseUrl}`;
    const result = await saveInternalRunArtifact(store, { runId: run.id, artifactId: "diagnostic", kind: "log", content }, { PI_INTERNAL_TOKEN: platform, PI_DATA_FILE: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact = await store.getArtifact(run.id, "diagnostic");
    expect(artifact?.content).toContain("ordinary failure");
    expect(artifact?.content).toContain("[redacted");
    expect(artifact?.content).not.toContain("DUMMY");
    expect(artifact?.content).not.toContain(file);
    expect(result.artifact.bytes).toBe(Buffer.byteLength(artifact!.content!));
    expect(result.artifact.sha256).toBe(createHash("sha256").update(artifact!.content!).digest("hex"));
  });

  it("does not apply diagnostic text rewriting to source patches", () => {
    const value = ["DUMMY", "platform"].join("_");
    const patch = `--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+${value} Bearer DUMMY_source\n`;
    expect(redactArtifactDiagnostic("patch", patch, undefined, { PI_INTERNAL_TOKEN: value })).toBe(patch);
  });

  it.each(["plain", "url", "json"])("redacts the current saved run credential in %s trace content before persistence", async (format) => {
    const { store, run } = await testStore();
    const value = ["DUMMY", 'opaque/+" model value'].join("_");
    const encoded = format === "url" ? encodeURIComponent(value) : format === "json" ? JSON.stringify(value).slice(1, -1) : value;
    const result = await saveInternalRunArtifact(store, { runId: run.id, artifactId: "trace", kind: "trace", content: `provider failure: ${encoded}` }, {}, async () => [value]);
    expect(result.ok).toBe(true);
    const artifact = await store.getArtifact(run.id, "trace");
    expect(artifact?.content).toBe("provider failure: [redacted]");
    if (result.ok) expect(result.artifact.sha256).toBe(createHash("sha256").update(artifact!.content!).digest("hex"));
  });

  it("resolves partial current and legacy credentials only for the run owner's pinned providers", async () => {
    const { run } = await testStore();
    const values = new Map([
      [run.ownerId + ":deepseek", "DUMMY_current"],
      ["legacy-owner:deepseek", "DUMMY_previous"],
      ["legacy-owner:openai-proxy", "DUMMY_reviewer"],
      [run.ownerId + ":unrelated", "DUMMY_other_provider"],
      ["other-owner:deepseek", "DUMMY_other_owner"],
    ]);
    const get = vi.fn((owner: string, provider: string) => values.get(owner + ":" + provider));
    const legacy = vi.fn(async (owner: string) => owner === run.ownerId ? "legacy-owner" : undefined);
    const credentials = await artifactDiagnosticCredentials(run, { get }, legacy);
    expect(new Set(credentials)).toEqual(new Set(["DUMMY_current", "DUMMY_previous", "DUMMY_reviewer"]));
    expect(legacy).toHaveBeenCalledWith(run.ownerId);
    expect(get.mock.calls.every(([owner, provider]) => [run.ownerId, "legacy-owner"].includes(owner) && ["deepseek", "openai-proxy"].includes(provider))).toBe(true);
  });

  it("does not degrade a failed identity or credential lookup into an empty context", async () => {
    const { run } = await testStore();
    await expect(artifactDiagnosticCredentials(run, { get: () => undefined }, async () => { throw new Error("identity lookup failed"); })).rejects.toThrow("identity lookup failed");
    await expect(artifactDiagnosticCredentials(run, { get: () => { throw new Error("decrypt failed"); } }, async () => undefined)).rejects.toThrow("decrypt failed");
  });

  it("does not persist diagnostic bytes when credential context cannot be loaded", async () => {
    const { store, run } = await testStore();
    await expect(saveInternalRunArtifact(store, { runId: run.id, artifactId: "trace", kind: "trace", content: "failure" }, {}, async () => { throw new Error("lookup failed"); })).rejects.toThrow("lookup failed");
    expect(await store.listArtifacts(run.id)).toEqual([]);
  });

  it("rejects missing runs and wrong declared owners before reading any credential", async () => {
    const { store, run } = await testStore();
    const read = vi.fn(async () => ["DUMMY_private"]);
    expect(await saveInternalRunArtifact(store, { runId: "missing", artifactId: "trace", kind: "trace", content: "failure" }, {}, read)).toMatchObject({ ok: false, status: 404 });
    expect(await saveInternalRunArtifact(store, { runId: run.id, ownerId: "other", artifactId: "trace", kind: "trace", content: "failure" }, {}, read)).toMatchObject({ ok: false, status: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves source patch bytes and SHA without depending on vault availability", async () => {
    const { store, run } = await testStore();
    const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+Bearer DUMMY_source\n";
    const read = vi.fn(async () => { throw new Error("unavailable"); });
    const result = await saveInternalRunArtifact(store, { runId: run.id, artifactId: "diff", kind: "patch", content: patch }, {}, read);
    expect(result.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const stored = await store.getArtifact(run.id, "diff");
    expect(stored?.content).toBe(patch);
    expect(stored?.sha256).toBe(createHash("sha256").update(patch).digest("hex"));
  });

  it("detects unsafe historical trace content without rewriting the original value", () => {
    const value = "DUMMY_saved_model";
    const original = "old failure " + value;
    expect(redactArtifactDiagnostic("trace", original, undefined, {}, [value])).toBe("old failure [redacted]");
    expect(original).toBe("old failure " + value);
  });

  it.each(["log", "trace", "text", "unknown-future-kind"])("protects non-patch %s without relying on a diagnostic-kind allowlist", (kind) => {
    expect(redactArtifactDiagnostic(kind, "failure Bearer DUMMY_echo", undefined, {})).toBe("failure Bearer [redacted]");
  });

  it("removes configured internal paths and the run worktree, including encoded forms", () => {
    const worktree = "/workspace/runs/DUMMY_run", file = "/tmp/fixture/DUMMY_file.json";
    const content = [worktree, encodeURIComponent(worktree), file].join(" ");
    expect(redactArtifactDiagnostic("log", content, worktree, { PI_DATA_FILE: file })).toBe("[redacted] [redacted] [redacted]");
  });

  it("keeps normal text and relative repository paths intact", () => {
    const content = "build failed at src/app.ts:12; expected 2, got 1";
    expect(redactArtifactDiagnostic("log", content, undefined, { PI_DATA_FILE: "/tmp/fixture/data.json", PI_WORKSPACE_ROOT: "/workspace" })).toBe(content);
  });
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
