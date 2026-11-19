import { randomBytes } from "node:crypto";
import type { ChatChannel, ChatParticipant, ChatRole, Finding, Run, RunEvent, RunState } from "../shared/types.js";
import { clipChatContent } from "../shared/chat.js";
import { throwIfCancelled } from "./checks.js";
import { CheckpointTracker, memoryCheckpointClient, type Checkpoint, type CheckpointClient } from "./checkpoints.js";
import { createJobHeartbeat } from "./job-heartbeat.js";
import { redactWorkerDiagnostic } from "./diagnostic-redaction.js";
import { diagnosticSecrets, redactKnownSecretText } from "../shared/diagnostics.js";
import { callbackBodyExceedsInlineLimit, encodeCallbackBody, type DiffArtifactRef } from "./diff-artifacts.js";
import { uploadRunArtifact } from "./artifact-upload.js";
import { createReviewTriageTrigger, jevReviewTriageEnabled } from "./decision-triage.js";
import { createAuditRetentionTrigger } from "./audit-retention.js";
import { callbackBase, internalToken, workerId, diagnosticMessage, workspaceRoot } from "./worker-runtime.js";
import type { JobInput } from "./worker-runtime.js";
import type { LeaseOperation } from "../shared/job-lease-metrics.js";
import { workerLeaseMetrics } from "./job-lease-metrics.js";

/**
 * Internal control-plane call. `timeoutMs` bounds this hop only; it defaults to
 * the original 15s and is raised/lowered per caller (the shadow decision call
 * uses a tighter, still provider-budget-aware ceiling, see `decision-triage.ts`).
 */
async function internalRequest(pathName: string, init?: RequestInit, timeoutMs = 15_000) {
  const response = await fetch(`${callbackBase}/api/internal${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const failure = new Error(String(body.error || `Internal request failed: ${response.status}`)) as Error & { status?: number; code?: string };
    failure.status = response.status;
    failure.code = typeof body.code === "string" ? body.code : undefined;
    throw failure;
  }
  return body;
}

const checkpointClient: CheckpointClient = {
  list: async (runId) => {
    const body = await internalRequest(`/runs/${encodeURIComponent(runId)}/checkpoints`);
    return (body.checkpoints ?? []) as Checkpoint[];
  },
  save: async (runId, input) => {
    await internalRequest(`/runs/${encodeURIComponent(runId)}/checkpoints`, { method: "POST", body: JSON.stringify(input) });
  },
};

async function leaseRequest(operation: LeaseOperation, path: string, init: RequestInit) {
  return workerLeaseMetrics.track(operation, () => internalRequest(path, init),
    value => operation === "lease" && Array.isArray(value.jobs) && value.jobs.length === 0 ? "empty" : "success");
}

export const jobApi = {
  claim: (jobId: string) => leaseRequest("claim", `/jobs/${encodeURIComponent(jobId)}/claim`, { method: "POST", body: JSON.stringify({ workerId }) }),
  heartbeat: (jobId: string) => leaseRequest("heartbeat", `/jobs/${encodeURIComponent(jobId)}/heartbeat`, { method: "POST", body: JSON.stringify({ workerId }) }),
  finish: (jobId: string, state: string, error?: string) => leaseRequest("finish", `/jobs/${encodeURIComponent(jobId)}/finish`, { method: "POST", body: JSON.stringify({ workerId, state, error }) }),
  release: (jobId: string, reason: string) => leaseRequest("release", `/jobs/${encodeURIComponent(jobId)}/release`, { method: "POST", body: JSON.stringify({ workerId, reason }) }),
  lease: async (capacity: number) => (await leaseRequest("lease", "/jobs/lease", { method: "POST", body: JSON.stringify({ workerId, capacity }) })).jobs as PendingJob[],
};

/**
 * docs/26 §9.1/§9.2: shadow review triage, opt-in on the WORKER's own env
 * (`PI_JEV_MODE`), read once at module scope like the other `PI_*` knobs. It is
 * a no-op when unset/`off`: no HTTP call, no event and no log line. The gateway
 * stays authoritative, so a worker/web setting mismatch can only ever produce a
 * business-safe `disabled` there — never a failed run.
 *
 * The call reuses the existing internal token (same auth as checkpoints/jobs)
 * and deliberately adds NO usage to the run: tokens/cost live on the audit row
 * under the decision role (docs/26 §13). The worker emits no run events either —
 * the gateway appends `decision.requested` plus one outcome event per batch.
 */
const reviewTriageEnabled = jevReviewTriageEnabled(process.env);
export const triggerReviewTriage = createReviewTriageTrigger({
  enabled: reviewTriageEnabled,
  send: (pathName, init, timeoutMs) => internalRequest(pathName, init, timeoutMs),
});

/**
 * AT-JEV-056 (docs/27 §7.6): the decision-audit retention trigger. It rides the
 * existing 60s maintenance tick below and self-throttles to an hourly internal
 * call, where the web (the only process with a database) performs the sweep.
 * `PI_DECISION_AUDIT_RETENTION_DAYS` is read once at module scope: when it is
 * unset/blank/`0` (the default) the trigger is a strict no-op — no HTTP call and
 * no log line — and a failure is swallowed into one bounded warning so the
 * maintenance loop is never disturbed.
 */
export const triggerAuditRetention = createAuditRetentionTrigger({
  send: (pathName, init, timeoutMs) => internalRequest(pathName, init, timeoutMs),
});

export type PendingJob = {
  jobId: string;
  kind: string;
  run: Run;
  checks: string[];
  credentials: { developer: string; reviewer: string };
  /** AUD-05: false means the job never started, so it must create the run directory. */
  wasStarted: boolean;
  resume?: { instruction?: string };
  retryReview?: boolean;
};

const jobHeartbeatMs = 20_000;
const jobStaleMs = Math.max(jobHeartbeatMs * 2, Number(process.env.PI_JOB_STALE_SECONDS || 120) * 1_000);
export const activeJobLeases = new Map<string, string>();

/** Keeps a claimed job fresh and aborts before an uncertain lease can expire. */
export function startJobHeartbeat(jobId: string | undefined, credentials: JobInput["credentials"], controller: AbortController) {
  if (!jobId) return { stop: () => undefined, leaseLost: () => false };
  return createJobHeartbeat({
    intervalMs: jobHeartbeatMs,
    staleMs: jobStaleMs,
    heartbeat: () => jobApi.heartbeat(jobId),
    onLeaseLost: (error) => {
      console.warn(`[jobs] lease lost for ${jobId}: ${diagnosticMessage(error, Object.values(credentials))}`);
      controller.abort();
    },
    onWarning: (error, failures, limit) => {
      console.warn(`[jobs] heartbeat failed (${failures}/${limit}): ${diagnosticMessage(error, Object.values(credentials))}`);
    },
  });
}

/** How often a lock holder proves it is still alive. */
export const workspaceLockHeartbeatMs = 30_000;

export async function loadTracker(runId: string, credentials: JobInput["credentials"]) {
  try {
    return await new CheckpointTracker(checkpointClient, runId).load();
  } catch (error) {
    console.warn(`[checkpoints] unavailable for ${runId}: ${diagnosticMessage(error, Object.values(credentials))}`);
    return new CheckpointTracker(memoryCheckpointClient(), runId);
  }
}

export function redactJobSecrets(message: string, credentials: JobInput["credentials"]) {
  // Structured replies must remain valid JSON. Replace only known values;
  // generic diagnostic field patterns would rewrite model protocol fields.
  return redactKnownSecretText(message, [
    credentials.developer, credentials.reviewer,
    ...diagnosticSecrets(process.env), callbackBase, workspaceRoot,
  ]);
}

/**
 * NEW-07: uploads a full diff as a server-side run artifact when the inline
 * callback cannot carry it, returning a reference the inline marker/event can
 * name. On failure the durable local artifact is kept and the failure is
 * recorded as an audit event (never silently dropped).
 */
async function uploadFullDiffArtifact(runId: string, diff: string, local: DiffArtifactRef, options: { ownerId?: string; round?: number } = {}): Promise<{ ref: DiffArtifactRef; uploaded: boolean }> {
  try {
    const uploaded = await uploadRunArtifact({
      callbackBase,
      token: internalToken,
      runId,
      artifactId: local.id,
      kind: "patch",
      content: diff,
      ownerId: options.ownerId,
    });
    return {
      ref: { ...local, id: uploaded.artifactId, sha256: uploaded.sha256 ?? local.sha256, bytes: uploaded.bytes },
      uploaded: true,
    };
  } catch (error) {
    // The upload service/network error is untrusted diagnostic text. Redact
    // before truncating (a long path or credential may straddle the limit),
    // never rewrite the durable patch itself or conceal the failed upload.
    const reason = redactWorkerDiagnostic(error instanceof Error ? error.message : String(error), [
      internalToken, callbackBase, local.path,
    ]).slice(0, 300);
    const message = `完整 Diff 制品上传失败，保留本地全量制品 ${local.id}（bytes=${local.bytes} sha256=${local.sha256}）：${reason}`;
    await postUpdate(runId, {
      event: {
        round: options.round ?? 1,
        source: "system",
        type: "diff.upload_failed",
        message,
        meta: { artifactId: local.id, sha256: local.sha256, bytes: local.bytes },
      },
    }).catch(() => undefined);
    return { ref: local, uploaded: false };
  }
}

export async function postUpdate(runId: string, input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}, options: { diffArtifact?: DiffArtifactRef; ownerId?: string; round?: number } = {}) {
  let response: Response;
  // AUD-15: every internal update carries a delivery key so a retried or
  // duplicated call is applied at most once (patch and event atomically).
  const deliveryId = `${runId}:${Date.now().toString(36)}:${randomBytes(6).toString("hex")}`;
  const jobId = activeJobLeases.get(runId);
  const payload: { patch?: object; event?: object; deliveryId: string; jobId?: string; workerId?: string } = {
    ...input,
    deliveryId,
    ...(jobId ? { jobId, workerId } : {}),
    ...(input.event ? { event: { ...input.event } } : {}),
  };
  // NEW-07: an oversized diff is uploaded as a real server artifact first; the
  // inline body is still shrunk with an explicit marker, now naming that artifact.
  const patch = input.patch as Record<string, unknown> | undefined;
  const diff = typeof patch?.diff === "string" ? patch.diff : undefined;
  const resolved = diff !== undefined && options.diffArtifact && callbackBodyExceedsInlineLimit(payload)
    ? await uploadFullDiffArtifact(runId, diff, options.diffArtifact, { ownerId: options.ownerId, round: options.round })
    : { ref: options.diffArtifact, uploaded: false };
  if (resolved.uploaded && resolved.ref && payload.event) {
    const event = payload.event as Record<string, unknown>;
    event.meta = {
      ...((event.meta as Record<string, unknown> | undefined) ?? {}),
      diffArtifact: { artifactId: resolved.ref.id, sha256: resolved.ref.sha256, bytes: resolved.ref.bytes },
    };
  }
  try {
    response = await fetch(`${callbackBase}/api/internal/runs/${runId}/update`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalToken}`,
        "Content-Type": "application/json",
      },
      body: encodeCallbackBody(payload, resolved.ref),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // AT-REL-007: an unreachable store is a storage failure, never a success.
    if (jobId) workerLeaseMetrics.observe("callback", "error");
    throw new Error(`Callback failed: ${(error as Error).message || "store unreachable"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (jobId) {
      let code: unknown;
      try { code = JSON.parse(body).code; } catch { /* An invalid response is a transport error. */ }
      workerLeaseMetrics.observe("callback", response.status === 409 && code === "JOB_LEASE_LOST" ? "conflict" : "error");
    }
    // Keep the full in-memory diagnostic until the consuming job-aware sink
    // redacts it. Truncating here can expose an unmatchable credential prefix.
    throw new Error(`Callback failed: ${response.status} ${body}`);
  }
  if (jobId) workerLeaseMetrics.observe("callback", "success");
}

export async function update(run: Run, state: RunState, source: RunEvent["source"], type: string, message: string, patch: Partial<Run> = {}, options: { diffArtifact?: DiffArtifactRef; meta?: Record<string, unknown> } = {}) {
  Object.assign(run, patch, { state });
  await postUpdate(run.id, {
    patch: { state, ...patch },
    event: { round: run.round, source, type, message, ...(options.meta ? { meta: options.meta } : {}) },
  }, { ...options, ownerId: run.ownerId, round: run.round });
}

/**
 * Appends one structured `chat.message` event (the collaboration transcript the
 * run detail page renders). The cancellation guard means a run cancelled while
 * an agent was mid-response never emits a phantom chat entry after
 * `run.cancelled` — the server would reject it anyway (terminal-state guard).
 *
 * `extra` is additive: review hand-offs attach their structured `findings` so
 * the UI renders severity/file:line/title/requiredChange without re-parsing, and
 * sub-agent messages attach their `agent` codename so the sender is readable.
 */
export async function chat(
  run: Run,
  channel: ChatChannel,
  from: ChatParticipant,
  to: ChatParticipant,
  role: ChatRole,
  content: string,
  signal?: AbortSignal,
  extra: { findings?: Finding[]; agent?: string } = {},
) {
  throwIfCancelled(signal);
  // Bounded per message, but never silent: `clipChatContent` appends an explicit
  // marker with the original/retained byte counts when it had to truncate.
  const clipped = clipChatContent(content).content;
  if (!clipped.trim()) return;
  await postUpdate(run.id, {
    event: {
      round: run.round,
      source: from === "developer" || from === "reviewer" || from === "checks" ? from : "system",
      type: "chat.message",
      message: clipped.replace(/\s+/g, " ").slice(0, 110),
      meta: { chat: { channel, from, to, role, content: clipped, ...(extra.findings?.length ? { findings: extra.findings } : {}), ...(extra.agent ? { agent: extra.agent } : {}) } },
    },
  });
}
