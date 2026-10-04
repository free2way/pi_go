import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConfigStatus, CurrentUser, ModelCatalogResponse, Run, RunEvent, Workspace } from "../shared/types.js";
import { AlertManager, createAlertSink } from "./alerts.js";
import { Authenticator } from "./auth.js";
import { CredentialVault } from "./credential-vault.js";
import { createDb, createPool, newId, runMigrations } from "./db.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { IdentityService } from "./identity.js";
import { availableModels, defaultSelections, loadModelCatalog, validateModelSelection } from "./model-catalog.js";
import { baseRealRun } from "./real-run.js";
import { RateLimiter } from "./rate-limit.js";
import { PostgresRunStore } from "./run-store-pg.js";
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
const demoMode = process.env.PI_DEMO_MODE !== "false";
const realRunsEnabled = process.env.PI_REAL_RUNS_ENABLED === "true";
const workerUrl = process.env.PI_WORKER_URL || "http://worker:3200";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
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
const workspaces = new WorkspaceService(db, workerRequest);
const userCache = new Map<string, CurrentUser>();

const createRunSchema = z.object({
  title: z.string().trim().min(2).max(80),
  task: z.string().trim().min(10).max(10_000),
  repository: z.string().trim().max(240).default("demo/auth-service"),
  workspaceId: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["demo", "real"]).default("demo"),
  checks: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
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
});
const checkResultSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  command: z.string().min(1).max(1_000),
  status: z.enum(["pending", "running", "passed", "failed"]),
  durationMs: z.number().min(0).optional(),
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
  summary: z.string().max(4_000).optional(),
  durationMs: z.number().min(0).optional(),
});
const developmentPlanSchema = z.object({
  complexity: z.enum(["small", "medium", "large"]),
  rationale: z.string().max(4_000),
  strategy: z.enum(["single", "parallel"]),
  tasks: z.array(subAgentTaskSchema).max(8),
});
const runUsageSchema = z.object({
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  estimatedCost: z.number().min(0),
  cacheReadTokens: z.number().min(0).optional(),
  cacheWriteTokens: z.number().min(0).optional(),
  totalTokens: z.number().min(0).optional(),
});
const runPatchSchema = z.object({
  state: runStateSchema,
  round: z.number().int().min(1).max(99),
  summary: z.string().max(8_000),
  diff: z.string().max(200_000),
  findings: z.array(findingSchema).max(100),
  checks: z.array(checkResultSchema).max(16),
  plan: developmentPlanSchema,
  usage: runUsageSchema,
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

// SEC-008 / AT-SEC-005: per-user write limits for credential and run mutations.
const credentialWrites = new RateLimiter(10);
const runCreations = new RateLimiter(Number(process.env.PI_RUN_CREATE_PER_MINUTE || 20));
const runActions = new RateLimiter(Number(process.env.PI_RUN_ACTIONS_PER_MINUTE || 30));

function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
}

function safeTokenMatch(value: string | undefined) {
  if (!value || !internalToken) return false;
  const actual = Buffer.from(value.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(internalToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function workerRequest<T>(pathName: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${workerUrl}${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Worker request failed: ${response.status}`);
  return body as T;
}

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
    return { status: "ok", service: "pigo-web", version: "0.14.5", db: "ok" };
  } catch (error) {
    // AT-REL-005: fail loudly instead of pretending the service is healthy.
    alerts.raise({
      key: "database_unavailable",
      severity: "critical",
      message: "数据库不可用，Web 已降级：运行/事件读写暂停",
      details: { error: (error as Error).message.slice(0, 200) },
    });
    return reply.code(503).send({ status: "degraded", service: "pigo-web", version: "0.14.5", db: "unavailable", code: "DATABASE_UNAVAILABLE" });
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
  const health: Record<string, unknown> = { version: "0.14.5", at: new Date().toISOString() };
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
app.get("/api/me", async (request) => auth.user(request));
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
  for (const write of writes) status = await vault.set(userId, write);
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
  const configured = new Set(vault.configuredProviders(vaultKeyFor(request)));
  return {
    models: availableModels(modelCatalog, configured),
    defaultDeveloper: modelDefaults.developer,
    defaultReviewer: modelDefaults.reviewer,
  };
});

app.get("/api/config/status", async (request): Promise<ConfigStatus> => {
  const credentials = vault.status(vaultKeyFor(request));
  const configured = new Set(credentials.providers.map((item) => item.provider));
  return {
    demoMode,
    piVersion: process.env.PI_VERSION || "1.0.0",
    developer: { provider: modelDefaults.developer.provider, model: modelDefaults.developer.model, credentialConfigured: configured.has(modelDefaults.developer.provider) },
    reviewer: { provider: modelDefaults.reviewer.provider, model: modelDefaults.reviewer.model, credentialConfigured: configured.has(modelDefaults.reviewer.provider) },
    realRunsAvailable: realRunsEnabled && Boolean(internalToken) && configured.has(modelDefaults.developer.provider) && configured.has(modelDefaults.reviewer.provider),
  };
});

app.get("/api/projects", async (_request, reply) => {
  if (!realRunsEnabled) return reply.code(503).send({ error: "Real runs are disabled" });
  try {
    return await workerRequest("/projects");
  } catch (error) {
    return reply.code(503).send({ error: `Worker unavailable: ${(error as Error).message}` });
  }
});

const workspaceRegisterSchema = z.object({ relativePath: z.string().trim().min(1).max(240) });
const workspaceCloneSchema = z.object({ url: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(80) });
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

function workspaceErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceError) return reply.code(error.status).send({ error: error.message, code: error.code });
  const message = (error as Error)?.message ?? String(error);
  // AT-REL-005: a database outage is reported as storage degradation, not as a
  // confusing workspace error.
  if (isStorageFailure(message)) {
    alerts.raise({ key: "storage_failure", severity: "critical", message: "存储不可用：工作区操作无法完成", details: { error: message.slice(0, 200) } });
    return reply.code(503).send({ error: `存储不可用：${message.slice(0, 200)}`, code: "STORAGE_UNAVAILABLE" });
  }
  return reply.code(503).send({ error: `Workspace operation failed: ${message}` });
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
    return reply.code(201).send(await workspaces.register(auth.user(request).id, parsed.data.relativePath));
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

app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    return await workspaces.get(ownerKeysFor(request), request.params.id);
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/workspaces/:id/refresh", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    return await workspaces.refresh(ownerKeysFor(request), request.params.id);
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  const parsed = workspacePatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  try {
    return await workspaces.patch(ownerKeysFor(request), request.params.id, parsed.data);
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  if (!workspacesEnabled) return workspacesDisabled(reply);
  try {
    await workspaces.unregister(ownerKeysFor(request), request.params.id);
    return reply.code(204).send();
  } catch (error) {
    return workspaceErrorReply(reply, error);
  }
});

app.get("/api/runs", async (request) => store.listRuns(ownerKeysFor(request)));

app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return run;
});

app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/api/runs/:id/events", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  const limit = Math.min(Math.max(Number(request.query.limit || 500), 1), 1_000);
  return store.getEvents(request.params.id, Number(request.query.after || 0), limit);
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/stream", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  const after = Number(request.headers["last-event-id"] || request.query.after || 0);
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event: RunEvent) => reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  // AT-REL-008: replay in bounded pages so a client that lagged far behind is
  // caught up without holding every event in web memory.
  const pageSize = 500;
  let cursor = Number.isFinite(after) ? after : 0;
  try {
    for (;;) {
      const page = await store.getEvents(request.params.id, cursor, pageSize);
      for (const event of page) send(event);
      if (page.length === 0) break;
      cursor = page[page.length - 1].seq;
      if (page.length < pageSize) break;
    }
  } catch (error) {
    app.log.error({ error: (error as Error).message, runId: request.params.id }, "event replay failed");
  }
  const unsubscribe = store.subscribe(request.params.id, send);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

app.post("/api/runs", async (request, reply) => {
  const parsed = createRunSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
  const creationLimit = runCreations.check(user.id);
  if (!creationLimit.allowed) return tooManyRequests(reply, creationLimit.retryAfterMs);
  if (parsed.data.mode === "real") {
    // WS-008: real runs may only target the user's own registered, healthy workspaces.
    let workspace: Workspace;
    try {
      workspace = await workspaces.refresh(ownerKeysFor(request), parsed.data.workspaceId!);
    } catch (error) {
      return workspaceErrorReply(reply, error);
    }
    if (workspace.git?.dirty) {
      return reply.code(409).send({
        error: "工作区存在未提交修改，请先提交或清理后再创建真实任务",
        code: "WORKSPACE_DIRTY",
        dirtyFiles: workspace.git.dirtyFiles,
      });
    }
    if (!realRunsEnabled || !internalToken) return reply.code(503).send({ error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" });

    // AT-REL-010: stop accepting new work when the workspace disk is critical.
    const storage = await workerRequest<StorageStatus>("/health/storage").catch(() => undefined);
    if (storage && storage.state === "critical") {
      alerts.raise({
        key: "disk_critical",
        severity: "critical",
        message: "工作区磁盘空间严重不足，已停止接收新任务",
        details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
      });
      return reply.code(507).send({
        error: `磁盘空间不足（剩余 ${Math.round(storage.freeBytes / 1024 / 1024)} MB），已停止接收新任务`,
        code: "DISK_FULL",
      });
    }
    if (storage && storage.state === "low") {
      alerts.raise({
        key: "disk_low",
        severity: "warning",
        message: "工作区磁盘空间偏低，请清理后继续",
        details: { freeBytes: storage.freeBytes, freePercent: storage.freePercent },
      });
    }

    // MODEL-007/008: resolve the exact models and preflight them before queueing.
    const configured = new Set(vault.configuredProviders(vaultKeyFor(request)));
    const developerSelection = parsed.data.developerModel ?? modelDefaults.developer;
    const reviewerSelection = parsed.data.reviewerModel ?? modelDefaults.reviewer;
    const developerCheck = validateModelSelection(modelCatalog, "developer", developerSelection, configured);
    if (!developerCheck.ok) return reply.code(422).send({ error: developerCheck.message, code: developerCheck.code });
    const reviewerCheck = validateModelSelection(modelCatalog, "reviewer", reviewerSelection, configured);
    if (!reviewerCheck.ok) return reply.code(422).send({ error: reviewerCheck.message, code: reviewerCheck.code });

    const credentials = requireCredentials({
      developer: vault.get(vaultKeyFor(request), developerCheck.entry.provider),
      reviewer: vault.get(vaultKeyFor(request), reviewerCheck.entry.provider),
    });
    if (!credentials) {
      return reply.code(403).send({ error: "所选模型的 provider 凭据不完整，请在「模型与凭据」页配置", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    }
    const run = baseRealRun({
      ...parsed.data,
      repository: workspace.rootPath,
      workspaceId: workspace.id,
      developerModel: { provider: developerCheck.entry.provider, model: developerCheck.entry.model },
      reviewerModel: { provider: reviewerCheck.entry.provider, model: reviewerCheck.entry.model },
    }, user.id);
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "真实任务已创建，正在交给隔离 Pi Worker", at: new Date().toISOString() });
    try {
      await dispatchJob(run, parsed.data.checks, {}, credentials);
      credentials.developer = "";
      credentials.reviewer = "";
      return reply.code(201).send(store.getRun(run.id, user.id));
    } catch (error) {
      credentials.developer = "";
      credentials.reviewer = "";
      await store.updateRun(run.id, { state: "failed", summary: (error as Error).message });
      await store.appendEvent({ runId: run.id, round: 1, source: "system", type: "run.failed", message: `Worker 拒绝任务：${(error as Error).message}`, at: new Date().toISOString() });
      return reply.code(503).send({ error: (error as Error).message, runId: run.id });
    }
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
  await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
  await store.appendEvent({ runId: run.id, round: run.round, source: "system", type: "run.cancelled", message: "任务已取消", at: new Date().toISOString() });
  return store.getRun(run.id, ownerKeysFor(request));
});

app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id, ownerKeysFor(request));
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (!["completed", "failed", "cancelled", "needs_human"].includes(run.state)) {
    return reply.code(409).send({ error: `Cannot delete a run in ${run.state}; cancel it first` });
  }
  await store.deleteRun(run.id);
  return reply.code(204).send();
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
      // REL-002: stay queued instead of failing the run; the worker claims it
      // as soon as capacity frees up (or after a restart).
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
  const updated = await store.updateRun(run.id, options.kind === "resume"
    ? { state: "queued", round, maxRounds: Math.max(run.maxRounds, round), summary: "人工恢复：等待 Worker 接收" }
    : { state: "reviewing", summary: "人工触发：重新审核中" });
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

app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (request, reply) => {
  const parsed = resumeSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  return dispatchFollowupJob(request, reply, { kind: "resume", instruction: parsed.data.instruction });
});

app.post<{ Params: { id: string } }>("/api/runs/:id/retry-review", async (request, reply) => {
  return dispatchFollowupJob(request, reply, { kind: "retry-review" });
});

app.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  const parsed = internalUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid internal update", details: parsed.error.issues });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const { patch, event, deliveryId } = parsed.data;
  if (patch) await store.updateRun(run.id, patch as Partial<Run>);
  if (event) await store.appendEvent({ ...event, runId: run.id, at: new Date().toISOString() }, { deliveryId });
  return { ok: true };
});

// ------------------------------------------- internal job + checkpoint API (REL-002/003)

app.get<{ Querystring: { workerId?: string } }>("/api/internal/jobs/pending", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  if (!jobQueue) return reply.code(503).send({ error: "Job queue unavailable" });
  await requeueStaleJobs();
  const jobs = await jobQueue.listPendingJobs({ staleAfterMs: JOB_STALE_MS });
  const payloads: Array<Record<string, unknown>> = [];
  for (const job of jobs) {
    const run = store.getRun(job.runId);
    if (!run) {
      await jobQueue.finishJob(job.id, "failed", "Run missing");
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
    payloads.push({
      jobId: job.id,
      kind: job.kind,
      run,
      checks: Array.isArray(payload.checks) ? payload.checks : [],
      credentials,
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
