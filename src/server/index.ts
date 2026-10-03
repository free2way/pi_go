import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConfigStatus, Run } from "../shared/types.js";
import { baseDemoRun, runDemo } from "./demo-runner.js";
import { baseRealRun } from "./real-run.js";
import { RunStore } from "./store.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || "localhost";
const demoMode = process.env.PI_DEMO_MODE !== "false";
const realRunsEnabled = process.env.PI_REAL_RUNS_ENABLED === "true";
const workerUrl = process.env.PI_WORKER_URL || "http://worker:3200";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
const dataFile = process.env.PI_DATA_FILE || path.resolve("data/runs.json");
const store = new RunStore(dataFile);
await store.init();

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

app.get("/api/health", async () => ({ status: "ok", service: "pigo-web", version: "0.1.0" }));

app.get("/api/config/status", async (): Promise<ConfigStatus> => {
  const developerConfigured = process.env.PI_DEVELOPER_CREDENTIAL_CONFIGURED === "true";
  const reviewerConfigured = process.env.PI_REVIEWER_CREDENTIAL_CONFIGURED === "true";
  return {
    demoMode,
    piVersion: process.env.PI_VERSION || "1.0.0",
    developer: {
      provider: "deepseek",
      model: process.env.PI_DEVELOPER_MODEL || "deepseek-flash",
      credentialConfigured: developerConfigured,
    },
    reviewer: {
      provider: process.env.PI_REVIEWER_PROVIDER || "openai-proxy",
      model: process.env.PI_REVIEWER_MODEL || "gpt-5.6-sol",
      credentialConfigured: reviewerConfigured,
    },
    realRunsAvailable: realRunsEnabled && Boolean(internalToken),
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

app.get("/api/runs", async () => store.listRuns());

app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return run;
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
  "/api/runs/:id/events",
  async (request, reply) => {
    if (!store.getRun(request.params.id)) return reply.code(404).send({ error: "Run not found" });
    return store.getEvents(request.params.id, Number(request.query.after || 0));
  },
);

app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
  "/api/runs/:id/stream",
  async (request, reply) => {
    if (!store.getRun(request.params.id)) return reply.code(404).send({ error: "Run not found" });
    const after = Number(request.headers["last-event-id"] || request.query.after || 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: ReturnType<typeof store.getEvents>[number]) => {
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of store.getEvents(request.params.id, after)) send(event);
    const unsubscribe = store.subscribe(request.params.id, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  },
);

app.post("/api/runs", async (request, reply) => {
  const parsed = createRunSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
  if (parsed.data.mode === "real") {
    if (!realRunsEnabled || !internalToken) {
      return reply.code(503).send({ error: "Real agent execution is disabled", code: "REAL_RUNNER_NOT_AVAILABLE" });
    }
    const run = baseRealRun(parsed.data);
    await store.createRun(run, {
      runId: run.id,
      round: 1,
      source: "system",
      type: "run.created",
      message: "真实任务已创建，正在交给隔离 Pi Worker",
      at: new Date().toISOString(),
    });
    try {
      await workerRequest("/jobs", { method: "POST", body: JSON.stringify({ run, checks: parsed.data.checks }) });
      return reply.code(201).send(store.getRun(run.id));
    } catch (error) {
      await store.updateRun(run.id, { state: "failed", summary: (error as Error).message });
      await store.appendEvent({ runId: run.id, round: 1, source: "system", type: "run.failed", message: `Worker 拒绝任务：${(error as Error).message}`, at: new Date().toISOString() });
      return reply.code(503).send({ error: (error as Error).message, runId: run.id });
    }
  }
  if (!demoMode) return reply.code(403).send({ error: "Demo mode is disabled" });
  const run = baseDemoRun(parsed.data);
  await store.createRun(run, {
    runId: run.id,
    round: 1,
    source: "system",
    type: "run.created",
    message: "演示任务已创建；所有 Agent 活动均为可视化演示数据",
    at: new Date().toISOString(),
  });
  void runDemo(store, run.id);
  return reply.code(201).send(run);
});

app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (["completed", "failed", "cancelled"].includes(run.state)) {
    return reply.code(409).send({ error: `Cannot cancel run in ${run.state}` });
  }
  if (run.mode === "real") {
    await workerRequest(`/jobs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  }
  await store.updateRun(run.id, { state: "cancelled", summary: "已由用户取消" });
  await store.appendEvent({
    runId: run.id,
    round: run.round,
    source: "system",
    type: "run.cancelled",
    message: "任务已取消",
    at: new Date().toISOString(),
  });
  return store.getRun(run.id);
});

app.post<{ Params: { id: string } }>("/api/internal/runs/:id/update", async (request, reply) => {
  if (!safeTokenMatch(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  const body = request.body as {
    patch?: Record<string, unknown>;
    event?: { round: number; source: "system" | "developer" | "checks" | "reviewer"; type: string; message: string };
  };
  const run = store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  if (body.patch) await store.updateRun(run.id, body.patch as Partial<Run>);
  if (body.event) {
    await store.appendEvent({ ...body.event, runId: run.id, at: new Date().toISOString() });
  }
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
