/**
 * NEW-07 / AT-GIT-004, AT-UI-005: when a run diff is too large for the inline
 * internal callback (3 MiB), the full body is uploaded to the web app's internal
 * artifact route and only the artifact reference travels inline. The upload is
 * explicit: a failure is surfaced to the caller so the durable local artifact is
 * kept and the failure is recorded, never silently dropped.
 */
export interface UploadRunArtifactInput {
  callbackBase: string;
  token: string;
  runId: string;
  artifactId: string;
  kind: string;
  content: string;
  baseSha?: string | null;
  ownerId?: string;
}

export interface UploadedRunArtifact {
  artifactId: string;
  kind: string;
  bytes: number;
  sha256: string | null;
}

export async function uploadRunArtifact(
  input: UploadRunArtifactInput,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadedRunArtifact> {
  const response = await fetchImpl(
    `${input.callbackBase}/api/internal/runs/${encodeURIComponent(input.runId)}/artifacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        artifactId: input.artifactId,
        kind: input.kind,
        content: input.content,
        ...(input.baseSha ? { baseSha: input.baseSha } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => ({})) as { artifact?: UploadedRunArtifact; error?: string };
  if (!response.ok || !body.artifact) {
    throw new Error(body.error || `Artifact upload failed: ${response.status}`);
  }
  return body.artifact;
}
