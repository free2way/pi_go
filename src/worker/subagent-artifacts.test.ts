import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureFailedSubAgentWorktree, parsePorcelainZ, type SubAgentCaptureExecResult } from "./subagent-artifacts.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function worktreeWithFile(relative: string, content: string) {
  const root = await mkdtemp(path.join(tmpdir(), "pigo-subagent-"));
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return root;
}

function fakeExec(outputs: { status: string; diff: string; statusCode?: number; diffCode?: number }) {
  return async (args: string[]): Promise<SubAgentCaptureExecResult> => {
    if (args[0] === "status") return { code: outputs.statusCode ?? 0, stdout: outputs.status, stderr: outputs.statusCode ? "status failed" : "" };
    if (args[0] === "diff") return { code: outputs.diffCode ?? 0, stdout: outputs.diff, stderr: outputs.diffCode ? "diff failed" : "" };
    return { code: 1, stdout: "", stderr: `unexpected git ${args[0]}` };
  };
}

describe("captureFailedSubAgentWorktree (AT-AGENT-008)", () => {
  it("persists the patch with its hash and an inventory that includes untracked files", async () => {
    const worktree = await worktreeWithFile("src/new.ts", "export const added = true;\n");
    const artifactsDirectory = path.join(await mkdtemp(path.join(tmpdir(), "pigo-artifacts-")), "artifacts");
    const diff = "diff --git a/src/new.ts b/src/new.ts\n+export const added = true;\n";

    const result = await captureFailedSubAgentWorktree({
      worktree,
      artifactsDirectory,
      taskId: "api-task",
      exec: fakeExec({ status: "?? src/new.ts\0", diff }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { artifact } = result;
    expect(artifact.patchSha256).toBe(sha256(diff));
    expect(artifact.patchBytes).toBe(Buffer.byteLength(diff, "utf8"));
    expect(await readFile(artifact.patchPath, "utf8")).toBe(diff);
    expect(artifact.truncated).toBe(false);

    const inventory = JSON.parse(await readFile(artifact.inventoryPath, "utf8")) as {
      files: Array<{ path: string; status: string; sha256: string; bytes: number }>;
    };
    const untracked = inventory.files.find((file) => file.path === "src/new.ts");
    expect(untracked?.status).toBe("??");
    expect(untracked?.sha256).toBe(sha256("export const added = true;\n"));
    expect(untracked?.bytes).toBe(Buffer.byteLength("export const added = true;\n", "utf8"));
    expect(artifact.inventorySha256).toBe(sha256(await readFile(artifact.inventoryPath, "utf8")));
  });

  it("truncates an oversized patch explicitly instead of silently dropping it", async () => {
    const worktree = await worktreeWithFile("src/new.ts", "x\n");
    const artifactsDirectory = path.join(await mkdtemp(path.join(tmpdir(), "pigo-artifacts-")), "artifacts");
    const result = await captureFailedSubAgentWorktree({
      worktree,
      artifactsDirectory,
      taskId: "big-task",
      exec: fakeExec({ status: " M src/new.ts\0", diff: "d".repeat(2048) }),
      maxBytes: 256,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.truncated).toBe(true);
    expect(await readFile(result.artifact.patchPath, "utf8")).toContain("[PiGO] sub-agent patch truncated");
  });

  it("records a capture failure explicitly instead of silently dropping it", async () => {
    const worktree = await worktreeWithFile("src/new.ts", "x\n");
    const artifactsDirectory = path.join(await mkdtemp(path.join(tmpdir(), "pigo-artifacts-")), "artifacts");
    const result = await captureFailedSubAgentWorktree({
      worktree,
      artifactsDirectory,
      taskId: "broken-task",
      exec: fakeExec({ status: "", diff: "", statusCode: 128 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("git status failed");
  });

  it("parses porcelain -z output including rename entries", () => {
    expect(parsePorcelainZ("?? src/new.ts\0 M src/changed.ts\0R  src/new-name.ts\0src/old-name.ts\0")).toEqual([
      { path: "src/new.ts", status: "??" },
      { path: "src/changed.ts", status: " M" },
      { path: "src/new-name.ts", status: "R " },
    ]);
  });
});
