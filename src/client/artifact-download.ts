import type { RunArtifact } from "../shared/types";

export type ArtifactDownloadFailure = "unsafe" | "unavailable" | "tooLarge" | "integrity" | "failed";

export class ArtifactDownloadError extends Error {
  constructor(readonly reason: ArtifactDownloadFailure) {
    super("Artifact download failed");
  }
}

/** Never render response text: even a proxy error may contain private diagnostics. */
export async function validatedArtifactBlob(response: Response, artifact: RunArtifact): Promise<Blob> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ArtifactDownloadError(response.status === 409 ? "unsafe"
      : response.status === 401 || response.status === 403 || response.status === 404 ? "unavailable"
        : response.status === 413 ? "tooLarge" : "failed");
  }
  // A login HTML page must never become a successful diagnostic download.
  if (response.redirected || !response.headers.get("content-type")?.startsWith("application/octet-stream")) {
    await response.body?.cancel();
    throw new ArtifactDownloadError("failed");
  }
  const blob = await response.blob();
  if (blob.size !== artifact.bytes || !artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new ArtifactDownloadError("integrity");
  }
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== artifact.sha256) throw new ArtifactDownloadError("integrity");
  return blob;
}

export function diagnosticFilename(artifact: RunArtifact): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${safe(artifact.runId)}-${safe(artifact.artifactId)}.txt`;
}
