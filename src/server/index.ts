import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConfigStatus, CurrentUser, Run, Workspace } from "../shared/types.js";
import { Authenticator } from "./auth.js";
import { CredentialVault } from "./credential-vault.js";
import { createDb, createPool, runMigrations } from "./db.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { IdentityService } from "./identity.js";
import { baseRealRun } from "./real-run.js";
import { RunStore } from "./store.js";
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

const store = new RunStore(dataFile);
const vault = new CredentialVault(vaultFile, vaultSecret);
const auth = new Authenticator();
await Promise.all([store.init(), vault.init()]);

const databaseUrl = process.env.PI_DATABASE_URL;
if (!databaseUrl) throw new Error("PI_DATABASE_URL is required (postgresql://user:password@host:5432/database)");
const pool = createPool(databaseUrl);
const db = createDb(pool);
await runMigrations(db);
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
}).superRefine((value, context) => {
  if (value.mode === "real" && value.checks.length === 0) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Real runs require at least one check command" });
  }
  if (value.mode === "real" && !value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "Real runs require a registered workspace" });
  }
});

const credentialSchema = z.object({
  developerApiKey: z.string().trim().min(12).max(512).optional(),
  reviewerApiKey: z.string().trim().min(12).max(512).optional(),
}).refine((value) => value.developerApiKey || value.reviewerApiKey, "At least one credential is required");

const runStateSchema = z.enum(["queued", "preparing", "developing", "checking", "reviewing", "completed", "needs_human", "failed", "cancelled"]);
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
}).strict();

const credentialWrites = new Map<string, number[]>();
function credentialWriteAllowed(userId: string) {
  const cutoff = Date.now() - 60_000;
  const attempts = (credentialWrites.get(userId) ?? []).filter((value) => value > cutoff);
  attempts.push(Date.now());
  credentialWrites.set(userId, attempts);
  return attempts.length <= 10;
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

/** Credentials written before the internal-user migration live under the legacy owner key. */
function vaultKeyFor(request: FastifyRequest) {
  const user = auth.user(request);
  return user.legacyOwnerId ?? user.id;
}

app.get("/api/health", async (_request, reply) => {
  try {
    await db.query("SELECT 1");
    return { status: "ok", service: "pigo-web", version: "0.7.0", db: "ok" };
  } catch {
    return reply.code(503).send({ status: "error", service: "pigo-web", version: "0.7.0", db: "unavailable" });
  }
});
app.get("/api/me", async (request) => auth.user(request));
app.get("/api/credentials/status", async (request) => vault.status(vaultKeyFor(request)));

app.put("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  if (!credentialWriteAllowed(user.id)) return reply.code(429).send({ error: "Too many credential updates" });
  const parsed = credentialSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid credential request" });
  return vault.set(vaultKeyFor(request), { developer: parsed.data.developerApiKey, reviewer: parsed.data.reviewerApiKey });
});

app.delete("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  if (!credentialWriteAllowed(user.id)) return reply.code(429).send({ error: "Too many credential updates" });
  await vault.delete(vaultKeyFor(request));
  return reply.code(204).send();
});

app.get("/api/config/status", async (request): Promise<ConfigStatus> => {
  const credentials = vault.status(vaultKeyFor(request));
  return {
    demoMode,
    piVersion: process.env.PI_VERSION || "1.0.0",
    developer: { provider: "deepseek", model: process.env.PI_DEVELOPER_MODEL || "deepseek-flash", credentialConfigured: credentials.developerConfigured },
    reviewer: { provider: process.env.PI_REVIEWER_PROVIDER || "openai-proxy", model: process.env.PI_REVIEWER_MODEL || "gpt-5.6-sol", credentialConfigured: credentials.reviewerConfigured },
    realRunsAvailable: realRunsEnabled && Boolean(internalToken) && credentials.developerConfigured && credentials.reviewerConfigured,
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

function workspaceErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceError) return reply.code(error.status).send({ error: error.message, code: error.code });
  return reply.code(503).send({ error: `Workspace operation failed: ${(error as Error).message}` });
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

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  return store.getEvents(request.params.id, Number(request.query.after || 0));
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/stream", async (request, reply) => {
  if (!store.getRun(request.params.id, ownerKeysFor(request))) return reply.code(404).send({ error: "Run not found" });
  const after = Number(request.headers["last-event-id"] || request.query.after || 0);
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event: ReturnType<typeof store.getEvents>[number]) => reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  for (const event of store.getEvents(request.params.id, after)) send(event);
  const unsubscribe = store.subscribe(request.params.id, send);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

app.post("/api/runs", async (request, reply) => {
  const parsed = createRunSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  const user = auth.user(request);
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
    const credentials = vault.get(vaultKeyFor(request));
    if (!credentials) return reply.code(403).send({ error: "Configure both personal model keys before starting a real run", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    const run = baseRealRun({ ...parsed.data, repository: workspace.rootPath, workspaceId: workspace.id }, user.id);
    await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "真实任务已创建，正在交给隔离 Pi Worker", at: new Date().toISOString() });
    try {
      await workerRequest("/jobs", { method: "POST", body: JSON.stringify({ run, checks: parsed.data.checks, credentials }) });
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

app.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  const parsed = internalUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid internal update", details: parsed.error.issues });
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  const { patch, event } = parsed.data;
  if (patch) await store.updateRun(run.id, patch as Partial<Run>);
  if (event) await store.appendEvent({ ...event, runId: run.id, at: new Date().toISOString() });
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

await app.listen({ port, host });
