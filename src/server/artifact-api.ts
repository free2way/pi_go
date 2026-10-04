import type { ArtifactRecord, RunStoreLike } from "./store.js";

/**
 * NEW-07 / AT-GIT-004, AT-UI-005: the worker can produce diffs larger than the
 * inline internal-callback budget. The browser-downloadable artifact must be the
 * full body, so the worker uploads it here (token-authenticated internal route)
 * and only references the returned artifact id in the inline callback. The save
 * itself goes through the same artifact store as every other artifact, so the
 * existing list/download endpoints serve it unchanged.
 */
export interface InternalArtifactUpload {
  runId: string;
  artifactId: string;
  kind: string;
  content: string;
  baseSha?: string | null;
  /** Optional worker-provided owner check (rejected on mismatch). */
  ownerId?: string;
  createdAt?: string;
}

export type InternalArtifactResult =
  | { ok: true; artifact: ArtifactRecord }
  | { ok: false; status: 403 | 404; error: string };

/** Validates the target run (and owner, when supplied) then persists the artifact. */
export async function saveInternalRunArtifact(
  store: RunStoreLike,
  input: InternalArtifactUpload,
): Promise<InternalArtifactResult> {
  const run = store.getRun(input.runId);
  if (!run) return { ok: false, status: 404, error: "Run not found" };
  if (input.ownerId && input.ownerId !== run.ownerId) {
    return { ok: false, status: 403, error: "Artifact owner does not match the run owner" };
  }
  const artifact = await store.saveArtifact({
    runId: run.id,
    artifactId: input.artifactId,
    kind: input.kind,
    content: input.content,
    baseSha: input.baseSha ?? run.baseSha ?? null,
    createdAt: input.createdAt,
  });
  return { ok: true, artifact };
}
