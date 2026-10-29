import type { ArtifactRecord, RunStoreLike } from "./store.js";
import type { Run } from "../shared/types.js";
import { diagnosticSecrets, redactDiagnosticText } from "../shared/diagnostics.js";
import { createHash } from "node:crypto";

export const ARTIFACT_DIAGNOSTIC_POLICY_VERSION = 1;

/** Resolve only the run owner's pinned providers, including its migrated owner
 * alias. Missing individual keys are valid; lookup/decryption errors propagate
 * so a diagnostic is never published with an incomplete secret context.
 */
export async function artifactDiagnosticCredentials(
  run: Pick<Run, "ownerId" | "developer" | "reviewer">,
  vault: { get(ownerId: string, provider: string): string | undefined },
  legacyOwnerFor: (ownerId: string) => Promise<string | undefined>,
): Promise<string[]> {
  const legacy = await legacyOwnerFor(run.ownerId);
  const owners = [...new Set([run.ownerId, ...(legacy ? [legacy] : [])])];
  const providers = [...new Set([run.developer.provider, run.reviewer.provider])];
  return [...new Set(owners.flatMap((owner) => providers.map((provider) => vault.get(owner, provider))).filter((value): value is string => Boolean(value)))];
}

/** Patches are executable source artifacts: never rewrite their bytes or SHA.
 * All other string artifacts are diagnostic output, sanitized before hashing.
 */
export function redactArtifactDiagnostic(
  kind: string,
  content: string,
  worktree?: string,
  environment: NodeJS.ProcessEnv = process.env,
  credentials: readonly string[] = [],
): string {
  if (kind === "patch") return content;
  const internalPaths = Object.entries(environment)
    .filter(([name, value]) => /(?:_FILE|_ROOT|_DIR|_DIRECTORY)$/.test(name) && value && /^(?:\/|[a-z]:[\\/])/i.test(value))
    .map(([, value]) => value!);
  return redactDiagnosticText(content, [...diagnosticSecrets(environment), ...internalPaths, ...(worktree ? [worktree] : []), ...credentials]);
}

/** Current keys cannot recognize an arbitrary retired key in a legacy body.
 * Require provenance from the sanitized write boundary, then check the current
 * context too. Bind provenance to bytes so an old writer cannot keep a stale
 * marker after overwriting the body. This is not a cryptographic signature.
 */
export async function artifactDiagnosticDownloadSafe(
  artifact: { kind: string; content: string; diagnosticPolicyVersion?: number | null; diagnosticPolicySha256?: string | null },
  run: Run,
  environment: NodeJS.ProcessEnv,
  readCredentialsForRun: (run: Run) => Promise<readonly string[]>,
): Promise<boolean> {
  if (artifact.kind === "patch") return true;
  if (artifact.diagnosticPolicyVersion !== ARTIFACT_DIAGNOSTIC_POLICY_VERSION) return false;
  if (artifact.diagnosticPolicySha256 !== createHash("sha256").update(artifact.content).digest("hex")) return false;
  const credentials = await readCredentialsForRun(run);
  return redactArtifactDiagnostic(artifact.kind, artifact.content, run.worktree, environment, credentials) === artifact.content;
}

/**
 * NEW-07 / AT-GIT-004, AT-UI-005: the worker can produce diffs larger than the
 * inline internal-callback budget. The browser-downloadable artifact must be the
 * full body, so the worker uploads it here (token-authenticated internal route)
 * and only references the returned artifact id in the inline callback. The save
 * itself goes through the same artifact store as every other artifact, so the
 * existing list/download endpoints serve patches unchanged. Non-patch diagnostic
 * bodies are redacted before persistence and before computing metadata.
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
  environment: NodeJS.ProcessEnv = process.env,
  readCredentialsForRun?: (run: Run) => Promise<readonly string[]>,
): Promise<InternalArtifactResult> {
  const run = store.getRun(input.runId);
  if (!run) return { ok: false, status: 404, error: "Run not found" };
  if (input.ownerId && input.ownerId !== run.ownerId) {
    return { ok: false, status: 403, error: "Artifact owner does not match the run owner" };
  }
  const credentials = input.kind === "patch" ? [] : await readCredentialsForRun?.(run) ?? [];
  const artifact = await store.saveArtifact({
    runId: run.id,
    artifactId: input.artifactId,
    kind: input.kind,
    content: redactArtifactDiagnostic(input.kind, input.content, run.worktree, environment, credentials),
    // Never accept provenance from the upload payload. Without a complete
    // credential resolver the body may be stored, but is not trusted to export.
    diagnosticPolicyVersion: input.kind !== "patch" && readCredentialsForRun ? ARTIFACT_DIAGNOSTIC_POLICY_VERSION : null,
    baseSha: input.baseSha ?? run.baseSha ?? null,
    createdAt: input.createdAt,
  });
  return { ok: true, artifact };
}
