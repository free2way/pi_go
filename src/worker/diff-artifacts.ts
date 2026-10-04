import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * NEW-07 / AUD-16 / AT-GIT-004, AT-UI-005: the worker can produce diffs up to
 * the 3.4M-character capture limit, but the inline internal-callback body is
 * capped by the server's 4 MiB body limit. Instead of silently rewriting
 * `patch.diff` to a 400,000-character prefix (which also poisoned the terminal
 * downloadable artifact), the full diff is first written to a durable file next
 * to the run worktree, and the inline text (if it must be shrunk) carries an
 * explicit truncation marker naming that artifact, its sha256 and byte count.
 */

export interface DiffArtifactRef {
  id: string;
  sha256: string;
  bytes: number;
  path: string;
}

/**
 * Inline callback budget. NEW-07 keeps the historical 3 MiB inline cap so an
 * oversized diff is always paired with a durable full artifact and an explicit
 * marker instead of a silent rewrite.
 */
export const callbackByteLimit = Number(process.env.PI_CALLBACK_MAX_BYTES || 0) || 3 * 1024 * 1024;

/** Persists the full diff durably and returns its id, sha256 and byte count. */
export async function persistDiffArtifact(worktree: string, diff: string, round: number): Promise<DiffArtifactRef> {
  const sha256 = createHash("sha256").update(diff, "utf8").digest("hex");
  const bytes = Buffer.byteLength(diff, "utf8");
  const id = `diff-r${round}-${sha256.slice(0, 12)}`;
  const directory = path.join(`${worktree}.state`, "artifacts");
  const artifactPath = path.join(directory, `${id}.patch`);
  await mkdir(directory, { recursive: true });
  await writeFile(artifactPath, diff, "utf8");
  return { id, sha256, bytes, path: artifactPath };
}

/** Explicit marker appended to a truncated inline diff (never silent). */
export function inlineDiffTruncationMarker(artifact: DiffArtifactRef | undefined, originalBytes: number) {
  return artifact
    ? `\n# [PiGO] inline diff truncated; full artifact ${artifact.id} (sha256=${artifact.sha256} bytes=${originalBytes})\n`
    : `\n# [PiGO] inline diff truncated; full artifact unavailable (sha256=n/a bytes=${originalBytes})\n`;
}

/** Prefix of the marker, used by tests and callers that only need the flag. */
export const inlineDiffTruncationFlag = "# [PiGO] inline diff truncated";

export interface CallbackBodyInput {
  patch?: object;
  event?: object;
  deliveryId?: string;
}

/** True when the serialized callback body no longer fits the inline budget. */
export function callbackBodyExceedsInlineLimit(input: CallbackBodyInput): boolean {
  return Buffer.byteLength(JSON.stringify(input), "utf8") > callbackByteLimit;
}

/**
 * Serializes an internal callback body. When the body exceeds the inline budget
 * and carries a diff, the diff is shrunk *with* a visible marker referencing the
 * durable artifact; other oversized fields are trimmed as before.
 */
export function encodeCallbackBody(input: CallbackBodyInput, diffArtifact?: DiffArtifactRef): string {
  let body = JSON.stringify(input);
  if (Buffer.byteLength(body) <= callbackByteLimit) return body;
  const patch = input.patch as Record<string, unknown> | undefined;
  if (patch && typeof patch.diff === "string") {
    const originalBytes = Buffer.byteLength(patch.diff, "utf8");
    patch.diff = `${patch.diff.slice(0, 400_000)}${inlineDiffTruncationMarker(diffArtifact, originalBytes)}`;
    body = JSON.stringify(input);
  }
  if (Buffer.byteLength(body) > callbackByteLimit && Array.isArray(patch?.checks)) {
    for (const check of patch.checks as Array<Record<string, unknown>>) {
      if (typeof check.output === "string") check.output = check.output.slice(-4_000);
    }
    body = JSON.stringify(input);
  }
  if (Buffer.byteLength(body) > callbackByteLimit) throw new Error("Callback payload exceeds the 3 MiB inline safety limit");
  return body;
}
