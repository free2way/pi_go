import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * AT-AGENT-008: a failed sub-agent's worktree is force-removed during cleanup,
 * so its uncommitted work was previously lost (only an 8 KiB output tail
 * survived). Before cleanup the worker now captures that uncommitted state as a
 * durable artifact under the run's `.state/artifacts/` directory:
 *
 *   <id>.patch           the `git diff HEAD --binary` output (bounded)
 *   <id>.inventory.json  every changed/untracked path with status, sha256, bytes
 *
 * The capture is bounded (a few MiB) and never throws for a capture failure: the
 * caller records the failure explicitly instead of silently dropping the work.
 */

export interface SubAgentCaptureExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one git command inside the failed sub-agent worktree. */
export type SubAgentCaptureExec = (args: string[]) => Promise<SubAgentCaptureExecResult>;

export interface CapturedPath {
  path: string;
  /** Porcelain status (e.g. "??", " M", "A ", "D "). */
  status: string;
  /** sha256 of the current on-disk content, or null when the file is gone/unreadable. */
  sha256: string | null;
  bytes: number | null;
}

export interface SubAgentFailureArtifact {
  id: string;
  taskId: string;
  patchPath: string;
  patchSha256: string;
  patchBytes: number;
  inventoryPath: string;
  inventorySha256: string;
  inventoryBytes: number;
  files: CapturedPath[];
  truncated: boolean;
  capturedAt: string;
}

export type SubAgentCaptureResult =
  | { ok: true; artifact: SubAgentFailureArtifact }
  | { ok: false; error: string };

/** Bound for a single captured patch (generous but finite). */
export const defaultMaxCaptureBytes = 4 * 1024 * 1024;

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/**
 * Parses `git status --porcelain=v1 -z` output. Rename/copy entries carry a
 * second NUL-terminated original-path field that must be skipped.
 */
export function parsePorcelainZ(output: string): Array<{ path: string; status: string }> {
  const parts = output.split("\0");
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const status = part.slice(0, 2);
    const filePath = part.slice(3);
    if (!filePath) continue;
    entries.push({ path: filePath, status });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

/**
 * Captures a failed sub-agent's uncommitted state. `exec` runs git inside the
 * worktree; files are read from disk to hash untracked/new files that a diff
 * cannot represent.
 */
export async function captureFailedSubAgentWorktree(input: {
  worktree: string;
  artifactsDirectory: string;
  taskId: string;
  exec: SubAgentCaptureExec;
  maxBytes?: number;
}): Promise<SubAgentCaptureResult> {
  const maxBytes = input.maxBytes ?? defaultMaxCaptureBytes;
  try {
    const status = await input.exec(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.code !== 0) {
      return { ok: false, error: `git status failed (${status.code}): ${(status.stderr || status.stdout).trim().slice(0, 300)}` };
    }
    const diff = await input.exec(["diff", "HEAD", "--binary", "--no-ext-diff", "--"]);
    if (diff.code !== 0) {
      return { ok: false, error: `git diff failed (${diff.code}): ${(diff.stderr || diff.stdout).trim().slice(0, 300)}` };
    }

    const entries = parsePorcelainZ(status.stdout);
    let patch = diff.stdout;
    let truncated = false;
    if (Buffer.byteLength(patch, "utf8") > maxBytes) {
      patch = `${Buffer.from(patch, "utf8").subarray(0, maxBytes).toString("utf8")}\n# [PiGO] sub-agent patch truncated at ${maxBytes} bytes\n`;
      truncated = true;
    }

    const files: CapturedPath[] = [];
    for (const entry of entries) {
      const absolute = path.join(input.worktree, entry.path);
      try {
        const info = await stat(absolute);
        if (info.isFile()) {
          const content = await readFile(absolute);
          files.push({
            path: entry.path,
            status: entry.status,
            sha256: createHash("sha256").update(content).digest("hex"),
            bytes: content.length,
          });
        } else {
          files.push({ path: entry.path, status: entry.status, sha256: null, bytes: null });
        }
      } catch {
        // Deleted or unreadable path: keep it in the inventory without content.
        files.push({ path: entry.path, status: entry.status, sha256: null, bytes: null });
      }
    }

    const patchSha256 = sha256(patch);
    const patchBytes = Buffer.byteLength(patch, "utf8");
    const id = `subagent-${safeId(input.taskId)}-${patchSha256.slice(0, 12)}`;
    const capturedAt = new Date().toISOString();
    const inventoryText = JSON.stringify({
      id,
      taskId: input.taskId,
      capturedAt,
      truncated,
      patch: { sha256: patchSha256, bytes: patchBytes },
      files,
    }, null, 2);
    const inventorySha256 = sha256(inventoryText);
    const patchPath = path.join(input.artifactsDirectory, `${id}.patch`);
    const inventoryPath = path.join(input.artifactsDirectory, `${id}.inventory.json`);
    await mkdir(input.artifactsDirectory, { recursive: true });
    await writeFile(patchPath, patch, "utf8");
    await writeFile(inventoryPath, inventoryText, "utf8");

    return {
      ok: true,
      artifact: {
        id,
        taskId: input.taskId,
        patchPath,
        patchSha256,
        patchBytes,
        inventoryPath,
        inventorySha256,
        inventoryBytes: Buffer.byteLength(inventoryText, "utf8"),
        files,
        truncated,
        capturedAt,
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 400) };
  }
}
