import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { internalUpdateRejection, releasesStoryBlocks, storyBlockReleaseNote } from "../shared/run-state.js";
import { buildStoryRunInput, STORY_STATUS_LABELS, type RunBudget, type StoryDetail } from "../shared/agile.js";
import type { ConfigStatus, CurrentUser, ModelCatalogResponse, ReviewScope, Run, RunEvent, RunReleaseRecord, Workspace } from "../shared/types.js";
import { AccountError, AccountService, accountAdminGate } from "./accounts.js";
import { AlertManager, createAlertSink } from "./alerts.js";
import { Authenticator } from "./auth.js";
import { CredentialVault } from "./credential-vault.js";
import { createDb, createPool, newId, runMigrations } from "./db.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { IdentityService } from "./identity.js";
import { availableModels, defaultSelections, loadModelCatalog, preflightRunModels } from "./model-catalog.js";
import { RunEventStream } from "./event-stream.js";
import { cleanupRunDirectory, keptRunStorageOutcome, type RunDirectoryCleaner } from "./run-cleanup.js";
import { baseRealRun } from "./real-run.js";
import { createProviderProbe, providerProbeDisabled } from "./provider-probe.js";
import { verifyPendingCredentials } from "./credential-verification.js";
import { RateLimiter } from "./rate-limit.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { saveInternalRunArtifact } from "./artifact-api.js";
import { type ApprovePlan, approveEventMeta, planApprove } from "./approve.js";
import { conflictReplyFor } from "./request-errors.js";
import { appendHumanNote } from "./run-notes.js";
import { resumeDeadlinePatch } from "./run-deadline-base.js";
import { parseRunSearch, searchRuns } from "./run-search.js";
import { ROUNDS_SCHEMA_VERSION, readRunRounds } from "./run-rounds.js";
import { readDecisionBrief } from "./decision-brief.js";
import { buildAcceptanceSnapshot } from "./acceptance.js";
import { batchItemFailure, batchItemSuccess, parseBatchRunIds, summarizeBatch, MAX_BATCH_RUN_IDS, type BatchItemOutcome } from "./batch-runs.js";
import { buildDeploymentStatus, parseDeployLog, resolveDeployLogPath, type DeploymentStatus } from "./deployments.js";
import { FAILURE_SCAN_LIMIT, USAGE_RUN_SCAN_LIMIT, buildSystemStatus, utcDayStart, type DeploymentInfo, type FailureEventRow, type StateCountRow, type SystemStatusInput, type TodayRunRow } from "./system-status.js";
import { mergeConflictReply, mergeRestoreFields, type MergeResult } from "../shared/merge.js";
import { buildDeployHookPayload, planMergeGate, planPostMergeDeploy, type MergeRecord } from "./run-merge.js";
import { coordinateApprovedMerge, replayPendingMerge } from "./merge-approval.js";
import { buildMergeRequestPayload, mergeRequestUnavailable, patchFileName, resolveMergeRequestConfig, selectPatch, type PatchSelection } from "./run-patch.js";
import { planReopen, reopenEventMeta } from "./run-reopen.js";
import { isActiveRelease, planReleaseStart, sameReleaseAttempt } from "./run-release.js";
import { AgileError, AgileService } from "./agile.js";
import { readAgileMetrics, readReleaseRetrospective, readReleaseSummary } from "./agile-metrics.js";
import { projectCreateSchema, projectPatchSchema, releaseCreateSchema, releasePatchSchema, releasePublishSchema, sprintCreateSchema, sprintPatchSchema, storyBlockSchema, storyCreateSchema, storyPatchSchema, storySubmitSchema, templateCreateSchema } from "./agile-schemas.js";
import { executeRelease } from "./release-execution.js";
import { buildReleaseDeployPayload, planReleasePublish, shapeReleaseDeployOutcome } from "./release-publish.js";
import type { RunStoreLike } from "./store.js";
import { WorkspaceError, WorkspaceService } from "./workspaces.js";

const app = Fastify({
  logger: {
    redact: {
      paths: ["req.headers.authorization", "req.headers.cf-access-jwt-assertion", "developerApiKey", "reviewerApiKey", "credentials"],
      censor: "[redacted]",
    },
  },
  bodyLimit: 64 * 1024,
});
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || "localhost";
const webVersion = process.env.PI_WEB_VERSION?.trim() || "0.26.4";
const demoMode = process.env.PI_DEMO_MODE !== "false";
const realRunsEnabled = process.env.PI_REAL_RUNS_ENABLED === "true";
const workerUrl = process.env.PI_WORKER_URL || "http://worker:3200";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
const releaseWebhookToken = process.env.PI_POST_MERGE_DEPLOY_TOKEN || "";
const dataFile = process.env.PI_DATA_FILE || path.resolve("data/runs.json");
const vaultFile = process.env.PI_VAULT_FILE || path.resolve("data/credentials.v1.json");
const publicOrigin = process.env.PI_PUBLIC_ORIGIN || "";
const vaultSecret = process.env.PI_VAULT_SECRET;
if (!vaultSecret) throw new Error("PI_VAULT_SECRET is required");
if (process.env.PI_AUTH_MODE === "cloudflare" && !publicOrigin) throw new Error("PI_PUBLIC_ORIGIN is required with Cloudflare authentication");

const modelCatalog = loadModelCatalog();
const modelDefaults = defaultSelections();
const vault = new CredentialVault(vaultFile, vaultSecret, {
  developer: modelDefaults.developer.provider,
  reviewer: modelDefaults.reviewer.provider,
});
const auth = new Authenticator();
await vault.init();
// AUD-08 / AT-MODEL-004: live provider probe used to verify credentials. It is
// injectable and never throws; a failed probe simply leaves a key unverified.
const providerProbe = createProviderProbe();

// AUD-08 cutover safety: credentials stored before live verification existed
// have `verifiedAt === null` and would block every real run. Resolve them once at
// startup, bounded so boot is not delayed by more than ~10s. Logs carry provider
// names and outcomes only — never key material.
try {
  const pending = vault.pendingVerifications();
  if (pending.length > 0) {
    const budgetMs = Number(process.env.PI_STARTUP_CREDENTIAL_PROBE_BUDGET_MS || 10_000);
    const pass = verifyPendingCredentials({
      listPending: () => pending,
      readKey: (userId, provider) => vault.get(userId, provider),
      probe: providerProbe,
      markVerified: (userId, provider, models, capabilities) => vault.markVerified(userId, provider, models, capabilities),
      markOperatorAsserted: (userId, provider) => vault.markOperatorAsserted(userId, provider),
      markUnverified: (userId, provider) => vault.markUnverified(userId, provider),
      probeDisabled: providerProbeDisabled,
      log: (message, detail) => app.log.info(detail ?? {}, message),
    }, { budgetMs });
    const outcome = await Promise.race([
      pass,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), budgetMs + 500);
        timer.unref?.();
      }),
    ]);
    if (outcome) {
      app.log.info(
        { pending: outcome.considered, verified: outcome.verified, asserted: outcome.asserted, unverified: outcome.unverified, skipped: outcome.skipped, deferred: outcome.deferred },
        "startup credential verification pass finished",
      );
    } else {
      app.log.warn({ pending: pending.length, budgetMs }, "startup credential verification pass exceeded its budget; continuing in the background");
    }
  }
} catch (error) {
  app.log.warn({ error: (error as Error).message }, "startup credential verification pass failed");
}

const databaseUrl = process.env.PI_DATABASE_URL;
if (!databaseUrl) throw new Error("PI_DATABASE_URL is required (postgresql://user:password@host:5432/database)");
const pool = createPool(databaseUrl);
const db = createDb(pool);
await runMigrations(db);

// REL-001: runs, events, agents, checks, findings, artifacts, checkpoints and
// jobs live in PostgreSQL. A legacy runs.json is imported once and kept intact.
const store: RunStoreLike = new PostgresRunStore(db);
const jobQueue = store instanceof PostgresRunStore ? store : undefined;
await store.init();
if (store instanceof PostgresRunStore && existsSync(dataFile)) {
  try {
    const legacy = JSON.parse(await readFile(dataFile, "utf8")) as { runs?: Run[]; events?: Record<string, RunEvent[]> };
    if ((legacy.runs ?? []).length > 0) {
      const before = await store.statistics();
      if (before.counts.runs === 0) {
        // Pre-owner-scoping runs (no ownerId) belong to the single legacy owner.
        const owners = (await db.query("SELECT id, legacy_owner_id FROM users")).rows;
        const defaultOwnerId = owners.length === 1 ? String(owners[0].legacy_owner_id ?? owners[0].id) : undefined;
        const result = await store.importLegacy({ runs: legacy.runs ?? [], events: legacy.events ?? {} }, { defaultOwnerId });
        app.log.info({ ...result, defaultOwnerId: Boolean(defaultOwnerId) }, "imported legacy runs.json into PostgreSQL");
      }
    }
  } catch (error) {
    app.log.warn({ error: (error as Error).message }, "legacy runs.json import skipped");
  }
}
const alerts = new AlertManager(createAlertSink({
  log: (level, payload, message) => app.log[level](payload, message),
  webhookUrl: process.env.PI_ALERT_WEBHOOK,
}));
const identities = new IdentityService(db);
const workspacesEnabled = process.env.PI_WORKSPACES_ENABLED !== "false";
// A1: merge-request creation is opt-in via PI_MERGE_REQUEST_*; when unset the
// route refuses clearly (409 MERGE_REQUEST_NOT_CONFIGURED) instead of guessing.
const mergeRequestConfig = resolveMergeRequestConfig(process.env);
const workspaces = new WorkspaceService(db, workerRequest);
const agile = new AgileService(db);
const userCache = new Map<string, CurrentUser>();

const createRunSchema = z.object({
  title: z.string().trim().min(2).max(80),
  task: z.string().trim().min(10).max(10_000),
  repository: z.string().trim().max(240).default("demo/auth-service"),
  workspaceId: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["demo", "real"]).default("demo"),
  checks: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  acceptanceCriteria: z.string().trim().max(4_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  developerModel: z.object({ provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120) }).optional(),
  reviewerModel: z.object({ provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120) }).optional(),
}).superRefine((value, context) => {
  if (value.mode === "real" && value.checks.length === 0) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Real runs require at least one check command" });
  }
  if (value.mode === "real" && !value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "Real runs require a registered workspace" });
  }
});

const credentialSchema = z.object({
  provider: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().trim().min(12).max(512).optional(),
  developerApiKey: z.string().trim().min(12).max(512).optional(),
  reviewerApiKey: z.string().trim().min(12).max(512).optional(),
}).refine((value) => (value.provider && value.apiKey) || value.developerApiKey || value.reviewerApiKey, "At least one credential is required")
  .refine((value) => !value.provider || Boolean(value.apiKey), "apiKey is required when provider is set");

const runStateSchema = z.enum(["queued", "preparing", "developing", "checking", "reviewing", "completed", "needs_human", "failed", "cancelled"]);
const checkpointSchema = z.object({
  stageKey: z.string().trim().min(1).max(120),
  status: z.enum(["running", "completed", "failed"]),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
const findingSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().max(400).nullable(),
  line: z.number().int().min(0).nullable(),
  title: z.string().min(1).max(300),
  evidence: z.string().max(8_000),
  requiredChange: z.string().max(8_000),
  resolved: z.boolean(),
  // Stable content identity (`<normalized file>|<normalized title>`); see
  // src/shared/finding-fingerprint.ts. Longer than the legacy hash, hence 800.
  fingerprint: z.string().max(800).optional(),
  firstSeenRound: z.number().int().min(1).max(99).optional(),
  lastSeenRound: z.number().int().min(1).max(99).optional(),
  observations: z.number().int().min(0).max(10_000).optional(),
  consecutiveRounds: z.number().int().min(0).max(10_000).optional(),
});
const checkResultSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  command: z.string().min(1).max(1_000),
  status: z.enum(["pending", "running", "passed", "failed"]),
  durationMs: z.number().min(0).optional(),
  exitCode: z.number().int().min(-1_000).max(1_000).optional(),
  output: z.string().max(64_000).optional(),
});
const subAgentTaskSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(8_000),
  files: z.array(z.string().max(400)).max(40),
  dependsOn: z.array(z.string().max(64)).max(20),
  status: z.enum(["planned", "running", "completed", "merged", "failed"]),
  branch: z.string().max(300).optional(),
  // Item-3: stable sub-agent codename (additive; title remains authoritative).
  name: z.string().min(1).max(60).optional(),
  summary: z.string().max(4_000).optional(),
  durationMs: z.number().min(0).optional(),
});
const developmentPlanSchema = z.object({
  complexity: z.enum(["small", "medium", "large"]),
  rationale: z.string().max(4_000),
  strategy: z.enum(["single", "parallel"]),
  tasks: z.array(subAgentTaskSchema).max(8),
});
const runRoleUsageSchema = z.object({
  role: z.string().min(1).max(40),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0).optional(),
  cacheWriteTokens: z.number().min(0).optional(),
  estimatedCost: z.number().min(0),
  calls: z.number().int().min(0),
});
const runUsageSchema = z.object({
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  estimatedCost: z.number().min(0),
  cacheReadTokens: z.number().min(0).optional(),
  cacheWriteTokens: z.number().min(0).optional(),
  totalTokens: z.number().min(0).optional(),
});
const runSessionSummarySchema = z.object({
  sessionId: z.string().min(1).max(300),
  role: z.string().min(1).max(40),
  rounds: z.array(z.number().int().min(1).max(99)).max(99),
  calls: z.number().int().min(0),
  resumed: z.boolean(),
  durationMs: z.number().min(0),
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0),
  cacheWriteTokens: z.number().min(0),
  modelCalls: z.number().int().min(0),
  firstAt: z.string().max(80),
  lastAt: z.string().max(80),
});
const runPatchSchema = z.object({
  state: runStateSchema,
  round: z.number().int().min(1).max(99),
  summary: z.string().max(8_000),
  // AUD-16: the worker reports the full run diff (bounded at 3.4M chars); the
  // JSON body limit is 4 MiB, so the schema must allow the same magnitude.
  diff: z.string().max(3_500_000),
  findings: z.array(findingSchema).max(100),
  checks: z.array(checkResultSchema).max(16),
  plan: developmentPlanSchema,
  usage: runUsageSchema,
  usageRoles: z.array(runRoleUsageSchema).max(20),
  // Sprint 2: additive per-session reuse/latency summary.
  sessions: z.array(runSessionSummarySchema).max(40),
  modelCalls: z.number().int().min(0).max(10_000),
  usageUnknownCalls: z.number().int().min(0).max(10_000),
  checkSnapshot: z.string().max(80),
  reviewSnapshot: z.string().max(80),
  checkPassed: z.boolean(),
  baseSha: z.string().max(80),
  durationMs: z.number().min(0).max(86_400_000),
  worktree: z.string().max(600),
}).partial().strict();
const internalEventSchema = z.object({
  round: z.number().int().min(1).max(99),
  source: z.enum(["system", "developer", "checks", "reviewer"]),
  type: z.string().min(1).max(120),
  message: z.string().min(1).max(8_000),
  meta: z.record(z.string(), z.unknown()).optional(),
});
const internalUpdateSchema = z.object({
  patch: runPatchSchema.optional(),
  event: internalEventSchema.optional(),
  /** Optional at-least-once delivery key so a retried callback is not double counted (AT-REL-004). */
  deliveryId: z.string().min(1).max(160).optional(),
}).strict();
// NEW-07: the worker uploads a full diff body through this route when the inline
// callback cannot carry it. The route raises the body limit for itself only.
const internalArtifactSchema = z.object({
  artifactId: z.string().min(1).max(160),
  kind: z.string().min(1).max(40).default("patch"),
  content: z.string().min(1).max(9_000_000),
  baseSha: z.string().max(80).optional(),
  ownerId: z.string().max(120).optional(),
}).strict();
const INTERNAL_ARTIFACT_BODY_LIMIT = 8 * 1024 * 1024;

// SEC-008 / AT-SEC-005: per-user write limits for credential and run mutations.
const credentialWrites = new RateLimiter(10);
const runCreations = new RateLimiter(Number(process.env.PI_RUN_CREATE_PER_MINUTE || 20));
const runActions = new RateLimiter(Number(process.env.PI_RUN_ACTIONS_PER_MINUTE || 30));

/** GAP-01: the budget that applied when the run was created (also shown in the UI). */
function readRunBudget() {
  return {
    maxTokens: Number(process.env.PI_RUN_MAX_TOKENS || 0),
    maxCostUsd: Number(process.env.PI_RUN_MAX_COST_USD || 0),
    maxModelCalls: Number(process.env.PI_RUN_MAX_MODEL_CALLS || 0),
    // 0 = 不限制（与 worker 语义一致）：缺省时不得隐式套用 1800s 上限。
    maxDurationSeconds: Number(process.env.PI_RUN_MAX_DURATION_SECONDS ?? process.env.PI_RUN_TIMEOUT_SECONDS ?? 0) || 0,
  };
}

/** GAP-01: credential version marker (never the credential itself). */
function credentialFingerprint(apiKey: string | undefined) {
  if (!apiKey) return undefined;
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** GAP-01: workflow/prompt/plugin policy snapshot. */
const PIPELINE_VERSION = process.env.PI_PIPELINE_VERSION || "pigo-pipeline-1";

/** Terminal run states (used for artifact persistence and cleanup). */
const TERMINAL_RUN_STATES = new Set<Run["state"]>(["completed", "needs_human", "failed", "cancelled"]);

/**
 * AUD-16 / AT-GIT-004, AT-UI-005: persist the unified diff reported for a run as
 * a downloadable artifact once the run reaches a terminal state. The body is the
 * exact patch the worker produced against the run's pinned base SHA; storing it
 * (instead of only length/hash) is what makes a full download possible.
 */
async function persistTerminalDiffArtifact(run: Run | undefined) {
  if (!run || !TERMINAL_RUN_STATES.has(run.state) || !run.diff) return;
  try {
    await store.saveArtifact({
      runId: run.id,
      artifactId: "diff",
      kind: "patch",
      content: run.diff,
      baseSha: run.baseSha ?? null,
      createdAt: run.updatedAt,
    });
  } catch (error) {
    app.log.warn({ runId: run.id, error: (error as Error).message }, "failed to persist diff artifact");
  }
}

/** AUD-16: download cap so one artifact can never be streamed without bound. */
const ARTIFACT_DOWNLOAD_MAX_BYTES = Number(process.env.PI_ARTIFACT_MAX_DOWNLOAD_BYTES || 5 * 1024 * 1024);

type RunPatchResolution =
  | { ok: true; selection: PatchSelection }
  | { ok: false; status: 409 | 503; code: string; error: string };

/**
 * A1: resolves the authoritative patch for a run. Prefers the stored artifact
 * (full body), falls back to the inline diff, and only then asks the worker to
 * regenerate it from the run directory the same way it does during execution.
 * A regenerated body is persisted so later downloads do not need the worker.
 */
async function resolveRunPatch(run: Run): Promise<RunPatchResolution> {
  const artifact = await store.getArtifact(run.id, "diff").catch(() => undefined);
  const direct = selectPatch({
    artifact: artifact
      ? { artifactId: artifact.artifactId, content: artifact.content, sha256: artifact.sha256, bytes: artifact.bytes }
      : undefined,
    runDiff: run.diff,
    baseSha: artifact?.baseSha ?? run.baseSha,
  });
  if (direct) return { ok: true, selection: direct };

  let generated: { diff?: string; baseSha?: string | null };
  try {
    generated = await workerRequest<{ diff?: string; baseSha?: string | null }>(`/runs/${encodeURIComponent(run.id)}/diff`, {
      method: "POST",
      body: JSON.stringify({ ownerId: run.ownerId, baseSha: run.baseSha, repository: run.repository }),
    });
  } catch (error) {
    return { ok: false, status: 503, code: "PATCH_UNAVAILABLE", error: `无法生成补丁：${(error as Error).message}` };
  }
  const selection = selectPatch({
    artifact: artifact
      ? { artifactId: artifact.artifactId, content: artifact.content, sha256: artifact.sha256, bytes: artifact.bytes }
      : undefined,
    runDiff: run.diff,
    worktreeDiff: generated.diff,
    baseSha: generated.baseSha ?? run.baseSha,
  });
  if (!selection) return { ok: false, status: 409, code: "PATCH_UNAVAILABLE", error: "该任务没有可导出的补丁" };
  if (selection.origin === "worktree") {
    await store
      .saveArtifact({ runId: run.id, artifactId: "diff", kind: "patch", content: selection.content, baseSha: selection.baseSha, createdAt: run.updatedAt })
      .catch((error) => app.log.warn({ runId: run.id, error: (error as Error).message }, "failed to persist regenerated diff artifact"));
  }
  return { ok: true, selection };
}

function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
}

function safeSecretMatch(value: string | undefined, secret: string) {
  if (!value || !secret) return false;
  const actual = Buffer.from(value.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeTokenMatch(value: string | undefined) {
  return safeSecretMatch(value, internalToken);
}

async function workerRequest<T>(pathName: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${workerUrl}${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Worker request failed: ${response.status}`);
  return body as T;
}

/**
 * GAP-04 storage follow-up: asks the worker to remove a finished run's on-disk
 * directory tree (standalone clone, sub-agent worktrees, reviewer snapshots and
 * the per-run Pi state directories). Best-effort by design: the caller shapes a
 * `kept` outcome instead of failing the cleanup request.
 */
const runDirectoryCleaner: RunDirectoryCleaner = ({ runId, ownerId, dryRun }) =>
  workerRequest(`/runs/${encodeURIComponent(runId)}/cleanup`, {
    method: "POST",
    body: JSON.stringify({ ownerId, dryRun }),
  });

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Cache-Control", "no-store");
  return payload;
});

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/") || request.url === "/api/health" || request.url.startsWith("/api/internal/")) return;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && publicOrigin) {
    const origin = request.headers.origin;
    if (origin && origin !== publicOrigin) return reply.code(403).send({ error: "Origin not allowed" });
  }
  const unauthorized = await auth.authenticate(request, reply);
  if (unauthorized) return unauthorized;
  const identity = auth.identity(request);
  const cacheKey = `${identity.issuer}|${identity.subject}`;
  const cached = userCache.get(cacheKey);
  if (cached) return auth.setUser(request, cached);
  const record = await identities.resolve({
    issuer: identity.issuer,
    subject: identity.subject,
    email: identity.email,
    identityProvider: identity.identityProvider,
    legacyOwnerId: identity.legacyOwnerId,
  });
  const user: CurrentUser = { id: record.id, email: record.email, legacyOwnerId: record.legacyOwnerId ?? undefined };
  userCache.set(cacheKey, user);
  auth.setUser(request, user);
});

function ownerKeysFor(request: FastifyRequest) {
  const user = auth.user(request);
  return user.legacyOwnerId ? [user.id, user.legacyOwnerId] : [user.id];
}

/** Narrows vault lookups into a complete credential pair or nothing. */
function requireCredentials(input: { developer?: string; reviewer?: string }): { developer: string; reviewer: string } | undefined {
  const { developer, reviewer } = input;
  if (!developer || !reviewer) return undefined;
  return { developer, reviewer };
}

/** Credentials written before the internal-user migration live under the legacy owner key. */
function vaultKeyFor(request: FastifyRequest) {
  const user = auth.user(request);
  return user.legacyOwnerId ?? user.id;
}

/** Bounded liveness ping: a frozen database must not hang the health probe. */
async function pingDatabase(timeoutMs = 2_500) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.query("SELECT 1"),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("database ping timeout")), timeoutMs);
      }),
    ]);
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.get("/api/health", async (_request, reply) => {
  try {
    await pingDatabase();
    alerts.clear("database_unavailable");
    return { status: "ok", service: "pigo-web", version: webVersion, db: "ok" };
  } catch (error) {
    // AT-REL-005: fail loudly instead of pretending the service is healthy.
    alerts.raise({
      key: "database_unavailable",
      severity: "critical",
      message: "数据库不可用，Web 已降级：运行/事件读写暂停",
      details: { error: (error as Error).message.slice(0, 200) },
    });
    return reply.code(503).send({ status: "degraded", service: "pigo-web", version: webVersion, db: "unavailable", code: "DATABASE_UNAVAILABLE" });
  }
});

interface StorageStatus {
  state: "ok" | "low" | "critical";
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
}

/** REL-006: one place to inspect database, queue, worker and disk health. */
app.get("/api/health/detail", async (request, reply) => {
  const internal = safeTokenMatch(request.headers.authorization);
  if (!internal && !auth.user(request)) return reply.code(401).send({ error: "Unauthorized" });
  const health: Record<string, unknown> = { version: webVersion, at: new Date().toISOString() };
  try {
    await pingDatabase();
    health.database = { status: "ok" };
    alerts.clear("database_unavailable");
  } catch (error) {
    health.database = { status: "unavailable", error: (error as Error).message.slice(0, 200) };
    alerts.raise({ key: "database_unavailable", severity: "critical", message: "数据库不可用", details: {} });
  }
  if (jobQueue) {
    try {
      const jobs = await jobQueue.listPendingJobs({ staleAfterMs: JOB_STALE_MS, limit: 50 });
      const stale = jobs.filter((job) => job.state === "claimed").length;
      health.queue = { pending: jobs.length, reclaimedFromDeadWorker: stale };
      if (jobs.length > 0 && stale > 0) {
        alerts.raise({ key: "queue_stale", severity: "warning", message: "存在因 Worker 中断而未完成的任务，正在等待重领", details: { count: stale } });
      }
    } catch (error) {
      health.queue = { status: "unavailable", error: (error as Error).message.slice(0, 200) };
    }
  }
  const worker = await workerRequest<{ activeJobs: number }>("/health").then((value) => value).catch(() => undefined);
  if (worker) {
    alerts.clear("worker_unreachable");
    const storage = await workerRequest<StorageStatus>("/health/storage").catch(() => undefined);
    health.worker = { status: "ok", activeJobs: worker.activeJobs, storage: storage ?? null };
    if (storage && storage.state !== "ok") {
      alerts.raise({
        key: `disk_${storage.state}`,
        severity: storage.state === "critical" ? "critical" : "warning",
        message: storage.state === "critical" ? "工作区磁盘空间严重不足，已停止接收新任务" : "工作区磁盘空间偏低",
        details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
      });
    }
  } else {
    health.worker = { status: "unreachable" };
    alerts.raise({ key: "worker_unreachable", severity: "critical", message: "无法连接 Worker，任务执行暂停", details: { workerUrl } });
  }
  health.alerts = alerts.activeKeys;
  return health;
});
app.get("/api/me", async (request): Promise<CurrentUser> => {
  const user = auth.user(request);
  return { ...user, isAdmin: await identities.isAdmin(user.id) };
});

// ---------------------------------------------------------------------------
// 账户管理 (account management) — admin only.
//
// The instance owner discovered their account was still `role: "user"` while
// merge refused with 403, so roles/statuses must be inspectable and manageable.
// Guardrails (no self role change, never lose the last active admin) live in
// `accounts.ts` and are unit-tested; every change appends a `user_audit` row.
// ---------------------------------------------------------------------------
const accountService = new AccountService(db);
const accountPatchSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((value) => value.role !== undefined || value.status !== undefined, { message: "至少需要提供 role 或 status" });
const accountGrantSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  permission: z.enum(["read", "write"]),
}).strict();

/** Returns the calling admin, or sends 403 and returns undefined. */
async function requireAccountAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = auth.user(request);
  const gate = accountAdminGate(await identities.isAdmin(user.id));
  if (!gate.allowed) {
    reply.code(gate.status).send({ error: gate.message, code: gate.code });
    return undefined;
  }
  return user;
}

function accountErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message, code: error.code });
  throw error;
}

app.get("/api/accounts", async (request, reply) => {
  if (!(await requireAccountAdmin(request, reply))) return reply;
  return { accounts: await accountService.list() };
});

// Registered before `/api/accounts/:id` so the static segment wins the match.
app.get("/api/accounts/workspaces", async (request, reply) => {
  if (!(await requireAccountAdmin(request, reply))) return reply;
  return { workspaces: await accountService.listWorkspaces() };
});

app.get<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
  if (!(await requireAccountAdmin(request, reply))) return reply;
  const account = await accountService.get(request.params.id);
  if (!account) return reply.code(404).send({ error: "账户不存在", code: "ACCOUNT_NOT_FOUND" });
  return account;
});

app.patch<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
  const actor = await requireAccountAdmin(request, reply);
  if (!actor) return reply;
  const parsed = accountPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await accountService.update(request.params.id, parsed.data, actor.id);
  } catch (error) {
    return accountErrorReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/accounts/:id/grants", async (request, reply) => {
  const actor = await requireAccountAdmin(request, reply);
  if (!actor) return reply;
  const parsed = accountGrantSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await accountService.setGrant(request.params.id, parsed.data, actor.id);
  } catch (error) {
    return accountErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string; workspaceId: string } }>("/api/accounts/:id/grants/:workspaceId", async (request, reply) => {
  const actor = await requireAccountAdmin(request, reply);
  if (!actor) return reply;
  try {
    return await accountService.removeGrant(request.params.id, request.params.workspaceId);
  } catch (error) {
    return accountErrorReply(reply, error);
  }
});

app.get("/api/credentials/status", async (request) => vault.status(vaultKeyFor(request)));

app.put("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  const credentialLimit = credentialWrites.check(user.id);
  if (!credentialLimit.allowed) return tooManyRequests(reply, credentialLimit.retryAfterMs);
  const parsed = credentialSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid credential request" });
  const userId = vaultKeyFor(request);
  const writes: Array<{ provider: string; apiKey: string }> = [];
  if (parsed.data.provider && parsed.data.apiKey) {
    writes.push({ provider: parsed.data.provider, apiKey: parsed.data.apiKey });
  } else {
    // Legacy role-based payloads map onto the configured role providers.
    if (parsed.data.developerApiKey) writes.push({ provider: modelDefaults.developer.provider, apiKey: parsed.data.developerApiKey });
    if (parsed.data.reviewerApiKey) writes.push({ provider: modelDefaults.reviewer.provider, apiKey: parsed.data.reviewerApiKey });
  }
  let status = vault.status(userId);
  for (const write of writes) {
    status = await vault.set(userId, write);
    // AUD-08 / AT-MODEL-004: verify the key against the provider before it can be
    // considered available. `PI_MODEL_PROBE_MODE=off` is the explicit opt-out for
    // providers without a reachable /models endpoint: it records an operator
    // assertion, never a fake verification.
    if (providerProbeDisabled()) {
      status = await vault.markOperatorAsserted(userId, write.provider);
      continue;
    }
    const probe = await providerProbe(write).catch(() => undefined);
    if (probe?.ok) {
      status = await vault.markVerified(userId, write.provider, probe.models, probe.capabilities ?? null);
    } else {
      status = await vault.markUnverified(userId, write.provider);
    }
  }
  return status;
});

app.delete<{ Querystring: { provider?: string } }>("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  const credentialLimit = credentialWrites.check(user.id);
  if (!credentialLimit.allowed) return tooManyRequests(reply, credentialLimit.retryAfterMs);
  await vault.delete(vaultKeyFor(request), request.query?.provider || undefined);
  return reply.code(204).send();
});

app.get("/api/models", async (request): Promise<ModelCatalogResponse> => {
  const availability = vault.providerAvailability(vaultKeyFor(request));
  return {
    models: availableModels(modelCatalog, availability),
    defaultDeveloper: modelDefaults.developer,
    defaultReviewer: modelDefaults.reviewer,
    // AUD-08 / AT-MODEL-001: surface the provider-reported verifiedModels,
    // the honest verification state (live vs operator-asserted) and the
    // runtime-reported per-model capabilities.
    verifiedProviders: availability.map((item) => ({
      provider: item.provider,
      verifiedAt: item.verifiedAt,
      verifiedModels: item.verifiedModels,
      verification: item.verification,
      asserted: item.asserted,
      verificationLabel: item.verification === "live" ? "已验证" : item.verification === "operator_asserted" ? "未校验（操作者断言）" : "未校验",
      capabilities: item.capabilities ?? null,
    })),
  };
});

app.get("/api/config/status", async (request): Promise<ConfigStatus> => {
  const credentials = vault.status(vaultKeyFor(request));
  const configured = new Set(credentials.providers.map((item) => item.provider));
  const releasePlan = planPostMergeDeploy(process.env.PI_POST_MERGE_DEPLOY_HOOK);
  // AUD-09 / AT-MODEL-006/007: execution availability is decoupled from the
  // default provider/credential pairing. As long as at least one provider is
  // configured the user may enter the real-run form; the actual per-role model
  // combination is preflighted when the run is created (AT-MODEL-008).
  return {
    demoMode,
    piVersion: process.env.PI_VERSION || "1.0.0",
    developer: { provider: modelDefaults.developer.provider, model: modelDefaults.developer.model, credentialConfigured: configured.has(modelDefaults.developer.provider) },
    reviewer: { provider: modelDefaults.reviewer.provider, model: modelDefaults.reviewer.model, credentialConfigured: configured.has(modelDefaults.reviewer.provider) },
    realRunsAvailable: realRunsEnabled && Boolean(internalToken) && configured.size > 0,
    configuredProviders: [...configured],
    verifiedProviders: credentials.providers.filter((item) => item.verification === "live").map((item) => item.provider),
    assertedProviders: credentials.providers.filter((item) => item.verification === "operator_asserted").map((item) => item.provider),
    // A1: only presence is exposed; the URL/token never reach the browser.
    mergeRequestConfigured: mergeRequestConfig.configured,
    releaseConfigured: releasePlan.configured
      && releasePlan.kind !== "unsupported"
      && (releasePlan.kind !== "webhook" || Boolean(releaseWebhookToken && publicOrigin)),
  };
});

/**
 * A3: read-only deployment status. The deploy log is read defensively: a missing
 * file reports `available: false` and an empty record list, never an error.
 */
async function readDeploymentStatus(): Promise<DeploymentStatus> {
  const logPath = resolveDeployLogPath(process.env);
  let records = [] as ReturnType<typeof parseDeployLog>;
  let logAvailable = false;
  let logError: string | undefined;
  try {
    const content = await readFile(logPath, "utf8");
    records = parseDeployLog(content);
    logAvailable = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") logError = (error as Error).message;
  }
  return buildDeploymentStatus({ env: process.env, records, logPath, logAvailable, logError });
}

app.get("/api/deployments", async () => readDeploymentStatus());

const SYSTEM_FAILURE_TYPE_PATTERNS = ["%storage_error%", "%budget_exhausted%", "%provider_error%", "%failure_artifact%"];

/**
 * SYS-01: system-wide, read-only status for the 「系统状态」 dashboard. Aggregates
 * are visible to any authenticated user, but only counts/timestamps/sanitised
 * summaries are returned — never credentials, environment values or paths.
 * Every query is bounded and each section degrades to `unavailable` on failure.
 */
app.get("/api/system/status", async (request) => {
  const now = new Date().toISOString();
  // B7: failure summaries are admin-only; every authenticated user still gets
  // the category counts (recent details are suppressed below).
  const audience: "admin" | "user" = (await identities.isAdmin(auth.user(request).id)) ? "admin" : "user";
  const [deployments, workerHealth] = await Promise.all([
    readDeploymentStatus().catch(() => null),
    workerRequest<{ activeJobs?: number; version?: string; storage?: string }>("/health", undefined, 3_000).catch(() => undefined),
  ]);

  let database: { status: "ok" | "unavailable"; error?: string } = { status: "unavailable" };
  try {
    await pingDatabase(2_000);
    database = { status: "ok" };
  } catch (error) {
    // Log the raw cause server-side; never echo it (it can carry host details).
    app.log.warn({ error: (error as Error).message.slice(0, 200) }, "system status database ping failed");
  }

  const storage = workerHealth?.storage === "ok" || workerHealth?.storage === "low" || workerHealth?.storage === "critical"
    ? workerHealth.storage
    : undefined;
  const infrastructure: SystemStatusInput["infrastructure"] = {
    database,
    worker: workerHealth
      ? {
          status: "ok",
          activeJobs: typeof workerHealth.activeJobs === "number" ? workerHealth.activeJobs : undefined,
          storage,
        }
      : { status: "unreachable" },
  };

  let jobStates: StateCountRow[] | null = null;
  let runStates: StateCountRow[] | null = null;
  let todayRuns: TodayRunRow[] | null = null;
  let failures: FailureEventRow[] | null = null;
  try {
    const jobs = await db.query("SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at FROM jobs GROUP BY state");
    jobStates = jobs.rows as unknown as StateCountRow[];
  } catch (error) {
    app.log.warn({ error: (error as Error).message.slice(0, 200) }, "system status job aggregation failed");
  }
  try {
    const runs = await db.query("SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at FROM runs GROUP BY state");
    runStates = runs.rows as unknown as StateCountRow[];
  } catch (error) {
    app.log.warn({ error: (error as Error).message.slice(0, 200) }, "system status run aggregation failed");
  }
  try {
    const usage = await db.query(`SELECT document_json FROM runs WHERE updated_at >= $1 LIMIT ${USAGE_RUN_SCAN_LIMIT}`, [utcDayStart(now)]);
    todayRuns = usage.rows as unknown as TodayRunRow[];
  } catch (error) {
    app.log.warn({ error: (error as Error).message.slice(0, 200) }, "system status usage aggregation failed");
  }
  try {
    const events = await db.query(
      `SELECT at, type, message FROM run_events WHERE at >= $1 AND (type LIKE $2 OR type LIKE $3 OR type LIKE $4 OR type LIKE $5) ORDER BY at DESC LIMIT ${FAILURE_SCAN_LIMIT}`,
      [new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString(), ...SYSTEM_FAILURE_TYPE_PATTERNS],
    );
    failures = events.rows as unknown as FailureEventRow[];
  } catch (error) {
    app.log.warn({ error: (error as Error).message.slice(0, 200) }, "system status failure aggregation failed");
  }

  // Only the worker reports its own version over HTTP; fall back to the
  // deployment configuration and otherwise leave it unknown (`null`).
  const workerVersion = typeof workerHealth?.version === "string" && workerHealth.version.trim()
    ? workerHealth.version.trim()
    : (process.env.PI_WORKER_VERSION?.trim() || null);

  // Reuse the deployment payload but drop the deploy-log path: this response is
  // path-free by contract (the dedicated `/api/deployments` endpoint keeps it).
  const deploymentInfo: DeploymentInfo | null = deployments
    ? {
        web: deployments.web,
        worker: deployments.worker,
        rollbackTags: deployments.rollbackTags,
        records: deployments.records,
        // `error` is omitted too: file-read errors can embed the log path.
        log: { available: deployments.log.available },
        at: deployments.at,
      }
    : null;

  return buildSystemStatus({
    now,
    audience,
    versions: { web: deployments?.web.version ?? null, worker: workerVersion },
    infrastructure,
    jobStates,
    runStates,
    todayRuns,
    failures,
    deployments: deploymentInfo,
  });
});

app.get("/api/projects", async (request, reply) => {
  // AUD-02: the legacy global project listing is owner scoped (admins see all).
  const admin = await identities.isAdmin(auth.user(request).id);
  if (!realRunsEnabled) return reply.code(503).send({ error: "Real runs are disabled" });
  try {
    const projects = await workerRequest<Array<{ relativePath: string }>>("/projects");
    if (admin) return projects;
    const allowed = new Set((await workspaces.list(ownerKeysFor(request))).map((item) => item.rootPath));
    return projects.filter((project) => allowed.has(project.relativePath) || allowed.has(project.relativePath.replace(/^\/+/, "")));
  } catch (error) {
    return reply.code(503).send({ error: `Worker unavailable: ${(error as Error).message}` });
  }
});

const workspaceRegisterSchema = z.object({ relativePath: z.string().trim().min(1).max(240) });
const workspaceCloneSchema = z.object({ url: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(80) });
const workspaceCreateSchema = z.object({ name: z.string().trim().min(1).max(80) });
const workspacePatchSchema = z.object({
  defaultChecks: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
}).strict();

function workspacesDisabled(reply: FastifyReply) {
  return reply.code(503).send({ error: "Workspaces are disabled", code: "WORKSPACES_DISABLED" });
}

function isStorageFailure(message: string) {
  return /ECONNREFUSED|Connection terminated|connection is closed|connection timeout|ETIMEDOUT|terminating connection|57P0|no space left on device|ENOSPC|STORAGE_UNAVAILABLE/i.test(message);
}

/** Maps a WorkspaceError / storage failure to an HTTP status + body (shared by
 * the workspace routes and the run-preflight, which must not touch `reply`). */
function classifyWorkspaceError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof WorkspaceError) return { status: error.status, body: { error: error.message, code: error.code } };
  const message = (error as Error)?.message ?? String(error);
  // AT-REL-005: a database outage is reported as storage degradation, not as a
  // confusing workspace error.
  if (isStorageFailure(message)) {
    alerts.raise({ key: "storage_failure", severity: "critical", message: "存储不可用：工作区操作无法完成", details: { error: message.slice(0, 200) } });
    return { status: 503, body: { error: `存储不可用：${message.slice(0, 200)}`, code: "STORAGE_UNAVAILABLE" } };
  }
  return { status: 503, body: { error: `Workspace operation failed: ${message}` } };
}

function workspaceErrorReply(reply: FastifyReply, error: unknown) {
  const { status, body } = classifyWorkspaceError(error);
  return reply.code(status).send(body);
}

app.get("/api/workspaces", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  return { workspaces: await workspaces.list(ownerKeysFor(request)) };
});

app.post("/api/workspaces/register", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  const parsed = workspaceRegisterSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    // AUD-02: only the owner (or an admin) may claim a physical repository path.
    const isAdmin = await identities.isAdmin(auth.user(request).id);
    return reply.code(201).send(await workspaces.register(auth.user(request).id, parsed.data.relativePath, { isAdmin }));
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.post("/api/workspaces/clone", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  const parsed = workspaceCloneSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await workspaces.clone(auth.user(request).id, parsed.data.url, parsed.data.name));
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

// Creates the directory on the worker host (under its projects root) and then
// registers it, so an operator never has to shell into the worker container.
app.post("/api/workspaces/create", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  const parsed = workspaceCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await workspaces.create(auth.user(request).id, parsed.data.name));
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    return await workspaces.get(ownerKeysFor(request), request.params.id, { isAdmin: await identities.isAdmin(auth.user(request).id) });
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/workspaces/:id/refresh", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    // B4: refreshing git metadata mutates stored state, so a read grant is refused.
    return await workspaces.refresh(ownerKeysFor(request), request.params.id, { isAdmin: await identities.isAdmin(auth.user(request).id) });
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  const parsed = workspacePatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await workspaces.patch(ownerKeysFor(request), request.params.id, parsed.data, { isAdmin: await identities.isAdmin(auth.user(request).id) });
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    // B4: only the owner, an admin or a write grant may unregister.
    await workspaces.unregister(ownerKeysFor(request), request.params.id, { isAdmin: await identities.isAdmin(auth.user(request).id) });
    return reply.code(204).send();
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

// ------------------------------------------------ Sprint 3: agile domain
// Planning layer on top of the Run. `/api/projects` is already the legacy
// global worker listing, so the new owner-scoped project CRUD lives under
// `/api/agile/projects`; stories/sprints/releases use their own namespaces.
function agileErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AgileError) return reply.code(error.status).send({ error: error.message, code: error.code });
  return workspaceErrorReply(reply, error);
}

/**
 * Sprint 3 write-back helper: after a run mutation, converge the derived status
 * of every story linked to it. A run that just reached a terminal state also
 * releases any run-level story block it held (a terminal run must not deadlock
 * the board) and records why as a run event. Never throws — a planning-table
 * hiccup must not break the run route that triggered it.
 */
async function reconcileStoryForRun(runId: string) {
  try {
    const run = store.getRun(runId);
    if (run && releasesStoryBlocks(run.state)) {
      const released = await agile.releaseStoryBlocksForTerminalRun(runId, run.state);
      if (released.length > 0) {
        await store.appendEvent({
          runId,
          round: run.round,
          source: "system",
          type: "run.story_blocks_released",
          message: storyBlockReleaseNote(run.state),
          at: new Date().toISOString(),
          meta: { state: run.state, storyIds: released },
        });
      }
    }
    await agile.reconcileRun(runId);
  } catch (error) {
    app.log.warn({ error: (error as Error).message, runId }, "story status reconcile failed");
  }
}

app.get("/api/agile/projects", async (request, reply) => {
  try {
    return { projects: await agile.listProjects(ownerKeysFor(request)) };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post("/api/agile/projects", async (request, reply) => {
  const parsed = projectCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await agile.createProject(auth.user(request).id, parsed.data));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.get<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
  try {
    return await agile.getProject(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
  const parsed = projectPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await agile.updateProject(ownerKeysFor(request), request.params.id, parsed.data, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
  try {
    await agile.deleteProject(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
    return reply.code(204).send();
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.get<{ Querystring: { projectId?: string; sprintId?: string; status?: string } }>("/api/stories", async (request, reply) => {
  const filter: { projectId?: string; sprintId?: string | null; status?: StoryDetail["status"] } = {};
  if (request.query.projectId) filter.projectId = request.query.projectId;
  if (request.query.sprintId) filter.sprintId = request.query.sprintId;
  if (request.query.status) filter.status = request.query.status as StoryDetail["status"];
  try {
    return { stories: await agile.listStories(ownerKeysFor(request), filter) };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post("/api/stories", async (request, reply) => {
  const parsed = storyCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await agile.createStory(auth.user(request).id, parsed.data));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// Story detail reconciles the derived status from the latest linked run first.
app.get<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
  try {
    return await agile.getStory(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
  const parsed = storyPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await agile.updateStory(ownerKeysFor(request), request.params.id, parsed.data, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
  try {
    await agile.deleteStory(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
    return reply.code(204).send();
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// Kanban blocked-management: manual block/unblock on a story. A manual block
// wins over the derived in-progress/review status until unblocked; a run that is
// still parked cannot be unblocked from here (409 BLOCKED_BY_RUN).
app.post<{ Params: { id: string } }>("/api/stories/:id/block", async (request, reply) => {
  const parsed = storyBlockSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "标记阻塞需要填写原因", code: "BLOCK_REASON_REQUIRED", details: parsed.error.issues });
  const user = auth.user(request);
  try {
    return await agile.blockStory(ownerKeysFor(request), request.params.id, parsed.data.reason, user.id, await identities.isAdmin(user.id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/stories/:id/unblock", async (request, reply) => {
  const user = auth.user(request);
  try {
    return await agile.unblockStory(ownerKeysFor(request), request.params.id, await identities.isAdmin(user.id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// Reopen a story whose latest run is a terminal failed/cancelled run: it goes
// back to `ready` so it can be submitted again. This is the explicit human path
// for a stuck (or manually blocked) story and never silently lifts a manual
// block: 409 with the run id while the latest run is live or needs_human, 409
// BLOCKED_BY_MANUAL on a manual block, 409 STORY_NOT_REOPENABLE once delivered.
// The reopen is audited on the latest run (`story.reopened`). See docs/19.
app.post<{ Params: { id: string } }>("/api/stories/:id/reopen", async (request, reply) => {
  const user = auth.user(request);
  try {
    const result = await agile.reopenStory(ownerKeysFor(request), request.params.id, await identities.isAdmin(user.id));
    if (result.runId) {
      const run = store.getRun(result.runId);
      await store.appendEvent({
        runId: result.runId,
        round: run?.round ?? 0,
        source: "system",
        type: "story.reopened",
        message: `故事「${result.story.title}」已重新打开为就绪（原状态 ${STORY_STATUS_LABELS[result.previousStatus]}）`,
        at: new Date().toISOString(),
        meta: { storyId: result.story.id, actorId: user.id, previousStatus: result.previousStatus },
      });
    }
    return result.story;
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// Submit a story as a run. Only a `ready` story may be submitted; the run's
// task carries the description + acceptance criteria + definition of done.
app.post<{ Params: { id: string } }>("/api/stories/:id/runs", async (request, reply) => {
  const parsed = storySubmitSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  const creationLimit = runCreations.check(user.id);
  if (!creationLimit.allowed) return tooManyRequests(reply, creationLimit.retryAfterMs);
  const isAdmin = await identities.isAdmin(user.id);
  let story: StoryDetail;
  try {
    story = await agile.getStory(ownerKeysFor(request), request.params.id, isAdmin);
  } catch (error) {
    return agileErrorReply(reply, error);
  }
  if (story.status !== "ready") {
    return reply.code(409).send({ error: "只有「就绪」状态的故事可以提交为运行", code: "STORY_NOT_READY", status: story.status });
  }
  const workspaceId = parsed.data.workspaceId ?? story.workspaceId ?? undefined;
  // Checks default to the workspace's registered commands.
  let defaultChecks: string[] = [];
  if (workspaceId) {
    try {
      defaultChecks = (await workspaces.get(ownerKeysFor(request), workspaceId, { isAdmin })).defaultChecks;
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  }
  const input = buildStoryRunInput(story, { checks: parsed.data.checks ?? defaultChecks, workspaceId });

  if (parsed.data.mode === "demo") {
    if (!demoMode) return reply.code(403).send({ error: "Demo mode is disabled" });
    const run = baseDemoRun({ title: input.title, task: input.task, repository: "demo/agile-story" }, user.id);
    run.storyId = story.id;
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "已从用户故事创建演示任务", at: new Date().toISOString() });
    void runDemo(store, run.id);
    await agile.linkRun(story.id, run.id);
    await agile.markStoryInProgress(story.id);
    return reply.code(201).send({ run: store.getRun(run.id, user.id), story: await agile.getStory(ownerKeysFor(request), story.id, isAdmin) });
  }

  if (!workspaceId) return reply.code(422).send({ error: "真实运行需要指定工作区（故事或请求中的 workspaceId）", code: "STORY_WORKSPACE_REQUIRED" });
  if (input.checks.length === 0) return reply.code(422).send({ error: "真实运行需要至少一个检查命令（工作区默认检查或请求中的 checks）", code: "STORY_CHECKS_REQUIRED" });
  const runParsed = createRunSchema.safeParse({
    title: input.title,
    task: input.task,
    repository: "pending-workspace",
    workspaceId,
    mode: "real",
    checks: input.checks,
    acceptanceCriteria: input.acceptanceCriteria,
    idempotencyKey: parsed.data.idempotencyKey,
    developerModel: input.developerModel,
    reviewerModel: input.reviewerModel,
  });
  if (!runParsed.success) return reply.code(422).send({ error: "故事无法生成合法运行", details: runParsed.error.issues });
  const result = await startRealRun(request, runParsed.data, {
    budget: story.budget ?? undefined,
    maxParallel: story.maxParallel ?? undefined,
    storyId: story.id,
  });
  if (result.run) {
    await agile.linkRun(story.id, result.run.id);
    if (result.ok) await agile.markStoryInProgress(story.id);
    else await agile.reconcileRun(result.run.id);
  }
  if (!result.ok) return reply.code(result.status).send({ ...result.body, storyId: story.id });
  return reply.code(201).send({ run: store.getRun(result.run.id, user.id), story: await agile.getStory(ownerKeysFor(request), story.id, isAdmin) });
});

app.get<{ Querystring: { projectId?: string } }>("/api/sprints", async (request, reply) => {
  try {
    return { sprints: await agile.listSprints(ownerKeysFor(request), request.query.projectId) };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post("/api/sprints", async (request, reply) => {
  const parsed = sprintCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await agile.createSprint(auth.user(request).id, parsed.data));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/sprints/:id", async (request, reply) => {
  const parsed = sprintPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await agile.updateSprint(ownerKeysFor(request), request.params.id, parsed.data, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/sprints/:id", async (request, reply) => {
  try {
    await agile.deleteSprint(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
    return reply.code(204).send();
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.get<{ Querystring: { projectId?: string } }>("/api/releases", async (request, reply) => {
  try {
    return { releases: await agile.listReleases(ownerKeysFor(request), request.query.projectId) };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post("/api/releases", async (request, reply) => {
  const parsed = releaseCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await agile.createRelease(auth.user(request).id, parsed.data));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/releases/:id", async (request, reply) => {
  const parsed = releasePatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await agile.updateRelease(ownerKeysFor(request), request.params.id, parsed.data, await identities.isAdmin(auth.user(request).id));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/releases/:id", async (request, reply) => {
  try {
    await agile.deleteRelease(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
    return reply.code(204).send();
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

/**
 * Release publish action (Sprint 5). Owner-scoped. Guards: the release must have
 * ≥1 story and none of its (reconciled) stories may be blocked — those answer
 * 409 RELEASE_EMPTY / RELEASE_BLOCKED. Without `confirm` this is a dry-run
 * preview so the UI can render the confirmation dialog; with `confirm` the
 * release is marked `released` and, when PI_POST_MERGE_DEPLOY_HOOK is configured,
 * the same deploy transport as run publish (`executeRelease`) is invoked and its
 * outcome recorded on the release + audit row (never silently skipped).
 */
app.post<{ Params: { id: string } }>("/api/agile/releases/:id/publish", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const parsed = releasePublishSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  const isAdmin = await identities.isAdmin(user.id);
  try {
    const release = await agile.getRelease(ownerKeysFor(request), request.params.id, isAdmin);
    if (release.status === "released") return reply.code(409).send({ error: "发布已发布，不可重复发布", code: "RELEASE_RELEASED" });
    const stories = await agile.collectReleaseStories(ownerKeysFor(request), release, isAdmin);
    const plan = planReleasePublish({ stories, label: `发布「${release.version} ${release.name}」` });
    if (plan.kind !== "ready") {
      return reply.code(plan.status).send({
        error: plan.message,
        code: plan.code,
        ...(plan.kind === "blocked" ? { blocked: plan.blocked } : {}),
      });
    }
    if (!parsed.data.confirm) return { published: false, release, stories };

    const deployPlan = planPostMergeDeploy(process.env.PI_POST_MERGE_DEPLOY_HOOK);
    if (deployPlan.configured && deployPlan.kind === "webhook" && !releaseWebhookToken) {
      return reply.code(409).send({ error: "Webhook 发布必须配置 PI_POST_MERGE_DEPLOY_TOKEN", code: "RELEASE_AUTH_NOT_CONFIGURED" });
    }
    const releasedAt = new Date().toISOString();
    const execution = await executeRelease(
      deployPlan,
      buildReleaseDeployPayload({ release, stories, releasedAt, releasedBy: user.id, note: parsed.data.note }),
      { deliveryId: `release-publish:${release.id}`, webhookToken: releaseWebhookToken || undefined },
    );
    const deploy = shapeReleaseDeployOutcome(deployPlan, execution, new Date().toISOString());
    const published = await agile.publishRelease(
      ownerKeysFor(request),
      release.id,
      { releasedBy: user.id, releasedAt, note: parsed.data.note, deploy, stories },
      isAdmin,
    );
    return { published: true, release: published, deploy };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

/**
 * Sprint 4 core: release summary + retrospective export. Both are read-only,
 * owner-scoped projections of the release's stories and their linked runs. An
 * unknown/foreign release answers a 404 (`RELEASE_NOT_FOUND`) exactly like the
 * release CRUD routes, never a 500.
 */
app.get<{ Params: { id: string } }>("/api/agile/releases/:id/summary", async (request, reply) => {
  try {
    const summary = await readReleaseSummary(db, ownerKeysFor(request), request.params.id);
    if (!summary) return reply.code(404).send({ error: "RELEASE_NOT_FOUND", message: "发布不存在" });
    return summary;
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.get<{ Params: { id: string } }>("/api/agile/releases/:id/retrospective", async (request, reply) => {
  try {
    const retrospective = await readReleaseRetrospective(db, ownerKeysFor(request), request.params.id);
    if (!retrospective) return reply.code(404).send({ error: "RELEASE_NOT_FOUND", message: "发布不存在" });
    return retrospective;
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

/**
 * Sprint 4 core: read-only, owner-scoped sprint metrics + project rollup.
 * Optional `?projectId=` / `?sprintId=` narrow the scope; empty scopes return
 * explicit zeros (never a 500). The heavy lifting is `readAgileMetrics`.
 */
app.get<{ Querystring: { projectId?: string; sprintId?: string } }>("/api/agile/metrics", async (request, reply) => {
  try {
    return await readAgileMetrics(db, ownerKeysFor(request), {
      projectId: request.query.projectId,
      sprintId: request.query.sprintId,
    });
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// Sprint 4: owner-scoped saved model combinations ("模板"). Lightweight CRUD;
// nothing is seeded, and the same name may be reused by a different owner.
app.get("/api/templates", async (request, reply) => {
  try {
    return { templates: await agile.listTemplates(ownerKeysFor(request)) };
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.post("/api/templates", async (request, reply) => {
  const parsed = templateCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return reply.code(201).send(await agile.createTemplate(auth.user(request).id, parsed.data));
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
  try {
    await agile.deleteTemplate(ownerKeysFor(request), request.params.id, await identities.isAdmin(auth.user(request).id));
    return reply.code(204).send();
  } catch (error) {
    return agileErrorReply(reply, error);
  }
});

// 需求历史: `?query=` is a case-insensitive substring over title/task/human
// notes and `?state=` filters by run state; both are optional so callers that
// omit them get the unchanged owner-scoped, newest-first list. Filtering runs
// over that owner-scoped list with no additional pagination (the list is
// already bounded to one owner and rendered client-side).
app.get<{ Querystring: { query?: string; state?: string } }>("/api/runs", async (request, reply) => {
  const parsed = parseRunSearch(request.query ?? {});
  if (!parsed.ok) return reply.code(400).send({ error: "Invalid request", details: [{ message: parsed.error }] });
  return searchRuns(store.listRuns(ownerKeysFor(request)), parsed.filter);
});

app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  let run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  // B1: a run whose worker merge succeeded but whose record write failed carries
  // a `committed_unrecorded` marker; converge it on read so the database never
  // stays silent about an already-merged workspace.
  if (run.mergePending) {
    run = (await replayPendingMerge(store, run.id)) ?? run;
  }
  return run;
});

app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/api/runs/:id/events", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  const limit = Math.min(Math.max(Number(request.query.limit || 500), 1), 1_000);
  return store.getEvents(request.params.id, Number(request.query.after || 0), limit);
});

/**
 * 拓扑轮次模型: read-only, owner-scoped per-round summary aggregated from the
 * run's full `run_events` + `run_findings`. The client topology uses it as the
 * source of truth for its round model so branches older than the buffered event
 * window still render. Additive: absent on older servers, where the client falls
 * back to its event-derived model.
 */
app.get<{ Params: { id: string } }>("/api/runs/:id/rounds", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return { schemaVersion: ROUNDS_SCHEMA_VERSION, rounds: await readRunRounds(db, run.id, run.round) };
});

/**
 * Decision Brief (docs/22): a read-only, owner-scoped answer to the only
 * question a parked run raises — accept the delivery or keep developing?
 * Assembled from existing tables/events only (stoppage, findings, checks, diff
 * headers, story AC/DoD); all judgement lives in the shared pure function, so
 * the model never participates. Same auth/ownership as the run-detail route.
 */
app.get<{ Params: { id: string } }>("/api/runs/:id/decision-brief", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return readDecisionBrief(db, run);
});

// GAP-04 / AT-UI-005: artifact listing and download, authenticated like every
// other run route and owner-scoped via ownerKeysFor.
app.get<{ Params: { id: string } }>("/api/runs/:id/artifacts", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  return { artifacts: await store.listArtifacts(request.params.id) };
});

app.get<{ Params: { id: string; artifactId: string } }>("/api/runs/:id/artifacts/:artifactId/download", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const artifact = await store.getArtifact(request.params.id, request.params.artifactId);
  // A run with a diff but no stored body (legacy/demo) still downloads the preview.
  const content = artifact?.content ?? (request.params.artifactId === "diff" ? run.diff : undefined);
  if (content === undefined) return reply.code(404).send({ error: "Artifact not found" });
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ARTIFACT_DOWNLOAD_MAX_BYTES) {
    return reply.code(413).send({ error: `制品过大（${bytes} 字节），超过下载上限 ${ARTIFACT_DOWNLOAD_MAX_BYTES} 字节`, code: "ARTIFACT_TOO_LARGE" });
  }
  const kind = artifact?.kind ?? "patch";
  const contentType = kind === "patch" ? "text/x-patch; charset=utf-8" : "application/octet-stream";
  const extension = kind === "patch" ? "patch" : "txt";
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", `attachment; filename="${run.id}-${request.params.artifactId}.${extension}"`);
  return reply.send(content);
});

/**
 * A1: download the run's full patch as a `.patch` file. Reuses the stored diff
 * artifact; when no artifact body exists, the worker regenerates it from the run
 * directory. Never returns an empty or silently-truncated patch.
 */
app.get<{ Params: { id: string } }>("/api/runs/:id/patch", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const resolved = await resolveRunPatch(run);
  if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error, code: resolved.code });
  if (resolved.selection.bytes > ARTIFACT_DOWNLOAD_MAX_BYTES) {
    return reply.code(413).send({ error: `补丁过大（${resolved.selection.bytes} 字节），超过下载上限`, code: "PATCH_TOO_LARGE" });
  }
  reply.header("Content-Type", "text/x-patch; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${patchFileName(run.id)}"`);
  return reply.send(resolved.selection.content);
});

/**
 * A1: open a merge request through the configured `PI_MERGE_REQUEST_*` webhook.
 * When the feature is not configured the route refuses clearly with 409
 * MERGE_REQUEST_NOT_CONFIGURED (it is never silently skipped).
 */
app.post<{ Params: { id: string } }>("/api/runs/:id/merge-request", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (!mergeRequestConfig.configured) {
    const refusal = mergeRequestUnavailable(mergeRequestConfig);
    return reply.code(refusal.status).send({ error: refusal.message, code: refusal.code });
  }
  const resolved = await resolveRunPatch(run);
  if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error, code: resolved.code });

  const workspaceDefault = run.workspaceId
    ? await workspaces.get(ownerKeysFor(request), run.workspaceId).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
    : undefined;
  const payload = buildMergeRequestPayload({
    run,
    patch: resolved.selection,
    targetBranch: mergeRequestConfig.targetBranch ?? workspaceDefault,
    project: mergeRequestConfig.project,
    requestedBy: auth.user(request).id,
  });
  try {
    const response = await fetch(mergeRequestConfig.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(mergeRequestConfig.token ? { Authorization: `Bearer ${mergeRequestConfig.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; url?: unknown; id?: unknown; number?: unknown };
    if (!response.ok) {
      return reply.code(502).send({ error: `合并请求创建失败：${String(body.error ?? response.status).slice(0, 200)}`, code: "MERGE_REQUEST_FAILED" });
    }
    const mergeRequest = {
      url: typeof body.url === "string" ? body.url : null,
      id: typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : null,
      number: typeof body.number === "string" || typeof body.number === "number" ? String(body.number) : null,
    };
    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: "run.merge_requested",
      message: "已创建合并请求",
      at: new Date().toISOString(),
      meta: { ...mergeRequest, patchSha256: resolved.selection.sha256, patchBytes: resolved.selection.bytes },
    });
    return { ok: true, mergeRequest };
  } catch (error) {
    return reply.code(502).send({ error: `合并请求创建失败：${(error as Error).message.slice(0, 200)}`, code: "MERGE_REQUEST_FAILED" });
  }
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/stream", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  const after = Number(request.headers["last-event-id"] || request.query.after || 0);
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  // AUD-17 / AT-UI-006: subscribe first, replay to a watermark, dedupe by seq.
  // Backpressure policy: a per-connection queue cap closes the stream as
  // `overflow`; the browser EventSource reconnects with `Last-Event-ID` and the
  // next connection resumes from the watermark, so no event is silently lost.
  const stream = new RunEventStream({
    runId: request.params.id,
    cursor: Number.isFinite(after) ? Math.max(0, after) : 0,
    subscribe: (listener) => store.subscribe(request.params.id, listener),
    fetchPage: (cursor, limit) => store.getEvents(request.params.id, cursor, limit),
    send: (event) => reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
    bufferedBytes: () => reply.raw.writableLength,
    heartbeat: () => reply.raw.write(": heartbeat\n\n"),
    close: (reason, detail) => {
      try {
        if (reason === "overflow") reply.raw.write(`event: pigo.overflow\ndata: ${JSON.stringify({ reason, detail })}\n\n`);
      } catch {
        // The socket is already gone; ending below is best effort.
      }
      reply.raw.end();
    },
    log: (message, detail) => app.log.warn({ ...detail, runId: request.params.id }, message),
  });
  const onDrain = () => stream.resume();
  reply.raw.on("drain", onDrain);
  request.raw.on("close", () => {
    reply.raw.off("drain", onDrain);
    stream.stop();
  });
  try {
    await stream.start();
  } catch (error) {
    app.log.error({ error: (error as Error).message, runId: request.params.id }, "event stream failed");
    stream.stop();
    reply.raw.end();
  }
});

/**
 * Extra (non-client) run inputs used when a story is submitted as a run.
 * Additive: `POST /api/runs` passes none of these, so its behaviour is
 * unchanged.
 */
type RealRunExtra = { budget?: RunBudget; maxParallel?: number; storyId?: string };

type RealRunResult =
  | { ok: true; created: boolean; run: Run }
  | { ok: false; status: number; body: Record<string, unknown>; run?: Run };

/**
 * Real-run creation core shared by `POST /api/runs` and
 * `POST /api/stories/:id/runs`: workspace preflight, model/credential checks,
 * idempotency, run persistence and worker dispatch. Pure refactor of the
 * previously inline route code; it returns a result instead of touching `reply`
 * so both routes render the same errors and the story route can still link a run
 * whose dispatch failed.
 */
async function startRealRun(
  request: FastifyRequest,
  input: z.infer<typeof createRunSchema>,
  extra: RealRunExtra = {},
): Promise<RealRunResult> {
  const user = auth.user(request);
  // WS-008: real runs may only target the user's own registered, healthy workspaces.
  // B4: a read grant may start a run against a shared workspace, so the
  // preflight refresh is allowed for read access too (the general refresh route
  // still requires write).
  let workspace: Workspace;
  try {
    workspace = await workspaces.refresh(ownerKeysFor(request), input.workspaceId!, { isAdmin: await identities.isAdmin(user.id), allowRead: true });
  } catch (error) {
    const { status, body } = classifyWorkspaceError(error);
    return { ok: false, status, body };
  }
  if (workspace.git?.dirty) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "工作区存在未提交修改，请先提交或清理后再创建真实任务",
        code: "WORKSPACE_DIRTY",
        dirtyFiles: workspace.git.dirtyFiles,
      },
    };
  }
  if (!realRunsEnabled || !internalToken) return { ok: false, status: 503, body: { error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" } };

  // AT-REL-010: stop accepting new work when the workspace disk is critical.
  const storage = await workerRequest<StorageStatus>("/health/storage").catch(() => undefined);
  if (storage && storage.state === "critical") {
    alerts.raise({
      key: "disk_critical",
      severity: "critical",
      message: "工作区磁盘空间严重不足，已停止接收新任务",
      details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
    });
    return {
      ok: false,
      status: 507,
      body: {
        error: `磁盘空间不足（剩余 ${Math.round(storage.freeBytes / 1024 / 1024)} MB），已停止接收新任务`,
        code: "DISK_FULL",
      },
    };
  }
  if (storage && storage.state === "low") {
    alerts.raise({
      key: "disk_low",
      severity: "warning",
      message: "工作区磁盘空间偏低，请清理后继续",
      details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
    });
  }

  // AUD-08 / AT-MODEL-008 + AUD-09 / AT-MODEL-007: preflight the exact
  // provider/model combination for every role the run will use (planner and
  // developer share the developer selection; reviewer has its own) before
  // queueing. A single provider that serves both roles is enough.
  const availability = vault.providerAvailability(vaultKeyFor(request));
  const selections = {
    developer: input.developerModel ?? modelDefaults.developer,
    reviewer: input.reviewerModel ?? modelDefaults.reviewer,
  };
  const preflight = preflightRunModels(modelCatalog, selections, availability);
  if (!preflight.ok) return { ok: false, status: 422, body: { error: preflight.message, code: preflight.code, role: preflight.role } };
  const developerEntry = preflight.roles.developer;
  const reviewerEntry = preflight.roles.reviewer;

  const credentials = requireCredentials({
    developer: vault.get(vaultKeyFor(request), developerEntry.provider),
    reviewer: vault.get(vaultKeyFor(request), reviewerEntry.provider),
  });
  if (!credentials) {
    return { ok: false, status: 403, body: { error: "所选模型的 provider 凭据不完整，请在「模型与凭据」页配置", code: "PERSONAL_CREDENTIALS_REQUIRED" } };
  }
  // GAP-01 / AT-RUN-010: an idempotency key returns the existing run instead of
  // creating a duplicate.
  if (input.idempotencyKey) {
    const existing = store.listRuns(ownerKeysFor(request)).find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) return { ok: true, created: false, run: existing };
  }
  const run = baseRealRun({
    ...input,
    repository: workspace.rootPath,
    workspaceId: workspace.id,
    developerModel: { provider: developerEntry.provider, model: developerEntry.model },
    reviewerModel: { provider: reviewerEntry.provider, model: reviewerEntry.model },
  }, user.id);
  // GAP-01: freeze the reproducible inputs with the run.
  run.baseSha = workspace.git?.head ?? undefined;
  run.budget = extra.budget ?? readRunBudget();
  run.pipelineVersion = PIPELINE_VERSION;
  run.credentialVersions = {
    developer: credentialFingerprint(vault.get(vaultKeyFor(request), developerEntry.provider)),
    reviewer: credentialFingerprint(vault.get(vaultKeyFor(request), reviewerEntry.provider)),
  };
  if (extra.storyId) run.storyId = extra.storyId;
  if (extra.maxParallel !== undefined) run.maxParallel = extra.maxParallel;
  await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "真实任务已创建，正在交给隔离 Pi Worker", at: new Date().toISOString() });
  try {
    await dispatchJob(run, input.checks, {}, credentials);
    credentials.developer = "";
    credentials.reviewer = "";
    return { ok: true, created: true, run };
  } catch (error) {
    credentials.developer = "";
    credentials.reviewer = "";
    await store.updateRun(run.id, { state: "failed", summary: (error as Error).message });
    await store.appendEvent({ runId: run.id, round: 1, source: "system", type: "run.failed", message: `Worker 拒绝任务：${(error as Error).message}`, at: new Date().toISOString() });
    return { ok: false, status: 503, body: { error: (error as Error).message, runId: run.id }, run };
  }
}

app.post("/api/runs", async (request, reply) => {
  const parsed = createRunSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  const creationLimit = runCreations.check(user.id);
  if (!creationLimit.allowed) return tooManyRequests(reply, creationLimit.retryAfterMs);
  if (parsed.data.mode === "real") {
    const result = await startRealRun(request, parsed.data);
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply.code(result.created ? 201 : 200).send(store.getRun(result.run.id, user.id));
  }
  if (!demoMode) return reply.code(403).send({ error: "Demo mode is disabled" });
  const run = baseDemoRun(parsed.data, user.id);
  await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "演示任务已创建；所有 Agent 活动均为可视化演示数据", at: new Date().toISOString() });
  void runDemo(store, run.id);
  return reply.code(201).send(run);
});

app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
  const cancelLimit = runActions.check(auth.user(request).id);
  if (!cancelLimit.allowed) return tooManyRequests(reply, cancelLimit.retryAfterMs);
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (["completed", "failed", "cancelled"].includes(run.state)) return reply.code(409).send({ error: `Cannot cancel run in ${run.state}` });
  if (run.mode === "real") await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  try {
    await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
  } catch (error) {
    // NEW-05/NEW-08: a lost CAS race (concurrent worker callback or cancel) is a
    // clean 409, never a 500.
    const conflict = conflictReplyFor(error);
    if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
    throw error;
  }
  await store.appendEvent({ runId: run.id, round: run.round, source: "system", type: "run.cancelled", message: "任务已取消", at: new Date().toISOString() });
  await reconcileStoryForRun(run.id);
  return store.getRun(run.id, ownerKeysFor(request));
});

app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (isActiveRelease(run)) return reply.code(409).send({ error: "发布仍在进行，不能删除任务", code: "RELEASE_IN_PROGRESS" });
  if (!["completed", "failed", "cancelled", "needs_human"].includes(run.state)) {
    return reply.code(409).send({ error: `Cannot delete a run in ${run.state}; cancel it first` });
  }
  await store.deleteRun(run.id);
  return reply.code(204).send();
});

// GAP-04 / AT-RUN-009: explicit human approval or rejection of a delivered
// worktree. Approval carries two distinct intents: continue development for
// another round, or accept the delivery. Accepting a run that still has open
// review findings requires an explicit acknowledgement (RUN-006).
const approveSchema = z.object({
  mode: z.enum(["continue", "accept"]).optional(),
  note: z.string().trim().max(2_000).optional(),
  acknowledgeOpenFindings: z.boolean().optional(),
  // Review scope for the continued round: "blocking" records medium/low findings
  // without letting them block completion; absent keeps the run's current value.
  reviewScope: z.enum(["all", "blocking"]).optional(),
  // A2: admin option — merge the run branch into the workspace default branch
  // before completing. Absent/`false` keeps the plain accept behavior unchanged.
  mergeIntoWorkspace: z.boolean().optional(),
});
const rejectSchema = z.object({ reason: z.string().trim().max(2_000).optional() });

/**
 * RUN-006: `mode: "continue"` sends a run stopped at needs_human back to
 * development for another round using the existing human-resume job intent
 * (AUD-05 `payload.resume`), so the six open findings are actually worked on
 * instead of being silently accepted. Mirrors the worker/credentials guards of
 * `dispatchFollowupJob`; on a rejected job the run returns to needs_human.
 *
 * A2/B3: the core is extracted from the HTTP adapter so the batch route can run
 * it per run and shape an individual outcome (no Fastify reply involved).
 */
type ContinueResult =
  | { ok: true; run: Run }
  | { ok: false; status: number; code?: string; error: string };

async function startContinue(
  run: Run,
  options: { note?: string; plan: Extract<ApprovePlan, { decision: "continue" }>; userId: string; vaultKey: string; reviewScope?: ReviewScope },
): Promise<ContinueResult> {
  if (run.mode !== "real") return { ok: false, status: 409, code: "RUN_NOT_RESUMABLE", error: "只有真实任务支持「继续开发」" };
  if (!realRunsEnabled || !internalToken) return { ok: false, status: 503, code: "REAL_RUNNER_NOT_AVAILABLE", error: "Real agent execution is disabled" };
  const developerKey = vault.get(options.vaultKey, run.developer.provider);
  const reviewerKey = vault.get(options.vaultKey, run.reviewer.provider);
  if (!developerKey || !reviewerKey) {
    return { ok: false, status: 403, code: "PERSONAL_CREDENTIALS_REQUIRED", error: "该任务所用模型的 provider 凭据缺失，请在「模型与凭据」页配置" };
  }
  const credentials = { developer: developerKey, reviewer: reviewerKey };

  const now = new Date().toISOString();
  const round = run.round + 1;
  const summary = options.note ? `人工选择继续开发：${options.note}` : `人工选择继续开发：第 ${round} 轮处理未解决意见`;
  let updated: Run;
  try {
    updated = await store.updateRun(run.id, {
      state: "developing",
      round,
      maxRounds: Math.max(run.maxRounds, round),
      summary,
      // RESUME: fresh deadline window so the continued round is not aborted
      // against the run's original createdAt window.
      ...resumeDeadlinePatch(now),
      // 需求历史: keep the operator's written requirement, not just the event meta.
      ...(options.note
        ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_continue", note: options.note, by: options.userId }) }
        : {}),
      // Review scope: only written when the operator chose one; absent keeps the
      // run's existing value (default "all").
      ...(options.reviewScope ? { reviewScope: options.reviewScope } : {}),
    });
  } catch (error) {
    const conflict = conflictReplyFor(error);
    if (conflict) return { ok: false, status: conflict.status, code: conflict.code, error: conflict.message };
    throw error;
  }
  await store.appendEvent({
    runId: run.id,
    round,
    source: "system",
    type: "run.approved",
    message: summary,
    at: now,
    meta: {
      ...approveEventMeta(options.plan, options.userId),
      ...(options.reviewScope ? { reviewScope: options.reviewScope } : {}),
    },
  });

  try {
    await dispatchJob(updated, run.checks.map((check) => check.command), { resume: { instruction: options.note } }, credentials);
    credentials.developer = "";
    credentials.reviewer = "";
    return { ok: true, run: store.getRun(run.id) ?? updated };
  } catch (error) {
    credentials.developer = "";
    credentials.reviewer = "";
    await store.updateRun(run.id, { state: "needs_human", summary: "Worker 拒绝任务，保持人工处理" });
    await store.appendEvent({
      runId: run.id,
      round,
      source: "system",
      type: "run.resume_failed",
      message: `Worker 拒绝任务：${(error as Error).message}`,
      at: new Date().toISOString(),
    });
    return { ok: false, status: 503, error: (error as Error).message };
  }
}

async function dispatchContinueJob(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  run: Run,
  options: { note?: string; plan: Extract<ApprovePlan, { decision: "continue" }>; userId: string; reviewScope?: ReviewScope },
) {
  const openFindings = options.plan.openFindings;
  const result = await startContinue(run, { ...options, vaultKey: vaultKeyFor(request) });
  if (!result.ok) return reply.code(result.status).send({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  return reply.code(201).send({ ...result.run, openFindings });
}

/**
 * B2: builds the durable acceptance snapshot for a run, preferring the stored
 * diff artifact's identity over re-hashing the inline diff.
 */
async function acceptanceSnapshotFor(run: Run, input: {
  acceptedAt: string;
  acceptedBy: string;
  note?: string;
  acknowledgedOpenFindings?: boolean;
}) {
  const artifact = await store.getArtifact(run.id, "diff").catch(() => undefined);
  return buildAcceptanceSnapshot({
    run,
    acceptedAt: input.acceptedAt,
    acceptedBy: input.acceptedBy,
    note: input.note,
    acknowledgedOpenFindings: input.acknowledgedOpenFindings,
    artifact: artifact ? { artifactId: artifact.artifactId, sha256: artifact.sha256, bytes: artifact.bytes } : undefined,
  });
}

const completedMergeSchema = z.object({ confirm: z.literal(true), note: z.string().trim().max(2_000).optional() });
const releaseSchema = z.object({
  environment: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  confirm: z.literal(true),
  retry: z.boolean().optional(),
});
const releaseResultSchema = z.object({
  deliveryId: z.string().trim().min(8).max(120),
  status: z.enum(["succeeded", "failed"]),
  detail: z.string().trim().max(500).optional(),
  deploymentId: z.string().trim().max(200).optional(),
  url: z.string().url().max(1_000).optional(),
});

async function mergeCompletedRun(request: FastifyRequest, run: Run, userId: string, note?: string) {
  const now = new Date().toISOString();
  const acceptance = await acceptanceSnapshotFor(run, {
    acceptedAt: now,
    acceptedBy: userId,
    note,
    acknowledgedOpenFindings: false,
  });
  const targetBranch = run.workspaceId
    ? await workspaces.get(ownerKeysFor(request), run.workspaceId, { isAdmin: true }).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
    : undefined;
  return coordinateApprovedMerge(store, {
    run,
    token: newId("mergetok"),
    targetBranch: targetBranch ?? null,
    startedAt: now,
    approval: {
      acceptedAt: now,
      acceptedBy: userId,
      summary: note ? `管理员批准合并：${note}` : "管理员批准合并审核通过的代码",
      note: note ?? null,
      acceptance,
    },
    callWorker: (branch) =>
      workerRequest<MergeResult>(`/runs/${encodeURIComponent(run.id)}/merge`, {
        method: "POST",
        body: JSON.stringify({ ownerId: run.ownerId, repository: run.repository, branch: run.branch, targetBranch: branch ?? undefined, message: note }),
      }),
  });
}

app.post<{ Params: { id: string } }>("/api/runs/:id/approve", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = approveSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以审批", code: "RUN_NOT_APPROVABLE" });
  const user = auth.user(request);
  const note = parsed.data.note?.trim();
  const plan = planApprove({
    mode: parsed.data.mode,
    acknowledgeOpenFindings: parsed.data.acknowledgeOpenFindings,
    findings: run.findings,
  });

  // RUN-006: never silently accept open findings — make the operator acknowledge.
  if (plan.decision === "conflict") {
    return reply.code(plan.status).send({ error: plan.message, code: plan.code, openFindings: plan.openFindings });
  }
  if (plan.decision === "continue") {
    return dispatchContinueJob(request, reply, run, { note, plan, userId: user.id, reviewScope: parsed.data.reviewScope });
  }

  const now = new Date().toISOString();
  // A2: optional admin merge. When the flag is absent nothing changes.
  const mergeGate = planMergeGate({ requested: parsed.data.mergeIntoWorkspace === true, isAdmin: await identities.isAdmin(user.id) });
  if (mergeGate.kind === "forbidden") return reply.code(403).send({ error: mergeGate.message, code: mergeGate.code });

  // B2: durable acceptance snapshot (findings, diff identity, checks, usage).
  const acceptance = await acceptanceSnapshotFor(run, { acceptedAt: now, acceptedBy: user.id, note, acknowledgedOpenFindings: plan.acknowledged });
  const summary = note ? `人工审批通过：${note}` : "人工审批通过，交付已确认";

  let merge: MergeRecord | undefined;
  let updated: Run;
  if (mergeGate.kind === "ready") {
    // B1: two-phase, idempotent approve-and-merge. Git is only touched after the
    // merge is durably claimed (phase 1 CAS), and a DB failure while recording
    // the result is compensated by a replay on later reads (phase 2).
    const targetBranch = run.workspaceId
      ? await workspaces.get(ownerKeysFor(request), run.workspaceId).then((workspace) => workspace.defaultBranch ?? undefined).catch(() => undefined)
      : undefined;
    const outcome = await coordinateApprovedMerge(store, {
      run,
      token: newId("mergetok"),
      targetBranch: targetBranch ?? null,
      startedAt: now,
      approval: { acceptedAt: now, acceptedBy: user.id, summary, note: note ?? null, acceptance },
      callWorker: (branch) =>
        workerRequest<MergeResult>(`/runs/${encodeURIComponent(run.id)}/merge`, {
          method: "POST",
          body: JSON.stringify({ ownerId: run.ownerId, repository: run.repository, branch: run.branch, targetBranch: branch ?? undefined, message: note }),
        }),
    });
    if (outcome.kind === "conflict") return reply.code(outcome.status).send({ error: outcome.message, code: outcome.code });
    if (outcome.kind === "worker-error") {
      // R: forward the workspace-restore state (`restored`/`restoreError`) on
      // every merge failure, not just conflicts, so the UI can tell the operator
      // whether the workspace is back on its pre-merge branch or needs manual care.
      if (outcome.code === "MERGE_CONFLICT") {
        const restore = mergeRestoreFields(outcome);
        const conflict = mergeConflictReply(outcome.conflictingPaths ?? [], restore);
        return reply.code(conflict.status).send({
          error: conflict.message,
          code: conflict.code,
          conflictingPaths: conflict.conflictingPaths,
          ...restore,
        });
      }
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code, ...mergeRestoreFields(outcome) });
    }
    if (outcome.kind === "record-failed") {
      // The worker already merged: the durable `committed_unrecorded` intent
      // makes a later read converge the record instead of staying silent.
      return reply.code(outcome.status).send({
        error: `工作区已合并，但合并记录写入失败，将在后续读取时自动补偿：${outcome.error}`,
        code: outcome.code,
        merge: outcome.merge,
      });
    }
    merge = outcome.merge;
    updated = outcome.run;
  } else {
    try {
      updated = await store.updateRun(run.id, {
        state: "completed",
        approvedAt: now,
        approvedBy: user.id,
        summary,
        acceptance,
        ...(note
          ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_accept", note, by: user.id }) }
          : {}),
      });
    } catch (error) {
      const conflict = conflictReplyFor(error);
      if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
      throw error;
    }
  }

  // The `run.merged` event is appended (idempotently, keyed by the commit) by
  // the merge coordinator; only the approval event is appended here.
  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: "run.approved",
    message: summary,
    at: now,
    meta: { ...approveEventMeta(plan, user.id), acceptance, ...(merge ? { merge } : {}) },
  });

  // Publishing is deliberately not implicit here. A separate administrator
  // action records a durable release attempt before invoking any external hook.
  await reconcileStoryForRun(run.id);
  return { ...updated, acceptedOpenFindings: plan.openFindings, acceptance, ...(merge ? { merge } : {}) };
});

/**
 * REL-PUBLISH: explicit merge gate for a normally completed run. This avoids
 * forcing a successful run through `reopen -> needs_human` merely to merge it.
 */
app.post<{ Params: { id: string } }>("/api/runs/:id/merge", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = completedMergeSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const user = auth.user(request);
  if (!(await identities.isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以合并审核通过的代码", code: "ADMIN_REQUIRED" });
  if (run.state !== "completed") return reply.code(409).send({ error: "只有审核完成的任务可以进入合并步骤", code: "RUN_NOT_MERGE_READY" });
  if (run.mode !== "real") return reply.code(409).send({ error: "演示任务没有可合并的真实工作区", code: "REAL_RUN_REQUIRED" });
  if (run.merge) return run;

  const outcome = await mergeCompletedRun(request, run, user.id, parsed.data.note?.trim());
  if (outcome.kind === "conflict") return reply.code(outcome.status).send({ error: outcome.message, code: outcome.code });
  if (outcome.kind === "worker-error") {
    const restore = mergeRestoreFields(outcome);
    return reply.code(outcome.status).send({
      error: outcome.error,
      code: outcome.code,
      ...(outcome.conflictingPaths ? { conflictingPaths: outcome.conflictingPaths } : {}),
      ...restore,
    });
  }
  if (outcome.kind === "record-failed") {
    return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code, merge: outcome.merge });
  }
  return outcome.run;
});

/**
 * REL-PUBLISH: explicit, durable release. The `publishing` record is committed
 * before the hook call; retries reuse its delivery id so the receiver can
 * safely de-duplicate a request whose original response was lost.
 */
app.post<{ Params: { id: string } }>("/api/runs/:id/publish", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = releaseSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "发布需要有效环境名和 confirm=true", code: "RELEASE_CONFIRM_REQUIRED", details: parsed.error.issues });
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const user = auth.user(request);
  if (!(await identities.isAdmin(user.id))) return reply.code(403).send({ error: "仅管理员可以发布代码", code: "ADMIN_REQUIRED" });

  const deployPlan = planPostMergeDeploy(process.env.PI_POST_MERGE_DEPLOY_HOOK);
  if (!deployPlan.configured) return reply.code(409).send({ error: deployPlan.reason, code: "RELEASE_NOT_CONFIGURED" });
  if (deployPlan.kind === "unsupported") return reply.code(409).send({ error: deployPlan.reason, code: "RELEASE_CONFIG_INVALID" });
  if (deployPlan.kind === "webhook" && !releaseWebhookToken) {
    return reply.code(409).send({ error: "Webhook 发布必须配置 PI_POST_MERGE_DEPLOY_TOKEN", code: "RELEASE_AUTH_NOT_CONFIGURED" });
  }
  if (deployPlan.kind === "webhook" && !publicOrigin) {
    return reply.code(409).send({ error: "Webhook 发布必须配置 PI_PUBLIC_ORIGIN 以接收异步结果回调", code: "RELEASE_CALLBACK_NOT_CONFIGURED" });
  }

  const decision = planReleaseStart({
    run,
    environment: parsed.data.environment,
    requestedBy: user.id,
    now: new Date().toISOString(),
    kind: deployPlan.kind,
    retry: parsed.data.retry,
  });
  if (decision.kind === "conflict") return reply.code(decision.status).send({ error: decision.message, code: decision.code });
  if (decision.kind === "already-succeeded") return run;

  const previous = run.release;
  const claim = await store.updateRunGuarded(run.id, (current) => {
    if (current.state !== "completed" || current.merge?.commit !== run.merge?.commit) {
      return { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "任务或合并 commit 已变化，请刷新后重试" };
    }
    if (!previous && current.release) return { allow: false as const, code: "RELEASE_IN_PROGRESS", message: "已有其他发布请求" };
    if (previous && (
      current.release?.deliveryId !== previous.deliveryId
      || current.release?.attempt !== previous.attempt
      || current.release?.status !== previous.status
    )) return { allow: false as const, code: "RELEASE_IN_PROGRESS", message: "发布状态已由其他请求更新" };
    return { allow: true as const };
  }, { release: decision.release });
  if (!claim.ok) return reply.code(409).send({ error: claim.message, code: claim.code });

  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: "run.release_started",
    message: `开始发布 ${decision.release.commit.slice(0, 10)} 到 ${decision.release.environment}`,
    at: decision.release.startedAt,
    meta: { ...decision.release },
  }, { deliveryId: `release-start:${decision.release.deliveryId}:${decision.release.attempt}` }).catch(() => undefined);

  const callbackUrl = publicOrigin
    ? `${publicOrigin.replace(/\/$/, "")}/api/internal/runs/${encodeURIComponent(run.id)}/release-result`
    : undefined;
  const execution = await executeRelease(
    deployPlan,
    buildDeployHookPayload({ run, merge: run.merge!, release: decision.release, callbackUrl }),
    { deliveryId: decision.release.deliveryId, webhookToken: releaseWebhookToken || undefined },
  );
  const finishedAt = new Date().toISOString();
  const release: RunReleaseRecord = {
    ...decision.release,
    status: execution.status === "succeeded" ? "succeeded" : execution.status === "triggered" ? "triggered" : "failed",
    detail: execution.detail,
    ...(execution.httpStatus === undefined ? {} : { httpStatus: execution.httpStatus }),
    ...(execution.status === "triggered" ? {} : { finishedAt }),
  };
  const finalized = await store.updateRunGuarded(run.id, (current) => sameReleaseAttempt(current, decision.release)
    ? { allow: true as const }
    : { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "发布执行完成，但记录已被其他请求更新" }, { release });
  if (!finalized.ok) {
    // A fast asynchronous publisher may POST its callback before the original
    // HTTP 202 response reaches us. Never overwrite or report that valid final
    // result as a failure merely because the callback won the CAS race.
    const latest = store.getRun(run.id);
    if (latest?.release?.deliveryId === release.deliveryId
      && (latest.release.status === "succeeded" || latest.release.status === "failed")) return latest;
    return reply.code(503).send({ error: finalized.message, code: finalized.code, deliveryId: release.deliveryId });
  }

  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: release.status === "failed" ? "run.release_failed" : release.status === "triggered" ? "run.release_triggered" : "run.release_succeeded",
    message: release.status === "failed"
      ? `发布失败：${release.detail ?? "未知原因"}`
      : release.status === "triggered"
        ? "部署系统已接收发布请求，等待最终结果"
        : `代码已发布到 ${release.environment}`,
    at: finishedAt,
    meta: { ...release },
  }, { deliveryId: `release-result:${release.deliveryId}:${release.attempt}` }).catch(() => undefined);
  return finalized.run;
});

/** Authenticated final-status callback for asynchronous (HTTP 202) publishers. */
app.post<{ Params: { id: string } }>("/api/internal/runs/:id/release-result", async (request, reply) => {
  const authorized = safeSecretMatch(request.headers.authorization, releaseWebhookToken) || safeTokenMatch(request.headers.authorization);
  if (!authorized) return reply.code(401).send({ error: "Unauthorized" });
  const parsed = releaseResultSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid release result", details: parsed.error.issues });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const current = run.release;
  if (!current || current.deliveryId !== parsed.data.deliveryId) {
    return reply.code(409).send({ error: "Release delivery id does not match", code: "RELEASE_DELIVERY_MISMATCH" });
  }
  if (current.status === parsed.data.status) {
    await store.appendEvent({
      runId: run.id,
      round: run.round,
      source: "system",
      type: current.status === "succeeded" ? "run.release_succeeded" : "run.release_failed",
      message: current.status === "succeeded" ? `代码已发布到 ${current.environment}` : `发布失败：${current.detail ?? "未知原因"}`,
      at: current.finishedAt ?? new Date().toISOString(),
      meta: { ...current },
    }, { deliveryId: `release-callback:${current.deliveryId}` });
    return { ok: true, release: current };
  }
  if (current.status !== "triggered" && current.status !== "publishing") {
    return reply.code(409).send({ error: `Release is already ${current.status}`, code: "RELEASE_ALREADY_FINAL" });
  }
  const release: RunReleaseRecord = {
    ...current,
    status: parsed.data.status,
    finishedAt: new Date().toISOString(),
    detail: parsed.data.detail,
    ...(parsed.data.deploymentId ? { deploymentId: parsed.data.deploymentId } : {}),
    ...(parsed.data.url ? { url: parsed.data.url } : {}),
  };
  const result = await store.updateRunGuarded(run.id, (latest) => latest.release?.deliveryId === current.deliveryId
    && (latest.release.status === "triggered" || latest.release.status === "publishing")
    ? { allow: true as const }
    : { allow: false as const, code: "RELEASE_STATE_CHANGED", message: "发布状态已变化" }, { release });
  if (!result.ok) return reply.code(409).send({ error: result.message, code: result.code });
  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: release.status === "succeeded" ? "run.release_succeeded" : "run.release_failed",
    message: release.status === "succeeded" ? `代码已发布到 ${release.environment}` : `发布失败：${release.detail ?? "未知原因"}`,
    at: release.finishedAt!,
    meta: { ...release },
  }, { deliveryId: `release-callback:${release.deliveryId}` });
  return { ok: true, release };
});

app.post<{ Params: { id: string } }>("/api/runs/:id/reject", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = rejectSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以拒绝", code: "RUN_NOT_REJECTABLE" });
  const user = auth.user(request);
  const now = new Date().toISOString();
  const reason = parsed.data.reason?.trim();
  let updated: Run;
  try {
    updated = await store.updateRun(run.id, {
      state: "cancelled",
      summary: reason ? `人工拒绝交付：${reason}` : "人工拒绝交付，任务已终止",
      ...(reason
        ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "reject", note: reason, by: user.id }) }
        : {}),
    });
  } catch (error) {
    const conflict = conflictReplyFor(error);
    if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
    throw error;
  }
  if (run.mode === "real") await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: "run.rejected",
    message: reason ? `人工拒绝交付：${reason}` : "人工拒绝交付，任务已终止",
    at: now,
    meta: { rejectedBy: user.id },
  });
  return updated;
});

/**
 * B1: reopen a delivered run. Moves `completed` back to `needs_human` (guarded
 * state-machine edge), records `run.reopened` plus the operator's note, and
 * leaves the run branch/worktree intact. Admins may reopen any run; the owner
 * must pass `confirm: true`.
 */
const reopenSchema = z.object({
  note: z.string().trim().max(2_000).optional(),
  confirm: z.boolean().optional(),
});

app.post<{ Params: { id: string } }>("/api/runs/:id/reopen", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = reopenSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  const isAdminUser = await identities.isAdmin(user.id);
  let run = store.getRun(request.params.id, ownerKeysFor(request));
  const isOwner = Boolean(run);
  // Admins may reopen a run they do not own.
  if (!run && isAdminUser) run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });

  if (isActiveRelease(run)) return reply.code(409).send({ error: "发布仍在进行，不能重新打开任务", code: "RELEASE_IN_PROGRESS" });
  if (run.merge || run.release) {
    return reply.code(409).send({ error: "已进入合并/发布链路的任务不可重新开发；请基于新需求创建新的 Run", code: "RELEASED_RUN_IMMUTABLE" });
  }

  const plan = planReopen({ state: run.state, isAdmin: isAdminUser, isOwner, confirm: parsed.data.confirm });
  if (!plan.allowed) return reply.code(plan.status).send({ error: plan.message, code: plan.code });

  const now = new Date().toISOString();
  const note = parsed.data.note?.trim();
  const summary = note ? `重新打开任务：${note}` : "任务已重新打开，等待人工处理";
  let updated: Run;
  try {
    updated = await store.updateRun(run.id, {
      state: plan.targetState,
      summary,
      reopenedAt: now,
      reopenedBy: user.id,
      ...(note
        ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "reopen", note, by: user.id }) }
        : {}),
    });
  } catch (error) {
    const conflict = conflictReplyFor(error);
    if (conflict) return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
    throw error;
  }
  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: "run.reopened",
    message: summary,
    at: now,
    meta: reopenEventMeta({ reopenedBy: user.id, reason: plan.reason, note }),
  });
  await reconcileStoryForRun(run.id);
  return updated;
});

// GAP-04: owner-scoped (admins may pass scope=all) cleanup of finished runs and
// their artifacts/events. Active runs are never touched.
const cleanupSchema = z.object({
  runIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  states: z.array(runStateSchema).max(9).optional(),
  olderThanDays: z.number().min(0).max(3_650).optional(),
  scope: z.enum(["own", "all"]).default("own"),
  dryRun: z.boolean().default(false),
  // B6: explicit on-disk intent. Defaults to true because that has been the
  // server behavior since v0.22 (the UI wording was the stale part).
  deleteRunDirectory: z.boolean().default(true),
});

app.post("/api/runs/cleanup", async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = cleanupSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  if (parsed.data.scope === "all" && !(await identities.isAdmin(user.id))) {
    return reply.code(403).send({ error: "仅管理员可以清理全部任务", code: "ADMIN_REQUIRED" });
  }
  let candidates: Run[];
  if (parsed.data.scope === "all") {
    const owners = (await db.query("SELECT DISTINCT owner_id FROM runs")).rows.map((row) => String(row.owner_id));
    candidates = owners.flatMap((owner) => store.listRuns(owner));
  } else {
    candidates = store.listRuns(ownerKeysFor(request));
  }
  const allowedStates = new Set(parsed.data.states ?? []);
  const idFilter = parsed.data.runIds ? new Set(parsed.data.runIds) : undefined;
  const cutoff = parsed.data.olderThanDays === undefined ? undefined : Date.now() - parsed.data.olderThanDays * 86_400_000;
  const matched = candidates.filter((run) => {
    if (!TERMINAL_RUN_STATES.has(run.state)) return false;
    if (isActiveRelease(run)) return false;
    if (allowedStates.size > 0 && !allowedStates.has(run.state)) return false;
    if (idFilter && !idFilter.has(run.id)) return false;
    if (cutoff !== undefined && new Date(run.updatedAt).getTime() > cutoff) return false;
    return true;
  });
  if (parsed.data.dryRun) {
    const storage = parsed.data.deleteRunDirectory
      ? await Promise.all(matched.map((run) => cleanupRunDirectory(run, { dryRun: true, cleaner: runDirectoryCleaner })))
      : matched.map((run) => keptRunStorageOutcome(run.id, "未请求删除运行目录（deleteRunDirectory=false）"));
    return { dryRun: true, deleteRunDirectory: parsed.data.deleteRunDirectory, matched: matched.length, runIds: matched.map((run) => run.id), storage };
  }
  const deleted: string[] = [];
  const storage: Awaited<ReturnType<typeof cleanupRunDirectory>>[] = [];
  for (const run of matched) {
    try {
      await store.deleteRun(run.id);
      deleted.push(run.id);
    } catch (error) {
      app.log.warn({ runId: run.id, error: (error as Error).message }, "cleanup: failed to delete run");
      storage.push(keptRunStorageOutcome(run.id, `database deletion failed: ${(error as Error).message}`));
      continue;
    }
    // Best-effort on-disk cleanup after the records are gone: a worker that is
    // unreachable (or refuses an unsafe path) only marks the run as kept.
    storage.push(parsed.data.deleteRunDirectory
      ? await cleanupRunDirectory(run, { dryRun: false, cleaner: runDirectoryCleaner })
      : keptRunStorageOutcome(run.id, "未请求删除运行目录（deleteRunDirectory=false）"));
  }
  if (deleted.length > 0) app.log.info({ actor: user.id, deleted }, "cleaned up finished runs");
  return { dryRun: false, deleteRunDirectory: parsed.data.deleteRunDirectory, deleted: deleted.length, runIds: deleted, matched: matched.length, storage };
});

/**
 * B3: batch continue/accept/cleanup over an explicit, bounded list of runs.
 * Owner scoped; every run gets its own outcome and partial failures are reported
 * individually. Accept requires the same open-findings acknowledgement as the
 * single-run path, and cleanup reuses the existing terminal-only semantics.
 */
const batchSchema = z.object({
  action: z.enum(["continue", "accept", "cleanup"]),
  runIds: z.array(z.string().trim().min(1).max(120)).max(MAX_BATCH_RUN_IDS),
  note: z.string().trim().max(2_000).optional(),
  acknowledgeOpenFindings: z.boolean().optional(),
  // B6: explicit on-disk intent for cleanup. Defaults to true (today's behavior);
  // `false` keeps the run directory/worktree on the server.
  deleteRunDirectory: z.boolean().default(true),
});

app.post("/api/runs/batch", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const parsed = batchSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const ids = parseBatchRunIds(parsed.data.runIds);
  if (!ids.ok) return reply.code(400).send({ error: ids.message, code: "BATCH_INVALID" });
  const user = auth.user(request);
  const note = parsed.data.note?.trim();
  const outcomes: BatchItemOutcome[] = [];

  for (const id of ids.ids) {
    const run = store.getRun(id, ownerKeysFor(request));
    if (!run) {
      outcomes.push(batchItemFailure(id, 404, "RUN_NOT_FOUND", "Run not found"));
      continue;
    }
    if (parsed.data.action === "cleanup") {
      if (!TERMINAL_RUN_STATES.has(run.state)) {
        outcomes.push(batchItemFailure(id, 409, "RUN_ACTIVE", `无法清理状态为 ${run.state} 的任务`));
        continue;
      }
      if (isActiveRelease(run)) {
        outcomes.push(batchItemFailure(id, 409, "RELEASE_IN_PROGRESS", "发布仍在进行，不能清理任务"));
        continue;
      }
      try {
        await store.deleteRun(run.id);
      } catch (error) {
        // Records could not be removed, so the directory was never touched.
        outcomes.push(batchItemFailure(id, 500, undefined, (error as Error).message, "kept"));
        continue;
      }
      const storage = parsed.data.deleteRunDirectory
        ? (await cleanupRunDirectory(run, { dryRun: false, cleaner: runDirectoryCleaner })).outcome
        : "kept";
      outcomes.push(batchItemSuccess(id, run.state, storage));
      continue;
    }

    if (run.state !== "needs_human") {
      outcomes.push(batchItemFailure(id, 409, "RUN_NOT_APPROVABLE", "仅「需要人工处理」的任务可以审批"));
      continue;
    }
    const plan = planApprove({
      mode: parsed.data.action === "continue" ? "continue" : "accept",
      acknowledgeOpenFindings: parsed.data.acknowledgeOpenFindings,
      findings: run.findings,
    });
    if (plan.decision === "conflict") {
      outcomes.push(batchItemFailure(id, plan.status, plan.code, plan.message));
      continue;
    }
    if (plan.decision === "continue") {
      const result = await startContinue(run, { note, plan, userId: user.id, vaultKey: vaultKeyFor(request) });
      outcomes.push(result.ok ? batchItemSuccess(id, result.run.state) : batchItemFailure(id, result.status, result.code, result.error));
      continue;
    }

    const now = new Date().toISOString();
    try {
      const acceptance = await acceptanceSnapshotFor(run, { acceptedAt: now, acceptedBy: user.id, note, acknowledgedOpenFindings: plan.acknowledged });
      await store.updateRun(run.id, {
        state: "completed",
        approvedAt: now,
        approvedBy: user.id,
        summary: note ? `人工审批通过：${note}` : "批量审批通过，交付已确认",
        acceptance,
        ...(note ? { humanNotes: appendHumanNote(run.humanNotes, { at: now, kind: "approve_accept", note, by: user.id }) } : {}),
      });
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.approved",
        message: "批量审批通过",
        at: now,
        meta: { ...approveEventMeta(plan, user.id), acceptance, batch: true },
      });
      outcomes.push(batchItemSuccess(id, "completed"));
    } catch (error) {
      const conflict = conflictReplyFor(error);
      outcomes.push(batchItemFailure(id, conflict?.status ?? 500, conflict?.code, conflict?.message ?? (error as Error).message));
    }
  }
  return summarizeBatch(parsed.data.action, outcomes);
});

// ---------------------------------------------------------------- job queue (REL-002)

const JOB_STALE_MS = Number(process.env.PI_JOB_STALE_SECONDS || 120) * 1_000;

/**
 * Credentials for a run outside a request context (job recovery has no session).
 * Credentials may live under the internal user id or its legacy owner key, so
 * both are tried before giving up (AT-REL-002).
 */
async function jobCredentialsFor(run: Run): Promise<{ developer: string; reviewer: string } | undefined> {
  const candidates = [run.ownerId];
  const legacy = await identities.legacyOwnerFor(run.ownerId).catch(() => undefined);
  if (legacy) candidates.push(legacy);
  for (const key of candidates) {
    const credentials = requireCredentials({
      developer: vault.get(key, run.developer.provider),
      reviewer: vault.get(key, run.reviewer.provider),
    });
    if (credentials) return credentials;
  }
  return undefined;
}

/** Creates a durable job row and pushes it to the worker; the row survives a restart. */
async function dispatchJob(
  run: Run,
  checks: string[],
  payload: Record<string, unknown>,
  credentials: { developer: string; reviewer: string },
) {
  if (!jobQueue) throw new Error("Job queue unavailable (PostgreSQL store required)");
  const jobId = newId("job");
  const kind = "run";
  await jobQueue.createJob({ id: jobId, runId: run.id, kind, payload: { ...payload, checks } });
  await jobQueue.reserveJob(jobId);
  try {
    await workerRequest("/jobs", {
      method: "POST",
      body: JSON.stringify({ run, checks, credentials, jobId, ...payload }),
    });
    return { jobId, accepted: true as const };
  } catch (error) {
    const message = (error as Error).message;
    if (/capacity/i.test(message)) {
      // REL-002 / AUD-05: stay queued instead of failing the run, and release the
      // reservation right away so the job can be claimed as soon as a slot frees.
      await jobQueue.releaseReservation(jobId, "worker capacity reached");
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.queued",
        message: "Worker 当前繁忙，任务保持在队列中等待领取",
        at: new Date().toISOString(),
      });
      return { jobId, accepted: false as const };
    }
    await jobQueue.finishJob(jobId, "failed", message.slice(0, 500));
    throw error;
  }
}

/** Re-queues jobs whose worker stopped heartbeating (worker restart, AT-REL-002/003). */
async function requeueStaleJobs() {
  if (!jobQueue) return;
  try {
    const requeued = await jobQueue.requeueStaleJobs(JOB_STALE_MS);
    if (requeued.length > 0) {
      app.log.warn({ requeued }, "re-queued stale jobs after worker heartbeat loss");
      alerts.raise({
        key: "jobs_requeued",
        severity: "warning",
        message: "Worker 心跳超时，未完成任务已重新入队等待领取",
        details: { count: requeued.length, jobs: requeued.slice(0, 10) },
      });
    }
  } catch (error) {
    app.log.error({ error: (error as Error).message }, "stale job requeue failed");
  }
}

const resumeSchema = z.object({
  instruction: z.string().trim().max(2_000).optional(),
});

/** RUN-006: human-in-the-loop actions for runs stopped at needs_human. */
async function dispatchFollowupJob(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  options: { kind: "resume"; instruction?: string } | { kind: "retry-review" },
) {
  const actionLimit = runActions.check(auth.user(request).id);
  if (!actionLimit.allowed) return tooManyRequests(reply, actionLimit.retryAfterMs);
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (run.mode !== "real") return reply.code(409).send({ error: "只有真实任务支持人工恢复", code: "RUN_NOT_RESUMABLE" });
  if (run.state !== "needs_human") return reply.code(409).send({ error: "仅「需要人工处理」的任务可以执行该操作", code: "RUN_NOT_RESUMABLE" });
  if (!realRunsEnabled || !internalToken) return reply.code(503).send({ error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" });
  const developerKey = vault.get(vaultKeyFor(request), run.developer.provider);
  const reviewerKey = vault.get(vaultKeyFor(request), run.reviewer.provider);
  if (!developerKey || !reviewerKey) {
    return reply.code(403).send({ error: "该任务所用模型的 provider 凭据缺失，请在「模型与凭据」页配置", code: "PERSONAL_CREDENTIALS_REQUIRED" });
  }
  const credentials = { developer: developerKey, reviewer: reviewerKey };

  const instruction = options.kind === "resume" ? options.instruction?.trim() : undefined;
  const round = options.kind === "resume" ? run.round + 1 : run.round;
  const noteAt = new Date().toISOString();
  const updated = await store.updateRun(run.id, options.kind === "resume"
    ? {
        state: "queued",
        round,
        maxRounds: Math.max(run.maxRounds, round),
        summary: "人工恢复：等待 Worker 接收",
        // RESUME: fresh deadline window for the resumed round (see run-deadline-base).
        ...resumeDeadlinePatch(noteAt),
        // 需求历史: the resume instruction is the operator's written requirement.
        ...(instruction
          ? { humanNotes: appendHumanNote(run.humanNotes, { at: noteAt, kind: "resume", note: instruction, by: auth.user(request).id }) }
          : {}),
      }
    : {
        state: "reviewing",
        summary: "人工触发：重新审核中",
        // 同一类问题：窗口已过的任务重试审核时也会秒超时，一并给新窗口。
        ...resumeDeadlinePatch(noteAt),
      });
  await store.appendEvent({
    runId: run.id,
    round,
    source: "system",
    type: options.kind === "resume" ? "run.resumed" : "run.review_retry",
    message: options.kind === "resume"
      ? `工作区所有者恢复执行（第 ${round} 轮）`
      : "工作区所有者触发重新审核",
    at: new Date().toISOString(),
  });
  if (instruction) {
    await store.appendEvent({ runId: run.id, round, source: "system", type: "run.resume_instruction", message: `人工指令：${instruction.slice(0, 500)}`, at: new Date().toISOString() });
  }

  try {
    await dispatchJob(
      updated,
      run.checks.map((check) => check.command),
      options.kind === "resume" ? { resume: { instruction } } : { retryReview: true },
      credentials,
    );
    credentials.developer = "";
    credentials.reviewer = "";
    return reply.code(201).send(store.getRun(run.id, ownerKeysFor(request)));
  } catch (error) {
    credentials.developer = "";
    credentials.reviewer = "";
    await store.updateRun(run.id, { state: "needs_human", summary: "Worker 拒绝任务，保持人工处理" });
    await store.appendEvent({
      runId: run.id,
      round,
      source: "system",
      type: options.kind === "resume" ? "run.resume_failed" : "run.review_retry_failed",
      message: `Worker 拒绝任务：${(error as Error).message}`,
      at: new Date().toISOString(),
    });
    return reply.code(503).send({ error: (error as Error).message });
  }
}

app.post<{ Params: { id: string } }>("/api/runs/:id/resume", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  const parsed = resumeSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  return dispatchFollowupJob(request, reply, { kind: "resume", instruction: parsed.data.instruction });
});

app.post<{ Params: { id: string } }>("/api/runs/:id/retry-review", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
  return dispatchFollowupJob(request, reply, { kind: "retry-review" });
});

// Multi-process safety (rolling deploys / ops tooling): hydrate a run written by
// another web instance on first touch instead of answering 404.
app.addHook("preHandler", async (request) => {
  const url = request.url.split("?")[0];
  if (!url.startsWith("/api/runs/") && !url.startsWith("/api/internal/runs/")) return;
  const id = (request.params as { id?: string } | undefined)?.id;
  if (!id || !(store instanceof PostgresRunStore)) return;
  // Always refresh from the database: another web instance may have moved the
  // run on (cancel/approve/worker callback), and a cached snapshot that is
  // merely stale must not be used to validate a state transition. `hydrate`
  // keeps the newer of cache/database, so a fresh cache is never downgraded.
  await store.hydrate(id).catch(() => undefined);
});

app.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  const parsed = internalUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid internal update", details: parsed.error.issues });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  // Chat/状态抑制：终态运行（例如用户刚取消）不再接受任何 worker 内部更新，
  // 否则迟到的 chat.message 会追加在 run.cancelled 之后并覆盖终态。
  const rejection = internalUpdateRejection(run);
  if (rejection) return reply.code(409).send({ error: rejection });
  const { patch, event, deliveryId } = parsed.data;
  try {
    if (deliveryId && jobQueue) {
      // AUD-15: patch + event + delivery record commit in one transaction, so a
      // duplicated internal call can neither double count nor rewind state.
      const result = await jobQueue.applyDelivery({
        runId: run.id,
        deliveryId,
        patch: patch as Partial<Run> | undefined,
        event: event ? { ...event, runId: run.id, at: new Date().toISOString() } : undefined,
      });
      // AUD-16: the terminal callback carries the run diff; persist it in full.
      if (result.applied) await persistTerminalDiffArtifact(store.getRun(run.id));
      if (result.applied) await reconcileStoryForRun(run.id);
      return { ok: true, applied: result.applied, seq: result.seq };
    }
    if (patch) await store.updateRun(run.id, patch as Partial<Run>);
    if (event) await store.appendEvent({ ...event, runId: run.id, at: new Date().toISOString() });
    if (patch) await persistTerminalDiffArtifact(store.getRun(run.id));
    if (patch) await reconcileStoryForRun(run.id);
    return { ok: true, applied: true };
  } catch (error) {
    const conflict = conflictReplyFor(error);
    if (conflict) {
      if (conflict.code === "INVALID_STATE_TRANSITION") {
        await store.appendEvent({
          runId: run.id,
          round: run.round,
          source: "system",
          type: "run.transition_rejected",
          message: `拒绝非法状态转移：${conflict.message}`,
          at: new Date().toISOString(),
        }).catch(() => undefined);
      }
      return reply.code(conflict.status).send({ error: conflict.message, code: conflict.code });
    }
    throw error;
  }
});

// NEW-07 / AUD-16: internal artifact upload. The worker persists a full diff here
// (beyond the 3 MiB inline callback budget) and references the returned artifact
// id/hash/bytes in the callback, so the browser download is the complete body.
app.post<{ Params: { id: string } }>("/api/internal/runs/:id/artifacts", { bodyLimit: INTERNAL_ARTIFACT_BODY_LIMIT }, async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  const parsed = internalArtifactSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid artifact upload", details: parsed.error.issues });
  const result = await saveInternalRunArtifact(store, { runId: request.params.id, ...parsed.data });
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return { ok: true, artifact: result.artifact };
});

// ------------------------------------------- internal job + checkpoint API (REL-002/003)

app.get<{ Querystring: { workerId?: string } }>("/api/internal/jobs/pending", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
  await requeueStaleJobs();
  const jobs = await jobQueue.listPendingJobs({ staleAfterMs: JOB_STALE_MS });
  const payloads: Array<Record<string, unknown>> = [];
  for (const job of jobs) {
    // Multi-process safety: a run written by another web instance (rolling
    // deploy, ops tooling) is hydrated here before the job payload is built, so
    // the worker never receives a job it cannot resolve.
    let run = store.getRun(job.runId);
    if (!run && store instanceof PostgresRunStore) run = await store.hydrate(job.runId);
    if (!run) {
      // Transient visibility gap: keep the job claimable and record the reason
      // instead of failing it (a failure would strand the run in `queued`).
      const ageMs = Date.now() - Date.parse(String((job as { createdAt?: string }).createdAt ?? new Date().toISOString()));
      if (ageMs > 15 * 60_000) await jobQueue.finishJob(job.id, "failed", "Run missing");
      else await jobQueue.deferJob(job.id, "Run missing (等待运行记录可见)");
      continue;
    }
    if (["completed", "failed", "cancelled", "needs_human"].includes(run.state)) {
      await jobQueue.finishJob(job.id, "done");
      continue;
    }
    const credentials = await jobCredentialsFor(run);
    if (!credentials) {
      await jobQueue.finishJob(job.id, "failed", "Credentials unavailable for the pinned providers");
      await store.updateRun(run.id, { state: "needs_human", summary: "恢复执行失败：该任务所用模型的 provider 凭据不可用，请在「模型与凭据」页检查" }).catch(() => undefined);
      await store.appendEvent({
        runId: run.id,
        round: run.round,
        source: "system",
        type: "run.recovery_blocked",
        message: "Worker 重启后无法恢复：缺少该任务 provider 的凭据（任务未丢失，可在配置凭据后重新恢复）",
        at: new Date().toISOString(),
      }).catch(() => undefined);
      continue;
    }
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    // AUD-05: the durable job payload decides what the worker executes: a job
    // that never started must create the run directory, only a started one is a
    // recovery; human resume/retry intent survives a queue wait or a crash.
    payloads.push({
      jobId: job.id,
      kind: job.kind,
      run,
      checks: Array.isArray(payload.checks) ? payload.checks : [],
      credentials,
      wasStarted: job.startedAt !== null,
      ...(payload.resume ? { resume: payload.resume } : {}),
      ...(payload.retryReview ? { retryReview: true } : {}),
    });
  }
  return { jobs: payloads };
});

app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/claim", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
  const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
  const job = await jobQueue.claimJob(request.params.id, workerId);
  if (!job) return reply.code(409).send({ error: "Job is not claimable" });
  return { ok: true, job };
});

app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/heartbeat", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
  const workerId = String((request.body as { workerId?: unknown })?.workerId ?? "unknown").slice(0, 120);
  await jobQueue.heartbeatJob(request.params.id, workerId);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/internal/jobs/:id/finish", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
  const body = (request.body ?? {}) as { state?: unknown; error?: unknown };
  const state = body.state === "failed" || body.state === "cancelled" ? body.state : "done";
  await jobQueue.finishJob(request.params.id, state, body.error === undefined ? undefined : String(body.error).slice(0, 500));
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return { checkpoints: await jobQueue.listCheckpoints(run.id) };
});

app.post<{ Params: { id: string } }>("/api/internal/runs/:id/checkpoints", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Checkpoints unavailable" });
  const parsed = checkpointSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid checkpoint", details: parsed.error.issues });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  await jobQueue.saveCheckpoint({
    runId: run.id,
    stageKey: parsed.data.stageKey,
    status: parsed.data.status,
    payload: parsed.data.payload,
    idempotencyKey: parsed.data.idempotencyKey ?? `${run.id}:${parsed.data.stageKey}`,
  });
  return { ok: true };
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(currentDir, "../client");
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}

// AT-REL-007 / AT-REL-005: storage failures are surfaced as explicit 503s
// instead of generic 500s, and raise an alert.
app.setErrorHandler((error, _request, reply) => {
  const message = String((error as Error).message || "");
  const storageFailure = /ECONNREFUSED|Connection terminated|connection is closed|ETIMEDOUT|terminating connection|57P0|STORAGE_UNAVAILABLE|no space left on device|ENOSPC/i.test(message);
  if (storageFailure) {
    alerts.raise({ key: "storage_failure", severity: "critical", message: "存储写入失败，任务未完成", details: { error: message.slice(0, 200) } });
    return reply.code(503).send({ error: `存储不可用：${message.slice(0, 200)}`, code: "STORAGE_UNAVAILABLE" });
  }
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error({ error: message }, "request failed");
  return reply.code(status).send({ error: status >= 500 ? "Internal error" : message });
});

// REL-002: jobs left unfinished by a stopped worker are re-queued and (when the
// worker is back) pushed again, so a run never stalls silently.
await requeueStaleJobs();
const jobRecoveryTimer = setInterval(() => { void requeueStaleJobs(); }, 60_000);
jobRecoveryTimer.unref?.();

await app.listen({ port, host });
