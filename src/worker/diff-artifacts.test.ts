import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  callbackBodyExceedsInlineLimit,
  callbackByteLimit,
  encodeCallbackBody,
  inlineDiffTruncationFlag,
  persistDiffArtifact,
} from "./diff-artifacts.js";

const temporaryDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-diff-artifact-test-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("persistDiffArtifact / encodeCallbackBody (NEW-07)", () => {
  it("persists a 3.2M-char diff in full with correct sha256 and byte count", async () => {
    const root = await tempDir();
    const worktree = path.join(root, "run_1");
    const diff = "x".repeat(3_200_000);

    const artifact = await persistDiffArtifact(worktree, diff, 2);

    expect(artifact.bytes).toBe(Buffer.byteLength(diff, "utf8"));
    expect(artifact.sha256).toBe(createHash("sha256").update(diff, "utf8").digest("hex"));
    const stored = await readFile(artifact.path, "utf8");
    expect(stored).toBe(diff);
    expect(stored.length).toBe(3_200_000);
  });

  it("replaces an oversized inline diff with an explicit marker plus the artifact reference", async () => {
    const root = await tempDir();
    const worktree = path.join(root, "run_1");
    const diff = "x".repeat(3_200_000);
    const artifact = await persistDiffArtifact(worktree, diff, 2);

    const body = encodeCallbackBody(
      { patch: { diff, state: "checking" }, deliveryId: "d1" },
      artifact,
    );

    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(callbackByteLimit);
    const parsed = JSON.parse(body) as { patch: { diff: string } };
    expect(parsed.patch.diff).toContain(inlineDiffTruncationFlag);
    expect(parsed.patch.diff).toContain(artifact.id);
    expect(parsed.patch.diff).toContain(artifact.sha256);
    expect(parsed.patch.diff).toContain(`bytes=${artifact.bytes}`);
    expect(parsed.patch.diff.length).toBeLessThan(diff.length);
  });

  it("never truncates silently even when no artifact reference is available", () => {
    const diff = "y".repeat(3_200_000);
    const body = encodeCallbackBody({ patch: { diff }, deliveryId: "d2" });
    const parsed = JSON.parse(body) as { patch: { diff: string } };
    expect(parsed.patch.diff).toContain(inlineDiffTruncationFlag);
    expect(parsed.patch.diff).toContain("full artifact unavailable");
    expect(parsed.patch.diff).toContain("bytes=3200000");
  });

  it("leaves a small diff untouched", () => {
    const body = encodeCallbackBody({ patch: { diff: "small patch\n" }, deliveryId: "d3" });
    const parsed = JSON.parse(body) as { patch: { diff: string } };
    expect(parsed.patch.diff).toBe("small patch\n");
    expect(parsed.patch.diff).not.toContain(inlineDiffTruncationFlag);
  });

  it("flags only an oversized body as needing an artifact upload", () => {
    expect(callbackBodyExceedsInlineLimit({ patch: { diff: "small patch" }, deliveryId: "d4" })).toBe(false);
    expect(callbackBodyExceedsInlineLimit({ patch: { diff: "x".repeat(3_200_000) }, deliveryId: "d5" })).toBe(true);
  });
});
