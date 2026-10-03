import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConfigStatus, Run } from "../shared/types.js";
import { Authenticator } from "./auth.js";
import { CredentialVault } from "./credential-vault.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { baseRealRun } from "./real-run.js";
import { RunStore } from "./store.js";

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

const createRunSchema = z.object({
  title: z.string().trim().min(2).max(80),
  task: z.string().trim().min(10).max(10_000),
  repository: z.string().trim().max(240).default("demo/auth-service"),
  mode: z.enum(["demo", "real"]).default("demo"),
  checks: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
}).superRefine((value, context) => {
  if (value.mode === "real" && value.checks.length === 0) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Real runs require at least one check command" });
  }
  if (value.mode === "real" && (!/^[a-zA-Z0-9._/-]+$/.test(value.repository) || value.repository.includes(".."))) {
    context.addIssue({ code: "custom", path: ["repository"], message: "Invalid project path" });
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
  return auth.authenticate(request, reply);
});

app.get("/api/health", async () => ({ status: "ok", service: "pigo-web", version: "0.3.0" }));
app.get("/api/me", async (request) => auth.user(request));
app.get("/api/credentials/status", async (request) => vault.status(auth.user(request).id));

app.put("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  if (!credentialWriteAllowed(user.id)) return reply.code(429).send({ error: "Too many credential updates" });
  const parsed = credentialSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid credential request" });
  return vault.set(user.id, { developer: parsed.data.developerApiKey, reviewer: parsed.data.reviewerApiKey });
});

app.delete("/api/credentials", async (request, reply) => {
  const user = auth.user(request);
  if (!credentialWriteAllowed(user.id)) return reply.code(429).send({ error: "Too many credential updates" });
  await vault.delete(user.id);
  return reply.code(204).send();
});

app.get("/api/config/status", async (request): Promise<ConfigStatus> => {
  const credentials = vault.status(auth.user(request).id);
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

app.get("/api/runs", async (request) => store.listRuns(auth.user(request).id));

app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id, auth.user(request).id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return run;
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (request, reply) => {
  if (!store.getRun(request.params.id, auth.user(request).id)) return reply.code(404).send({ error: "Run not found" });
  return store.getEvents(request.params.id, Number(request.query.after || 0));
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/stream", async (request, reply) => {
  if (!store.getRun(request.params.id, auth.user(request).id)) return reply.code(404).send({ error: "Run not found" });
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
    if (!realRunsEnabled || !internalToken) return reply.code(503).send({ error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" });
    const credentials = vault.get(user.id);
    if (!credentials) return reply.code(403).send({ error: "Configure both personal model keys before starting a real run", code: "PERSONAL_CREDENTIALS_REQUIRED" });
    const run = baseRealRun(parsed.data, user.id);
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
  const run = store.getRun(request.params.id, auth.user(request).id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (["completed", "failed", "cancelled"].includes(run.state)) return reply.code(409).send({ error: `Cannot cancel run in ${run.state}` });
  if (run.mode === "real") await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
  await store.appendEvent({ runId: run.id, round: run.round, source: "system", type: "run.cancelled", message: "任务已取消", at: new Date().toISOString() });
  return store.getRun(run.id, auth.user(request).id);
});

app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id, auth.user(request).id);
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

await app.listen({ port, host });
