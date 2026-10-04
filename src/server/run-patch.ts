import { createHash } from "node:crypto";
import type { Run } from "../shared/types.js";

/**
 * A1 — exporting a run's work as a patch, and (when configured) opening a merge
 * request. The pure helpers here are the testable core: selecting the authoritative
 * patch body, naming the download, resolving the `PI_MERGE_REQUEST_*` config and
 * shaping the request payload. No network or filesystem access happens here.
 */

export type PatchOrigin = "artifact" | "run" | "worktree";

export interface PatchSelection {
  content: string;
  origin: PatchOrigin;
  sha256: string;
  bytes: number;
  baseSha: string | null;
  artifactId: string;
}

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Picks the authoritative patch body, preferring the durable artifact (the full
 * body, even when the inline `run.diff` was truncated), then the run's inline
 * diff, then a freshly generated worker diff. Returns `undefined` when none of
 * the three sources produced content, so the route can answer a clear "not
 * available" instead of emitting an empty patch.
 */
export function selectPatch(input: {
  artifact?: { artifactId?: string; content?: string | null; sha256?: string | null; bytes?: number | null } | undefined;
  runDiff?: string | null | undefined;
  worktreeDiff?: string | null | undefined;
  baseSha?: string | null | undefined;
}): PatchSelection | undefined {
  const candidates: Array<{ origin: PatchOrigin; content?: string | null | undefined }> = [
    { origin: "artifact", content: input.artifact?.content },
    { origin: "run", content: input.runDiff },
    { origin: "worktree", content: input.worktreeDiff },
  ];
  for (const candidate of candidates) {
    if (typeof candidate.content === "string" && candidate.content.length > 0) {
      return {
        content: candidate.content,
        origin: candidate.origin,
        sha256: sha256(candidate.content),
        bytes: Buffer.byteLength(candidate.content, "utf8"),
        baseSha: input.baseSha ?? null,
        artifactId: input.artifact?.artifactId ?? "diff",
      };
    }
  }
  return undefined;
}

/** Safe `Content-Disposition` filename for a run patch download. */
export function patchFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return `${safe || "run"}.patch`;
}

export interface MergeRequestConfig {
  configured: boolean;
  /** Present only when configured; never serialized to the browser. */
  url?: string;
  token?: string;
  project?: string;
  targetBranch?: string;
  /** Human-readable reason the feature is unavailable. */
  reason?: string;
}

/**
 * Reads the documented `PI_MERGE_REQUEST_*` environment:
 * - `PI_MERGE_REQUEST_URL` (required) — webhook that opens the merge request;
 * - `PI_MERGE_REQUEST_TOKEN` (optional) — sent as a bearer token;
 * - `PI_MERGE_REQUEST_PROJECT` (optional) — target repository path/name;
 * - `PI_MERGE_REQUEST_TARGET_BRANCH` (optional) — defaults to the workspace
 *   default branch when the request is sent.
 */
export function resolveMergeRequestConfig(env: Record<string, string | undefined>): MergeRequestConfig {
  const url = (env.PI_MERGE_REQUEST_URL ?? "").trim();
  if (!url) {
    return { configured: false, reason: "merge request is not configured（未设置 PI_MERGE_REQUEST_URL）" };
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { configured: false, reason: "PI_MERGE_REQUEST_URL must be an http(s) URL" };
  }
  const token = (env.PI_MERGE_REQUEST_TOKEN ?? "").trim();
  const project = (env.PI_MERGE_REQUEST_PROJECT ?? "").trim();
  const targetBranch = (env.PI_MERGE_REQUEST_TARGET_BRANCH ?? "").trim();
  return {
    configured: true,
    url,
    ...(token ? { token } : {}),
    ...(project ? { project } : {}),
    ...(targetBranch ? { targetBranch } : {}),
  };
}

/** Merge-request payload for the configured webhook. Contains the full patch. */
export function buildMergeRequestPayload(input: {
  run: Pick<Run, "id" | "title" | "task" | "repository" | "branch" | "baseSha" | "summary">;
  patch: PatchSelection;
  targetBranch?: string | null;
  project?: string | null;
  requestedBy: string;
}) {
  return {
    action: "open_merge_request",
    runId: input.run.id,
    title: `[PiGO] ${input.run.title}`,
    description: input.run.summary,
    repository: input.project ?? input.run.repository,
    sourceBranch: input.run.branch,
    targetBranch: input.targetBranch ?? null,
    baseSha: input.patch.baseSha,
    requestedBy: input.requestedBy,
    patch: {
      artifactId: input.patch.artifactId,
      sha256: input.patch.sha256,
      bytes: input.patch.bytes,
      content: input.patch.content,
    },
  };
}

/** 409 body returned when a merge request is attempted without configuration. */
export function mergeRequestUnavailable(config: MergeRequestConfig) {
  return {
    status: 409 as const,
    code: "MERGE_REQUEST_NOT_CONFIGURED" as const,
    message: config.reason ?? "merge request is not configured",
  };
}
