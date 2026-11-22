import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hasRequiredCredentials } from "../shared/run-roles.js";
import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { gauge, METRICS_CONTENT_TYPE, metricsAuthorized, operationalLabels, processMetrics } from "../shared/operational-metrics.js";
import { storageStateMetrics } from "../shared/job-lease-metrics.js";
import { workerLeaseMetrics } from "./job-lease-metrics.js";
import { apiKeyEnvName } from "./provider-errors.js";
import { PiInputTransportError } from "./pi-cli-input.js";
import { WorkspacePathError, sanitizeRelativePath } from "./workspace-paths.js";
import { RunCleanupPathError, removeRunDirectory } from "./run-cleanup.js";
import { guardText, PI_INPUT_TRANSPORT_TEXT } from "./runtime-locale.js";
import { parseRequirementSpec, renderAcceptanceCriteria, renderRequirementTask, REQUIREMENT_PROMPT_VERSION } from "../shared/requirement-assistant.js";
import { buildRequirementPrompt } from "./requirement-assistant.js";
import { parsePiAssistantOutput, PI_ASSISTANT_PROMPT_VERSION } from "../shared/pi-assistant.js";
import { buildPiAssistantPrompt, sanitizePiAssistantPayload } from "./pi-assistant.js";
import { WorkspaceScmError, type WorkspaceScmCredentialInput } from "./workspace-scm.js";
import { parseExportCredentialContext } from "../shared/export-credential-context.js";
import {
  diagnosticMessage, internalToken, storageStatus, active, maxActiveJobs, runsRoot, shuttingDown,
  workerId,
} from "./worker-runtime.js";
import type { JobInput } from "./worker-runtime.js";
import {
  listProjects, verifyWorkspace, cloneWorkspace, createWorkspace, workspaceRemoteStatus, pushWorkspace,
  generateRunDiff, mergeRunBranch,
} from "./worker-git.js";
import { runPi } from "./pi-cli-runner.js";
import type { WorkerJobs } from "./worker-jobs.js";

const configuredMaxRequirementAssistants = Number(process.env.PI_REQUIREMENT_ASSISTANT_CONCURRENCY || 2);
const maxRequirementAssistants = Number.isInteger(configuredMaxRequirementAssistants)
  ? Math.min(4, Math.max(1, configuredMaxRequirementAssistants))
  : 2;
let activeRequirementAssistants = 0;
const configuredMaxPiAssistants = Number(process.env.PI_ASSISTANT_CONCURRENCY || 2);
const maxPiAssistants = Number.isInteger(configuredMaxPiAssistants)
  ? Math.min(4, Math.max(1, configuredMaxPiAssistants))
  : 2;
let activePiAssistants = 0;
function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  // Only the diagnostic field; success payloads, patches and model JSON remain
  // byte-for-byte unchanged by generic diagnostic rules.
  const output = body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? { ...body, error: diagnosticMessage(body.error) } : body;
  response.end(JSON.stringify(output));
}

// 内部网络（带 token）专用：任务派发载荷会携带完整的 Run 文档，文档随轮次增长
// 已超过 1MB，旧的 1,000,000 字节上限会把「继续开发」拒成 Request body too large。
// 提升到 8MiB 并给出带体积的错误信息；超出仍严格拒绝。
const MAX_INTERNAL_BODY = 8 * 1024 * 1024;

async function readJson(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_INTERNAL_BODY) {
      throw new Error(`Request body too large (${body.length} > ${MAX_INTERNAL_BODY} bytes)`);
    }
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

function authorized(request: IncomingMessage) {
  if (!internalToken) return false;
  const header = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${internalToken}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

export function createWorkerServer({ dispatchJob, pendingJobWake }: Pick<WorkerJobs, "dispatchJob" | "pendingJobWake">) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        const storage = await storageStatus();
        const version = (process.env.PI_WORKER_VERSION ?? "").trim();
        return json(response, 200, { status: "ok", service: "pigo-worker", version: version || null, activeJobs: active.size, storage: storage.state });
      }
      if (request.method === "GET" && url.pathname === "/health/storage") return json(response, 200, await storageStatus());
      if (request.method === "GET" && url.pathname === "/metrics") {
        if (!metricsAuthorized(request.headers.authorization, process.env.PI_METRICS_TOKEN?.trim() || "", internalToken)) return json(response, 401, { error: "Unauthorized" });
        const labels = operationalLabels("pigo-worker", process.env.PI_WORKER_VERSION?.trim() || "unknown");
        const storage = await storageStatus();
        response.writeHead(200, { "Content-Type": METRICS_CONTENT_TYPE, "Cache-Control": "no-store" });
        return response.end(processMetrics(labels) + workerLeaseMetrics.render(labels) + storageStateMetrics(labels, storage.state)
          + gauge("pigo_worker_active_jobs", "Currently admitted Worker jobs.", labels, [{ value: active.size }])
          + gauge("pigo_worker_capacity", "Configured maximum concurrent jobs.", labels, [{ value: maxActiveJobs }]));
      }
      if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
      if (request.method === "GET" && (url.pathname === "/projects" || url.pathname === "/workspaces")) return json(response, 200, await listProjects());
      if (request.method === "POST" && url.pathname === "/workspaces/verify") {
        const body = await readJson(request) as { relativePath?: unknown };
        const relative = sanitizeRelativePath(String(body.relativePath ?? ""));
        if (!relative) return json(response, 200, { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace path" });
        try {
          return json(response, 200, await verifyWorkspace(relative));
        } catch (error) {
          if (error instanceof WorkspacePathError) return json(response, 200, { ok: false, code: error.code, error: error.message });
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/workspaces/clone") {
        const body = await readJson(request) as { url?: unknown; name?: unknown };
        return json(response, 200, await cloneWorkspace(String(body.url ?? ""), String(body.name ?? "")));
      }
      if (request.method === "POST" && url.pathname === "/workspaces/create") {
        const body = await readJson(request) as { name?: unknown };
        return json(response, 200, await createWorkspace(String(body.name ?? "")));
      }
      if (request.method === "POST" && url.pathname === "/workspaces/remote-status") {
        const body = await readJson(request) as { relativePath?: unknown; branch?: unknown; requiredCommit?: unknown; credential?: WorkspaceScmCredentialInput };
        const relativePath = sanitizeRelativePath(String(body.relativePath ?? ""));
        if (!relativePath) return json(response, 422, { error: "Invalid workspace path", code: "WORKSPACE_INVALID" });
        try {
          return json(response, 200, await workspaceRemoteStatus({
            relativePath,
            branch: String(body.branch ?? ""),
            ...(typeof body.requiredCommit === "string" && body.requiredCommit ? { requiredCommit: body.requiredCommit } : {}),
            ...(body.credential ? { credential: body.credential } : {}),
          }));
        } catch (error) {
          if (error instanceof WorkspaceScmError) return json(response, 409, { error: error.message, code: error.code });
          throw error;
        }
      }
      if (request.method === "POST" && ["/workspaces/push", "/workspaces/push-guarded"].includes(url.pathname)) {
        const body = await readJson(request) as { relativePath?: unknown; branch?: unknown; credential?: WorkspaceScmCredentialInput; exportCredentials?: unknown };
        const exportCredentials = body.exportCredentials === undefined && url.pathname === "/workspaces/push"
          ? [] : parseExportCredentialContext(body.exportCredentials);
        if (!exportCredentials) return json(response, 400, { error: "Invalid export credential context", code: "SCM_EXPORT_POLICY_FAILED" });
        const relativePath = sanitizeRelativePath(String(body.relativePath ?? ""));
        if (!relativePath) return json(response, 422, { error: "Invalid workspace path", code: "WORKSPACE_INVALID" });
        try {
          return json(response, 200, await pushWorkspace({
            relativePath,
            branch: String(body.branch ?? ""),
            exportCredentials,
            ...(body.credential ? { credential: body.credential } : {}),
          }));
        } catch (error) {
          const credentials = [...exportCredentials, ...(body.credential?.token ? [body.credential.token] : [])];
          return json(response, error instanceof WorkspaceScmError ? 409 : 500, { error: diagnosticMessage(error, credentials), code: error instanceof WorkspaceScmError ? error.code : "SCM_PUSH_FAILED" });
        }
      }
      if (request.method === "POST" && url.pathname === "/requirements/refine") {
        if (activeRequirementAssistants >= maxRequirementAssistants) {
          return json(response, 429, { error: "Requirement assistant capacity reached", code: "REQUIREMENT_ASSISTANT_BUSY" });
        }
        const body = await readJson(request) as {
          draft?: unknown;
          title?: unknown;
          locale?: unknown;
          provider?: unknown;
          model?: unknown;
          apiKey?: unknown;
          context?: unknown;
        };
        const draft = typeof body.draft === "string" ? body.draft.trim() : "";
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        const provider = typeof body.provider === "string" ? body.provider.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        const rawContext = body.context && typeof body.context === "object" && !Array.isArray(body.context)
          ? body.context as Record<string, unknown>
          : {};
        const source = rawContext.source === "story" ? "story" : "run";
        const context = {
          source,
          ...(typeof rawContext.projectName === "string" ? { projectName: rawContext.projectName.trim().slice(0, 120) } : {}),
          ...(typeof rawContext.workspaceName === "string" ? { workspaceName: rawContext.workspaceName.trim().slice(0, 120) } : {}),
        } as const;
        if (draft.length < 10 || draft.length > 10_000 || !provider || !model || !apiKey) {
          return json(response, 400, { error: "Invalid requirement refinement input", code: "REQUIREMENT_INPUT_INVALID" });
        }
        activeRequirementAssistants += 1;
        const startedAt = Date.now();
        try {
          const scratch = path.join(runsRoot, "_requirement-assistant");
          await mkdir(scratch, { recursive: true });
          const locale = body.locale === "en" ? "en" : "zh";
          const result = await runPi({
            cwd: scratch,
            provider,
            model,
            prompt: buildRequirementPrompt({ draft, title, context }, locale),
            readOnly: true,
            thinking: "low",
            apiKey,
            apiKeyEnvironmentName: apiKeyEnvName(provider),
            signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.PI_REQUIREMENT_ASSISTANT_TIMEOUT_MS || 25_000))),
            onActivity: async () => undefined,
            role: "planner",
            allowPlugins: false,
            tools: "",
            timeoutMs: Math.max(5_000, Number(process.env.PI_REQUIREMENT_ASSISTANT_TIMEOUT_MS || 25_000)),
          });
          const spec = parseRequirementSpec(result.text);
          return json(response, 200, {
            spec,
            task: renderRequirementTask(spec, locale),
            acceptanceCriteria: renderAcceptanceCriteria(spec),
            model: { provider, model },
            durationMs: Date.now() - startedAt,
            usage: {
              inputTokens: Math.round(result.usage.input),
              outputTokens: Math.round(result.usage.output),
              totalTokens: Math.round(result.usage.totalTokens || result.usage.input + result.usage.output),
              estimatedCost: result.usage.cost,
            },
            promptVersion: REQUIREMENT_PROMPT_VERSION,
          });
        } catch (error) {
          if (error instanceof PiInputTransportError) return json(response, 422, {
            error: guardText(PI_INPUT_TRANSPORT_TEXT, body.locale === "en" ? "en" : "zh").message,
            code: error.code,
          });
          const safe = diagnosticMessage(error, [apiKey], 500);
          return json(response, 502, { error: safe, code: "REQUIREMENT_ASSISTANT_FAILED" });
        } finally {
          body.apiKey = "";
          activeRequirementAssistants -= 1;
        }
      }
      if (request.method === "POST" && url.pathname === "/assistant/ask") {
        if (activePiAssistants >= maxPiAssistants) {
          return json(response, 429, { error: "Pi assistant capacity reached", code: "PI_ASSISTANT_BUSY" });
        }
        const body = await readJson(request) as Record<string, unknown>;
        const input = sanitizePiAssistantPayload(body);
        const provider = typeof body.provider === "string" ? body.provider.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        if (!input.message || !provider || !model || !apiKey) {
          return json(response, 400, { error: "Invalid Pi assistant input", code: "PI_ASSISTANT_INPUT_INVALID" });
        }
        activePiAssistants += 1;
        const startedAt = Date.now();
        try {
          const scratch = path.join(runsRoot, "_pi-assistant");
          await mkdir(scratch, { recursive: true });
          const locale = body.locale === "en" ? "en" : "zh";
          const result = await runPi({
            cwd: scratch,
            provider,
            model,
            prompt: buildPiAssistantPrompt(input, locale),
            readOnly: true,
            thinking: "low",
            apiKey,
            apiKeyEnvironmentName: apiKeyEnvName(provider),
            signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.PI_ASSISTANT_TIMEOUT_MS || 30_000))),
            onActivity: async () => undefined,
            role: "planner",
            allowPlugins: false,
            tools: "",
            timeoutMs: Math.max(5_000, Number(process.env.PI_ASSISTANT_TIMEOUT_MS || 30_000)),
          });
          const answer = parsePiAssistantOutput(result.text);
          return json(response, 200, {
            ...answer,
            model: { provider, model },
            durationMs: Date.now() - startedAt,
            usage: {
              inputTokens: Math.round(result.usage.input),
              outputTokens: Math.round(result.usage.output),
              totalTokens: Math.round(result.usage.totalTokens || result.usage.input + result.usage.output),
              estimatedCost: result.usage.cost,
            },
            promptVersion: PI_ASSISTANT_PROMPT_VERSION,
          });
        } catch (error) {
          if (error instanceof PiInputTransportError) return json(response, 422, {
            error: guardText(PI_INPUT_TRANSPORT_TEXT, body.locale === "en" ? "en" : "zh").message,
            code: error.code,
          });
          const safe = diagnosticMessage(error, [apiKey], 500);
          return json(response, 502, { error: safe, code: "PI_ASSISTANT_FAILED" });
        } finally {
          body.apiKey = "";
          activePiAssistants -= 1;
        }
      }
      if (request.method === "POST" && url.pathname === "/jobs/wake") {
        if (shuttingDown) return json(response, 503, { error: "Worker is stopping", code: "WORKER_SHUTTING_DOWN" });
        const storage = await storageStatus();
        if (storage.state === "unknown") return json(response, 503, { error: "Workspace storage status is unknown", code: "STORAGE_UNKNOWN" });
        if (storage.state === "critical") return json(response, 507, { error: "Disk space critically low; refusing new jobs", code: "STORAGE_CRITICAL" });
        pendingJobWake.wake();
        return json(response, 202, { accepted: true, queued: true });
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        // P1: a shutting-down worker stops claiming new jobs so it can reclaim its
        // sandbox containers without racing a new run.
        if (shuttingDown) return json(response, 503, { error: "Worker 正在停止，暂不接受新任务，请稍后重试", code: "WORKER_SHUTTING_DOWN" });
        const body = await readJson(request) as unknown as JobInput;
        if (!body.run?.id || body.run.mode !== "real" || !Array.isArray(body.checks) || !hasRequiredCredentials(body.run, body.credentials)) return json(response, 400, { error: "Invalid job" });
        // Dispatch is at-least-once: a run already executing locally is not an error.
        if (active.has(body.run.id)) return json(response, 202, { accepted: true, runId: body.run.id, note: "already running" });
        if (active.size >= maxActiveJobs) return json(response, 429, { error: "Worker capacity reached; retry after an active job finishes", code: "WORKER_CAPACITY" });
        const storage = await storageStatus();
        if (storage.state === "unknown") {
          return json(response, 503, { error: "Workspace storage status is unknown; refusing new jobs", code: "STORAGE_UNKNOWN" });
        }
        if (storage.state === "critical") {
          return json(response, 507, { error: `Disk space critically low (${Math.round(storage.freeBytes / 1024 / 1024)} MB free); refusing new jobs`, code: "STORAGE_CRITICAL" });
        }
        const controller = new AbortController();
        active.set(body.run.id, controller);
        void dispatchJob(body, controller).catch((error) => {
          active.delete(body.run.id);
          console.error(`[jobs] job ${body.run.id} failed to start: ${diagnosticMessage(error, Object.values(body.credentials))}`);
        });
        return json(response, 202, { accepted: true, runId: body.run.id });
      }
      if (request.method === "GET" && url.pathname === "/jobs/capacity") {
        return json(response, 200, { workerId, capacity: maxActiveJobs - active.size, active: [...active.keys()] });
      }
      const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const controller = active.get(cancelMatch[1]);
        if (!controller) return json(response, 404, { error: "Active job not found" });
        controller.abort();
        return json(response, 202, { cancelled: true });
      }
      // GAP-04: owner-scoped removal of a finished run's on-disk directory tree.
      const cleanupMatch = url.pathname.match(/^\/runs\/([^/]+)\/cleanup$/);
      if (request.method === "POST" && cleanupMatch) {
        const runId = decodeURIComponent(cleanupMatch[1]);
        // Never delete the working directory of a job this worker is running.
        if (active.has(runId)) return json(response, 409, { error: "Run is still active on this worker", code: "RUN_ACTIVE" });
        const body = await readJson(request) as { ownerId?: unknown; dryRun?: unknown };
        try {
          const result = await removeRunDirectory({
            runsRoot,
            ownerId: String(body.ownerId ?? ""),
            runId,
            dryRun: body.dryRun === true,
          });
          return json(response, 200, result);
        } catch (error) {
          if (error instanceof RunCleanupPathError) return json(response, 400, { error: error.message, code: error.code });
          throw error;
        }
      }
      // A1: regenerate a run's full patch from its run directory on demand.
      const diffMatch = url.pathname.match(/^\/runs\/([^/]+)\/diff$/);
      if (request.method === "POST" && diffMatch) {
        const runId = decodeURIComponent(diffMatch[1]);
        const body = await readJson(request) as { ownerId?: unknown; baseSha?: unknown };
        const result = await generateRunDiff({
          ownerId: String(body.ownerId ?? ""),
          runId,
          baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
        });
        if (!result.ok) return json(response, result.status, result);
        return json(response, 200, result);
      }
      // A2: merge a run branch into the workspace default branch (admin-gated at
      // the web layer). Never force-pushes; conflicts abort and leave the repo as-is.
      const mergeMatch = url.pathname.match(/^\/runs\/([^/]+)\/merge$/);
      if (request.method === "POST" && mergeMatch) {
        const runId = decodeURIComponent(mergeMatch[1]);
        if (active.has(runId)) return json(response, 409, { ok: false, code: "RUN_ACTIVE", error: "任务仍在执行，无法合并" });
        const body = await readJson(request) as { ownerId?: unknown; repository?: unknown; branch?: unknown; targetBranch?: unknown; message?: unknown };
        const repository = String(body.repository ?? "");
        const branch = String(body.branch ?? "");
        if (!repository || !branch) return json(response, 400, { ok: false, code: "MERGE_INPUT_INVALID", error: "repository and branch are required" });
        const result = await mergeRunBranch({
          ownerId: String(body.ownerId ?? ""),
          runId,
          repository,
          branch,
          targetBranch: typeof body.targetBranch === "string" ? body.targetBranch : undefined,
          message: typeof body.message === "string" ? body.message : undefined,
        });
        if (!result.ok) return json(response, result.status, result);
        return json(response, 200, result);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 500, { error: diagnosticMessage(error) });
    }
  });
}
