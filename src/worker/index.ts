import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { CheckResult, DevelopmentPlan, Finding, ProjectInfo, Run, RunEvent, RunRoleUsage, RunState, RunUsage, SubAgentTask, WorkspaceVerifyResult } from "../shared/types.js";
import { CheckpointTracker, memoryCheckpointClient, stages, type Checkpoint, type CheckpointClient, type StoredChecks, type StoredReview } from "./checkpoints.js";
import { conflictFreeBatches, executionWaves, fallbackPlan, parseDevelopmentPlan } from "./orchestrator.js";
import { UsageTracker, addUsage, assistantErrorFromEvent, assistantTextFromEvent, emptyUsage, toRunUsage, toolNameFromEvent, type UsageTotals } from "./pi-events.js";
import { DockerApi } from "./docker-api.js";
import { budgetWarningMessage, evaluateBudget, mergeRoleUsage, readBudgetLimits } from "./budget.js";
import { scrubEnvironment } from "./pi-env.js";
import { apiKeyEnvName, classifyProviderError, providerErrorSummary } from "./provider-errors.js";
import { sleep, withProviderRetry } from "./provider-retry.js";
import { parseReview, type ReviewResult } from "./review-protocol.js";
import { buildContainerSpec, hostPathFor, resolveSandboxMode } from "./sandbox.js";
import { mergeFindings, unresolvedFeedback } from "./review-findings.js";
import { WorkspacePathError, resolveInsideRoot, sanitizeRelativePath, sanitizeWorkspaceName, validateCloneUrl } from "./workspace-paths.js";

const port = Number(process.env.PORT || 3200);
const host = process.env.HOST || "localhost";
const workspaceRoot = path.resolve(process.env.PI_WORKSPACE_ROOT || "/workspace");
const projectsRoot = path.join(workspaceRoot, "projects");
const runsRoot = path.join(workspaceRoot, "runs");
const callbackBase = process.env.PI_WEB_CALLBACK_URL || "http://web:3100";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
const maxOutput = 48_000;
const configuredMaxSubagents = Number(process.env.PI_MAX_SUBAGENTS || 3);
const maxSubagents = Number.isInteger(configuredMaxSubagents) ? Math.min(4, Math.max(1, configuredMaxSubagents)) : 3;
const configuredMaxActiveJobs = Number(process.env.PI_MAX_ACTIVE_JOBS || 1);
const maxActiveJobs = Number.isInteger(configuredMaxActiveJobs) ? Math.min(4, Math.max(1, configuredMaxActiveJobs)) : 1;
const active = new Map<string, AbortController>();
const minFreeDiskMb = Math.max(64, Number(process.env.PI_MIN_FREE_DISK_MB || 2048));
// Critical is a quarter of the configured minimum (2048 MB -> 512 MB by default),
// so raising PI_MIN_FREE_DISK_MB also scales the hard stop threshold.
const criticalFreeDiskMb = Math.max(32, Number(process.env.PI_CRITICAL_FREE_DISK_MB || Math.round(minFreeDiskMb / 4)));

export type StorageStatus = {
  state: "ok" | "low" | "critical";
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
  path: string;
};

/**
 * AT-REL-010: reports workspace disk headroom so new work stops before the
 * source repositories or their worktrees are damaged by a full disk.
 */
async function storageStatus(): Promise<StorageStatus> {
  try {
    const stats = await statfs(workspaceRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeMb = freeBytes / 1024 / 1024;
    const state = freeMb <= criticalFreeDiskMb ? "critical" : freeMb <= minFreeDiskMb ? "low" : "ok";
    return { state, freeBytes, totalBytes, freePercent: totalBytes ? Number(((freeBytes / totalBytes) * 100).toFixed(2)) : 0, path: workspaceRoot };
  } catch (error) {
    console.warn(`[storage] statfs failed: ${(error as Error).message}`);
    return { state: "ok", freeBytes: -1, totalBytes: -1, freePercent: -1, path: workspaceRoot };
  }
}
let worktreeMutationQueue: Promise<void> = Promise.resolve();

function serializeWorktreeMutation<T>(operation: () => Promise<T>) {
  const result = worktreeMutationQueue.then(operation, operation);
  worktreeMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

type JobInput = {
  run: Run;
  checks: string[];
  credentials: {
    developer: string;
    reviewer: string;
  };
  /** Persisted job row used for heartbeats and stale-worker recovery (REL-002). */
  jobId?: string;
  /** True when this execution resumes a job that a previous worker left unfinished. */
  recovery?: boolean;
  /** Human-in-the-loop resume: reuse the existing worktree and continue with the next round. */
  resume?: { instruction?: string };
  /** Human-in-the-loop: re-run only the reviewer against the current worktree. */
  retryReview?: boolean;
};

const workerId = process.env.PI_WORKER_ID || `worker-${process.pid}`;

// SEC-004 / AT-SEC-007:每次 Agent 调用与检查命令都在独立容器中执行，只挂载本次
// 运行的 worktree（及其仓库 .git 元数据）、只读模型定义与本次运行的 Pi 状态目录。
const sandboxImage = process.env.PI_SANDBOX_IMAGE || "local/pigo-sandbox:0.1.0";
/** Network used for agent calls (provider egress). Checks always run with none. */
const agentNetwork = process.env.PI_SANDBOX_NETWORK || "pi-agent-network";
const hostWorkspaceRoot = process.env.PI_HOST_WORKSPACE_ROOT || workspaceRoot;
const docker = new DockerApi();
let sandboxMode: "container" | "process" = "process";
let sandboxReason: string | undefined = "not initialised";

const imageForSandbox = sandboxImage;
/** Extra bind mounts for the sandbox container (operator/test escape hatch). */
const sandboxExtraBinds = (process.env.PI_SANDBOX_EXTRA_BINDS || "").split(",").map((item) => item.trim()).filter(Boolean);
/** Extra environment variable names to pass through into the sandbox. */
const sandboxExtraEnv = (process.env.PI_SANDBOX_EXTRA_ENV || "").split(",").map((item) => item.trim()).filter(Boolean);

/** Environment handed to a sandboxed process: nothing but runtime basics and the role credential. */
function sandboxEnvironment(extra: Record<string, string>) {
  const passthrough = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "OPENAI_BASE_URL", ...sandboxExtraEnv];
  const env: Record<string, string> = {};
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = "/home/node";
  return { ...env, ...extra };
}

/** Resolves the repository that owns a git worktree (its `.git` points at `<repo>/.git/worktrees/<name>`). */
async function repositoryForWorktree(worktree: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(worktree, ".git"), "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return undefined;
    return path.dirname(path.dirname(path.dirname(match[1].trim())));
  } catch {
    return undefined;
  }
}

interface SandboxRunInput {
  argv: string[];
  worktree: string;
  repository?: string;
  env: Record<string, string>;
  network: string;
  timeoutMs: number;
  signal: AbortSignal;
  onStdoutLine?: (line: string) => void;
  label: string;
}

/** Runs one invocation inside its own container and always cleans it up. */
async function runInSandbox(input: SandboxRunInput): Promise<CommandResult> {
  // Kept next to (never inside) the worktree so sandbox state cannot leak into
  // the diff or the committed tree.
  const runStateDir = `${input.worktree}.state`;
  // The state directory (and its agent subdirectory) must exist and be owned by
  // the container user before the container starts: the bind for the read-only
  // model definition would otherwise create it as root and Pi could not write
  // its session/credential store.
  await mkdir(path.join(runStateDir, "agent"), { recursive: true });
  const spec = buildContainerSpec({
    image: imageForSandbox,
    worktree: input.worktree,
    hostWorktreePath: hostPathFor(input.worktree, workspaceRoot, hostWorkspaceRoot),
    repositoryPath: input.repository,
    hostRepositoryPath: input.repository ? hostPathFor(input.repository, workspaceRoot, hostWorkspaceRoot) : undefined,
    modelsFile: "/home/node/.pi/agent/models.json",
    hostModelsFile: process.env.PI_SANDBOX_MODELS_FILE || path.resolve("/app/pi-models.json"),
    stateDir: "/home/node/.pi",
    stateMount: "bind",
    hostStateDir: hostPathFor(runStateDir, workspaceRoot, hostWorkspaceRoot),
    env: input.env,
    argv: input.argv,
    network: input.network,
    labels: { "pigo.label": input.label.slice(0, 60) },
  });
  spec.HostConfig.Binds.push(...sandboxExtraBinds);

  const name = `pigo-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const containerId = await docker.createContainer(name, spec);
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => { void docker.killContainer(containerId).catch(() => undefined); }, input.timeoutMs);
  const onAbort = () => { void docker.killContainer(containerId).catch(() => undefined); };
  try {
    input.signal.addEventListener("abort", onAbort, { once: true });
    await docker.startContainer(containerId);
    // Logs are read after the container starts: Docker only exposes the full
    // log of a started container, and `follow=1` then streams to completion.
    const logs = docker.logsFollow(containerId, (line, stream) => {
      if (stream === "stderr") {
        stderr += `${line}\n`;
        return;
      }
      stdout += `${line}\n`;
      input.onStdoutLine?.(line);
    }, input.signal).catch((error) => { stderr += String(error.message); });
    const { StatusCode } = await docker.waitContainer(containerId);
    await logs;
    return { code: StatusCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    await docker.removeContainer(containerId).catch(() => undefined);
    await rm(runStateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function internalRequest(pathName: string, init?: RequestInit) {
  const response = await fetch(`${callbackBase}/api/internal${pathName}`, {
    ...init,
    headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || `Internal request failed: ${response.status}`));
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

const jobApi = {
  claim: (jobId: string) => internalRequest(`/jobs/${encodeURIComponent(jobId)}/claim`, { method: "POST", body: JSON.stringify({ workerId }) }),
  heartbeat: (jobId: string) => internalRequest(`/jobs/${encodeURIComponent(jobId)}/heartbeat`, { method: "POST", body: JSON.stringify({ workerId }) }),
  finish: (jobId: string, state: string, error?: string) => internalRequest(`/jobs/${encodeURIComponent(jobId)}/finish`, { method: "POST", body: JSON.stringify({ workerId, state, error }) }),
  pending: async () => (await internalRequest(`/jobs/pending?workerId=${encodeURIComponent(workerId)}`)).jobs as PendingJob[],
};

type PendingJob = {
  jobId: string;
  kind: string;
  run: Run;
  checks: string[];
  credentials: { developer: string; reviewer: string };
};

/** Keeps a claimed job's heartbeat fresh so only a truly dead worker is reclaimed. */
function startJobHeartbeat(jobId: string | undefined) {
  if (!jobId) return () => undefined;
  void jobApi.claim(jobId).catch((error) => console.warn(`[jobs] claim failed: ${(error as Error).message}`));
  const timer = setInterval(() => {
    void jobApi.heartbeat(jobId).catch((error) => console.warn(`[jobs] heartbeat failed: ${(error as Error).message}`));
  }, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function loadTracker(runId: string) {
  try {
    return await new CheckpointTracker(checkpointClient, runId).load();
  } catch (error) {
    console.warn(`[checkpoints] unavailable for ${runId}: ${(error as Error).message}`);
    return new CheckpointTracker(memoryCheckpointClient(), runId);
  }
}

function redactJobSecrets(message: string, credentials: JobInput["credentials"]) {
  return [credentials.developer, credentials.reviewer].reduce(
    (safe, secret) => secret ? safe.replaceAll(secret, "[redacted]") : safe,
    message,
  );
}

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

function authorized(request: IncomingMessage) {
  if (!internalToken) return false;
  const header = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${internalToken}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

const maxCallbackBytes = 3 * 1024 * 1024;

function encodeCallbackBody(input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}) {
  let body = JSON.stringify(input);
  if (Buffer.byteLength(body) <= maxCallbackBytes) return body;
  const patch = input.patch as Record<string, unknown> | undefined;
  if (patch && typeof patch.diff === "string") patch.diff = patch.diff.slice(0, 400_000);
  body = JSON.stringify(input);
  if (Buffer.byteLength(body) > maxCallbackBytes && Array.isArray(patch?.checks)) {
    for (const check of patch.checks as Array<Record<string, unknown>>) {
      if (typeof check.output === "string") check.output = check.output.slice(-4_000);
    }
    body = JSON.stringify(input);
  }
  if (Buffer.byteLength(body) > maxCallbackBytes) throw new Error("Callback payload exceeds the 3 MiB safety limit");
  return body;
}

async function postUpdate(runId: string, input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}) {
  let response: Response;
  try {
    response = await fetch(`${callbackBase}/api/internal/runs/${runId}/update`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalToken}`,
        "Content-Type": "application/json",
      },
      body: encodeCallbackBody(input),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // AT-REL-007: an unreachable store is a storage failure, never a success.
    throw new Error(`Callback failed: ${(error as Error).message || "store unreachable"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Callback failed: ${response.status} ${body.slice(0, 200)}`);
  }
}

async function update(run: Run, state: RunState, source: RunEvent["source"], type: string, message: string, patch: Partial<Run> = {}) {
  Object.assign(run, patch, { state });
  await postUpdate(run.id, {
    patch: { state, ...patch },
    event: { round: run.round, source, type, message },
  });
}

type CommandResult = { code: number; stdout: string; stderr: string };

function command(commandName: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 1_800_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-maxOutput);
      options.onStdoutLine?.(line);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-maxOutput); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.name === "AbortError") resolve({ code: 130, stdout, stderr: "aborted" });
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await command("git", args, { cwd, signal, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function resolveProject(relative: string) {
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid project path");
  }
  const root = await realpath(projectsRoot);
  const candidate = await realpath(path.join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("Project is outside allowed root");
  if ((await git(candidate, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("Project is not a Git repository");
  return candidate;
}

async function listProjects(): Promise<ProjectInfo[]> {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(projectsRoot, entry.name);
    try {
      await stat(path.join(directory, ".git"));
      projects.push({
        id: entry.name,
        name: entry.name,
        relativePath: entry.name,
        branch: await git(directory, ["branch", "--show-current"]),
        dirty: Boolean(await git(directory, ["status", "--porcelain"])),
      });
    } catch {
      // Ignore non-Git directories.
    }
  }
  return projects;
}

function redactCredentials(value: string) {
  return value.replace(/\/\/[^@/\s]*@/g, "//***@");
}

async function verifyWorkspace(relativePath: string): Promise<WorkspaceVerifyResult> {
  const candidate = await resolveInsideRoot(projectsRoot, relativePath);
  const isGit = await git(candidate, ["rev-parse", "--is-inside-work-tree"]).then((value) => value === "true").catch(() => false);
  if (!isGit) return { ok: false, code: "WORKSPACE_INVALID", error: "Not a Git repository" };
  const branch = await git(candidate, ["branch", "--show-current"]).catch(() => "");
  const head = await git(candidate, ["rev-parse", "HEAD"]).catch(() => "");
  const status = await git(candidate, ["status", "--porcelain"]).catch(() => "");
  const dirty = Boolean(status);
  const dirtyFiles = status
    ? status.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20).map((line) => line.slice(0, 200))
    : [];
  return {
    ok: true,
    relativePath,
    canonicalPath: candidate,
    name: path.basename(candidate),
    branch: branch || undefined,
    head: head || undefined,
    dirty,
    dirtyFiles,
  };
}

async function cloneWorkspace(url: string, name: string): Promise<WorkspaceVerifyResult> {
  const urlError = validateCloneUrl(url);
  if (urlError) return { ok: false, code: "WORKSPACE_INVALID", error: urlError };
  const cleanName = sanitizeWorkspaceName(name);
  if (!cleanName) return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace name" };
  const root = await realpath(projectsRoot).catch(() => projectsRoot);
  const target = path.join(root, cleanName);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace target" };
  }
  const exists = await stat(target).then(() => true).catch(() => false);
  if (exists) return { ok: false, code: "WORKSPACE_EXISTS", error: `Directory already exists: ${cleanName}` };
  const result = await command("git", ["clone", "--quiet", url, target], { cwd: root, timeoutMs: 600_000 });
  if (result.code !== 0) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    const reason = redactCredentials(`${result.stderr}\n${result.stdout}`.trim()).slice(0, 500);
    return { ok: false, code: "CLONE_FAILED", error: reason || "git clone failed" };
  }
  return verifyWorkspace(cleanName);
}

function parsePiLine(line: string) {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
}

async function runPi(input: {
  cwd: string;
  provider: string;
  model: string;
  prompt: string;
  sessionId?: string;
  readOnly?: boolean;
  /** Reasoning effort for Pi (planner uses a cheaper level, COST-006). */
  thinking?: "low" | "medium" | "high";
  apiKey: string;
  apiKeyEnvironmentName: string;
  signal: AbortSignal;
  onActivity: (message: string) => Promise<void>;
}) {
  const args = [
    "--mode", "json",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider", input.provider,
    "--model", input.model,
    "--thinking", input.thinking === "low" || input.thinking === "medium" ? input.thinking : "high",
    "--tools", input.readOnly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls",
  ];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  else args.push("--no-session");
  args.push("--", input.prompt);
  let finalText = "";
  let lastAssistantError: string | undefined;
  const tracker = new UsageTracker();
  let activityQueue = Promise.resolve();
  // SEC-003/010: only the current role's credential reaches the agent process;
  // the worker's own tokens and the other role's key are stripped.
  const childEnvironment = scrubEnvironment(process.env, [input.apiKeyEnvironmentName]);
  childEnvironment[input.apiKeyEnvironmentName] = input.apiKey;
  const runTimeoutMs = Number(process.env.PI_RUN_TIMEOUT_SECONDS || 1800) * 1000;
  const onStdoutLine = (line: string) => {
      const event = parsePiLine(line);
      if (!event) return;
      tracker.track(event);
      if (event.type === "message_end") {
        const message = event.message as { role?: string } | undefined;
        if (message?.role === "assistant") lastAssistantError = assistantErrorFromEvent(event);
      }
      finalText = assistantTextFromEvent(event) || finalText;
      const toolName = toolNameFromEvent(event);
      if (toolName) {
        activityQueue = activityQueue.then(() => input.onActivity(`Pi 正在调用 ${toolName}`)).catch(() => undefined);
      }
  };
  const result = sandboxMode === "container"
    ? await runInSandbox({
        argv: ["pi", ...args],
        worktree: input.cwd,
        repository: await repositoryForWorktree(input.cwd),
        env: sandboxEnvironment({ [input.apiKeyEnvironmentName]: input.apiKey, ...(input.readOnly ? { PIGO_SANDBOX_READONLY: "1" } : {}) }),
        network: agentNetwork,
        timeoutMs: runTimeoutMs,
        signal: input.signal,
        onStdoutLine,
        label: "pi-agent",
      })
    : await command("pi", args, {
        cwd: input.cwd,
        env: childEnvironment,
        signal: input.signal,
        timeoutMs: runTimeoutMs,
        onStdoutLine,
      });
  await activityQueue;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Pi exited with ${result.code}`);
  if (lastAssistantError) throw new Error(lastAssistantError);
  return { text: finalText.trim(), usage: tracker.totals };
}

async function collectDiff(worktree: string, signal: AbortSignal, baseRef?: string) {
  await git(worktree, ["add", "-N", "."], signal);
  const args = baseRef ? ["diff", "--no-ext-diff", baseRef, "--", "."] : ["diff", "--no-ext-diff", "--", "."];
  return (await git(worktree, args, signal)).slice(0, 120_000);
}

/**
 * REL-005 / AT-REL-006: wraps one Pi invocation with bounded backoff so a burst
 * of 429/5xx errors retries a few times before the run is parked for a human.
 */
async function runPiWithRetry(
  input: Parameters<typeof runPi>[0],
  context: { runId: string; round: number; label: string; role: RunRoleUsage["role"]; budget?: RunBudgetContext },
) {
  const budget = context.budget;
  budget?.assertAvailable(context.role);
  const result = await withProviderRetry(() => runPi(input), {
    signal: input.signal,
    onRetry: async ({ attempt, delayMs, kind, message }) => {
      await postUpdate(context.runId, {
        event: {
          round: context.round,
          source: "system",
          type: "provider.retry",
          message: `${context.label} 调用遇到${kind}错误，约 ${Math.max(1, Math.round(delayMs / 1000))} 秒后重试（第 ${attempt} 次）：${message.slice(0, 200)}`,
        },
      }).catch(() => undefined);
    },
  });
  if (budget) await budget.record(context.role, input, result.usage);
  return result;
}

/** COST-002/003: per-run budget guard shared by every model call. */
interface RunBudgetContext {
  assertAvailable(role: RunRoleUsage["role"]): void;
  record(role: RunRoleUsage["role"], input: { provider: string; model: string }, usage: UsageTotals): Promise<void>;
}

class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Wires budget limits, per-role usage and 80% warnings into a running job. */
function createBudgetContext(
  run: Run,
  startedAt: number,
  limits = readBudgetLimits(),
  usageProvider: () => RunUsage = () => run.usage ?? emptyUsage(),
  onWarning?: (message: string) => Promise<void>,
): RunBudgetContext {
  const warned = new Set<string>();
  const currentUsage = () => {
    const live = usageProvider();
    return {
      inputTokens: live.inputTokens,
      outputTokens: live.outputTokens,
      cacheReadTokens: live.cacheReadTokens ?? 0,
      cacheWriteTokens: live.cacheWriteTokens ?? 0,
      totalTokens: live.totalTokens ?? (live.inputTokens + live.outputTokens + (live.cacheReadTokens ?? 0) + (live.cacheWriteTokens ?? 0)),
      estimatedCost: live.estimatedCost,
    };
  };
  return {
    assertAvailable() {
      const status = evaluateBudget({ usage: currentUsage(), modelCalls: run.modelCalls ?? 0, elapsedMs: Date.now() - startedAt, limits });
      if (status.state === "exhausted") throw new BudgetExceededError(status.reason ?? "运行预算已用尽");
    },
    async record(role, input, usageTotals) {
      const usage: RunUsage = {
        inputTokens: Math.round(usageTotals.input),
        outputTokens: Math.round(usageTotals.output),
        cacheReadTokens: Math.round(usageTotals.cacheRead),
        cacheWriteTokens: Math.round(usageTotals.cacheWrite),
        totalTokens: Math.round(usageTotals.totalTokens),
        estimatedCost: usageTotals.cost,
      };
      mergeRoleUsage(run, { role, provider: input.provider, model: input.model, usage });
      await postUpdate(run.id, { patch: { usageRoles: run.usageRoles, modelCalls: run.modelCalls } }).catch(() => undefined);
      const status = evaluateBudget({ usage: currentUsage(), modelCalls: run.modelCalls ?? 0, elapsedMs: Date.now() - startedAt, limits });
      if (status.state !== "ok" && status.dimension && !warned.has(status.dimension)) {
        warned.add(status.dimension);
        await onWarning?.(budgetWarningMessage(status));
      }
    },
  };
}

async function planDevelopment(run: Run, worktree: string, credentials: JobInput["credentials"], signal: AbortSignal, usage: UsageTotals, budget?: RunBudgetContext) {
  const prompt = [
    "You are the lead engineering planner. Inspect the current repository read-only and size the requested implementation.",
    `Task: ${run.task}`,
    `You may create at most ${maxSubagents} implementation tasks. Prefer one task for small cohesive changes.`,
    "Use multiple tasks only when work can be separated by component or file ownership.",
    "Tasks in the same dependency wave must not edit overlapping files. Add dependsOn for ordering when one task needs another.",
    "Return JSON only with this exact shape:",
    '{"complexity":"small|medium|large","rationale":"...","tasks":[{"id":"kebab-id","title":"...","description":"...","files":["relative/path"],"dependsOn":[]}]}',
  ].join("\n\n");
  try {
    const result = await runPiWithRetry({
      cwd: worktree,
      provider: run.developer.provider,
      model: run.developer.model,
      prompt,
      readOnly: true,
      // COST-006: planning is a sizing decision, so it runs with low reasoning.
      thinking: process.env.PI_PLANNER_THINKING === "high" || process.env.PI_PLANNER_THINKING === "medium" ? process.env.PI_PLANNER_THINKING : "low",
      apiKey: credentials.developer,
      apiKeyEnvironmentName: apiKeyEnvName(run.developer.provider),
      signal,
      onActivity: (message) => postUpdate(run.id, { event: { round: run.round, source: "developer", type: "planner.activity", message: `主 Agent：${message}` } }),
    }, { runId: run.id, round: run.round, label: "主 Agent 规划", role: "planner", budget });
    addUsage(usage, result.usage);
    return parseDevelopmentPlan(redactJobSecrets(result.text, credentials), maxSubagents);
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    const safeMessage = redactJobSecrets((error as Error).message, credentials);
    await postUpdate(run.id, { event: { round: run.round, source: "system", type: "planner.fallback", message: `任务拆分失败，安全回退到单 Agent：${safeMessage}` } });
    return fallbackPlan(run.task);
  }
}

async function runDeveloperAgent(input: {
  run: Run;
  worktree: string;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  prompt: string;
  sessionSuffix: string;
  activityPrefix?: string;
  usage: UsageTotals;
  budget?: RunBudgetContext;
  role?: RunRoleUsage["role"];
}) {
  const result = await runPiWithRetry({
    cwd: input.worktree,
    provider: input.run.developer.provider,
    model: input.run.developer.model,
    prompt: input.prompt,
    sessionId: `${input.run.id.replaceAll("_", "-")}-${input.sessionSuffix}`,
    apiKey: input.credentials.developer,
    apiKeyEnvironmentName: apiKeyEnvName(input.run.developer.provider),
    signal: input.signal,
    onActivity: (message) => postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "agent.activity",
        message: input.activityPrefix ? `${input.activityPrefix}：${message}` : message,
      },
    }),
  }, { runId: input.run.id, round: input.run.round, label: input.activityPrefix ?? "开发 Agent", role: input.role ?? "developer", budget: input.budget });
  addUsage(input.usage, result.usage);
  return result.text;
}

type SubAgentResult = {
  task: SubAgentTask;
  branch: string;
  worktree: string;
  commit?: string;
  error?: string;
};

async function runSubAgent(input: {
  run: Run;
  project: string;
  mainBranch: string;
  task: SubAgentTask;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  usage: UsageTotals;
  budget?: RunBudgetContext;
}): Promise<SubAgentResult> {
  const startedAt = Date.now();
  const branch = `${input.mainBranch}-sub-${input.task.id}`;
  const worktree = path.join(runsRoot, input.run.ownerId, `${input.run.id}-subagents`, input.task.id);
  input.task.status = "running";
  input.task.branch = branch;
  await mkdir(path.dirname(worktree), { recursive: true });
  await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.started", message: `Sub Agent「${input.task.title}」开始执行` } });
  try {
    await serializeWorktreeMutation(() => git(input.project, ["worktree", "add", "-b", branch, worktree, input.mainBranch], input.signal));
    const prompt = [
      "You are a focused implementation sub-agent. Work only in the current Git worktree.",
      `Overall task: ${input.run.task}`,
      `Your assigned task: ${input.task.title}\n${input.task.description}`,
      input.task.files.length ? `Primary file ownership: ${input.task.files.join(", ")}` : "Inspect and limit changes to the smallest coherent scope.",
      "Implement only your assigned part and its focused tests. Do not push, deploy, read credentials, or modify unrelated areas.",
      "Other sub-agents may work in parallel. Avoid broad formatting and generated dependency updates unless explicitly required.",
    ].join("\n\n");
    const summary = await runDeveloperAgent({
      run: input.run,
      worktree,
      credentials: input.credentials,
      signal: input.signal,
      prompt,
      sessionSuffix: `sub-${input.task.id}`,
      activityPrefix: `Sub Agent「${input.task.title}」`,
      usage: input.usage,
      budget: input.budget,
      role: "sub-agent",
    });
    const changed = await git(worktree, ["status", "--porcelain"], input.signal);
    let commit: string | undefined;
    if (changed) {
      await git(worktree, ["add", "-A"], input.signal);
      await git(worktree, ["-c", "user.name=PiGO Sub Agent", "-c", "user.email=agent@pigo.local", "commit", "-m", `subagent: ${input.task.title}`], input.signal);
      commit = await git(worktree, ["rev-parse", "HEAD"], input.signal);
    }
    input.task.status = "completed";
    input.task.summary = redactJobSecrets(summary, input.credentials).slice(0, 1_000) || (commit ? "Implementation committed" : "No code changes were required");
    input.task.durationMs = Date.now() - startedAt;
    await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.completed", message: `Sub Agent「${input.task.title}」完成` } });
    return { task: input.task, branch, worktree, commit };
  } catch (error) {
    const safeMessage = redactJobSecrets((error as Error).message, input.credentials);
    input.task.status = "failed";
    input.task.summary = safeMessage.slice(0, 1_000);
    input.task.durationMs = Date.now() - startedAt;
    await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.failed", message: `Sub Agent「${input.task.title}」失败，将由集成 Agent 接管：${safeMessage.slice(0, 200)}` } });
    return { task: input.task, branch, worktree, error: safeMessage };
  }
}

async function removeSubAgentWorktree(project: string, worktree: string) {
  await serializeWorktreeMutation(() => git(project, ["worktree", "remove", "--force", worktree])).catch(() => undefined);
}

async function deleteSubAgentBranch(project: string, branch: string) {
  await serializeWorktreeMutation(() => git(project, ["branch", "-D", branch])).catch(() => undefined);
}

async function orchestrateSubAgents(input: {
  run: Run;
  project: string;
  worktree: string;
  plan: DevelopmentPlan;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  usage: UsageTotals;
  tracker: CheckpointTracker;
  budget?: RunBudgetContext;
}) {
  const integrationNotes: string[] = [];
  const restored: string[] = [];
  for (const wave of executionWaves(input.plan.tasks)) {
    // REL-003 / AT-REL-002: sub-agents that finished before a restart are not
    // executed again; their committed work is already in the integration worktree.
    for (const task of wave) {
      if (!input.tracker.isCompleted(stages.task(task.id))) continue;
      const stored = input.tracker.payload<{ status?: string; summary?: string; durationMs?: number }>(stages.task(task.id)) ?? {};
      task.status = stored.status === "failed" ? "failed" : "merged";
      task.summary = stored.summary ?? "从检查点恢复：该 Sub Agent 已完成";
      task.durationMs = stored.durationMs;
      restored.push(task.title);
    }
    if (restored.length > 0) {
      await postUpdate(input.run.id, {
        patch: { plan: input.plan },
        event: { round: input.run.round, source: "system", type: "subagents.restored", message: `从检查点恢复 ${restored.length} 个已完成 Sub Agent，跳过重复模型调用` },
      });
      restored.length = 0;
    }
    const runnable = wave.filter((task) => task.status === "planned" && task.dependsOn.every((id) => input.plan.tasks.find((item) => item.id === id)?.status === "merged"));
    for (const task of wave.filter((item) => item.status === "planned" && !runnable.includes(item))) {
      task.status = "failed";
      task.summary = "A dependency failed to merge";
      integrationNotes.push(`${task.title}: skipped because a dependency failed`);
    }
    if (runnable.length === 0) {
      if (wave.length > 0) await postUpdate(input.run.id, { patch: { plan: input.plan } });
      continue;
    }
    for (const task of runnable) task.status = "running";
    const batches = conflictFreeBatches(runnable);
    await postUpdate(input.run.id, {
      patch: { plan: input.plan },
      event: {
        round: input.run.round,
        source: "system",
        type: "subagents.wave_started",
        message: batches.length > 1
          ? `并行启动 ${runnable.length} 个 Sub Agent（检测到声明的文件范围重叠，分 ${batches.length} 批串行化执行）`
          : `并行启动 ${runnable.length} 个 Sub Agent`,
      },
    });
    for (const batch of batches) {
      const results = await Promise.all(batch.map((task) => runSubAgent({
        run: input.run,
        project: input.project,
        mainBranch: input.run.branch,
        task,
        credentials: input.credentials,
        signal: input.signal,
        usage: input.usage,
        budget: input.budget,
      })));
      for (const result of results) {
        let keepBranch = false;
        try {
          if (result.error) {
            integrationNotes.push(`${result.task.title}: ${result.error}`);
            await input.tracker.complete(stages.task(result.task.id), {
              status: "failed",
              summary: result.task.summary,
              durationMs: result.task.durationMs,
            });
            continue;
          }
          if (result.commit) {
            const merged = await command("git", ["-c", "user.name=PiGO Integration", "-c", "user.email=agent@pigo.local", "cherry-pick", result.commit], { cwd: input.worktree, signal: input.signal, timeoutMs: 120_000 });
            if (merged.code !== 0) {
              await command("git", ["cherry-pick", "--abort"], { cwd: input.worktree, timeoutMs: 120_000 }).catch(() => undefined);
              result.task.status = "failed";
              result.task.summary = `Merge conflict from ${result.branch}`;
              integrationNotes.push(`${result.task.title}: merge ${result.branch} manually (${(merged.stderr || merged.stdout).trim().slice(0, 160)})`);
              keepBranch = true;
              await input.tracker.complete(stages.task(result.task.id), {
                status: "failed",
                summary: result.task.summary,
                durationMs: result.task.durationMs,
              });
              continue;
            }
          }
          result.task.status = "merged";
          await input.tracker.complete(stages.task(result.task.id), {
            status: "merged",
            summary: result.task.summary,
            durationMs: result.task.durationMs,
          });
          await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.merged", message: `Sub Agent「${result.task.title}」已合并` } });
        } finally {
          await removeSubAgentWorktree(input.project, result.worktree);
          if (!keepBranch) await deleteSubAgentBranch(input.project, result.branch);
        }
      }
    }
    await postUpdate(input.run.id, { patch: { plan: input.plan }, event: { round: input.run.round, source: "system", type: "subagents.wave_completed", message: "本批 Sub Agent 执行完成，主 Agent 正在整合" } });
  }
  return integrationNotes;
}

async function runChecks(run: Run, worktree: string, commands: string[], signal: AbortSignal) {
  const results: CheckResult[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const checkCommand = commands[index];
    const started = Date.now();
    const current: CheckResult = { id: `check-${index + 1}`, name: `Check ${index + 1}`, command: checkCommand, status: "running" };
    await update(run, "checking", "checks", "check.started", `执行检查：${checkCommand}`, { checks: [...results, current] });
    // SEC-004/010: check commands run with the worker's secrets stripped, so a
    // malicious check cannot read the internal callback token or provider keys.
    const result = sandboxMode === "container"
      ? await runInSandbox({
          argv: ["/bin/sh", "-lc", checkCommand],
          worktree,
          repository: await repositoryForWorktree(worktree),
          env: sandboxEnvironment({}),
          network: "none",
          timeoutMs: 600_000,
          signal,
          label: "check",
        })
      : await command("/bin/sh", ["-lc", checkCommand], {
          cwd: worktree,
          signal,
          timeoutMs: 600_000,
          env: scrubEnvironment(process.env),
        });
    results.push({
      ...current,
      status: result.code === 0 ? "passed" : "failed",
      durationMs: Date.now() - started,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-12_000),
    });
    await postUpdate(run.id, { patch: { checks: [...results] }, event: { round: run.round, source: "checks", type: result.code === 0 ? "check.passed" : "check.failed", message: `${checkCommand} ${result.code === 0 ? "通过" : "失败"}` } });
    if (result.code !== 0) return { passed: false, results };
  }
  return { passed: true, results };
}

type ReviewOutcome = { stopped: true } | { stopped: false; review: ReviewResult };

async function performReview(input: {
  run: Run;
  worktree: string;
  credentials: JobInput["credentials"];
  round: number;
  diff: string;
  signal: AbortSignal;
  usage: UsageTotals;
  started: number;
  budget?: RunBudgetContext;
}): Promise<ReviewOutcome> {
  const reviewPrompt = [
    "You are an independent read-only code reviewer. Do not modify files.",
    `Original task: ${input.run.task}`,
    "Review the current repository and the diff below for correctness, missing requirements, security, regressions, and test quality.",
    "Return JSON only with this exact shape:",
    '{"verdict":"approved|changes_requested","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low","file":null,"line":null,"title":"...","evidence":"...","requiredChange":"..."}]}',
    "Use changes_requested only for actionable defects. approved must not contain critical/high/medium findings.",
    `Diff:\n${input.diff.slice(0, 90_000)}`,
  ].join("\n\n");
  let firstReview: { text: string; usage: UsageTotals };
  try {
    firstReview = await runPiWithRetry({
      cwd: input.worktree,
      provider: input.run.reviewer.provider,
      model: input.run.reviewer.model,
      prompt: reviewPrompt,
      readOnly: true,
      apiKey: input.credentials.reviewer,
      apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
      signal: input.signal,
      onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
    }, { runId: input.run.id, round: input.round, label: "审核 Agent", role: "reviewer", budget: input.budget });
  } catch (providerError) {
    if (providerError instanceof BudgetExceededError) throw providerError;
    const reason = redactJobSecrets((providerError as Error).message, input.credentials).slice(0, 500);
    const kind = classifyProviderError(reason);
    await update(input.run, "needs_human", "reviewer", "review.provider_error", `审核模型调用失败（${kind}）：${reason}`, {
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
      summary: providerErrorSummary(kind, reason).slice(0, 500),
    });
    return { stopped: true };
  }
  addUsage(input.usage, firstReview.usage);
  try {
    return { stopped: false, review: parseReview(redactJobSecrets(firstReview.text, input.credentials), input.round) };
  } catch (protocolError) {
    const reason = redactJobSecrets((protocolError as Error).message, input.credentials).slice(0, 200);
    await postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "review.retry", message: `审核输出无法解析（${reason}），已要求 Reviewer 重新输出` } });
    let retryReview: { text: string; usage: UsageTotals };
    try {
      retryReview = await runPiWithRetry({
        cwd: input.worktree,
        provider: input.run.reviewer.provider,
        model: input.run.reviewer.model,
        prompt: `${reviewPrompt}\n\n上一次回复被拒绝：不是合法的协议 JSON。只输出 JSON 对象本身，不要 markdown 代码块，不要任何解释。`,
        readOnly: true,
        apiKey: input.credentials.reviewer,
        apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
        signal: input.signal,
        onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
      }, { runId: input.run.id, round: input.round, label: "审核 Agent（协议重试）", role: "reviewer", budget: input.budget });
    } catch (providerError) {
      if (providerError instanceof BudgetExceededError) throw providerError;
      const providerReason = redactJobSecrets((providerError as Error).message, input.credentials).slice(0, 500);
      const kind = classifyProviderError(providerReason);
      await update(input.run, "needs_human", "reviewer", "review.provider_error", `审核模型调用失败（${kind}）：${providerReason}`, {
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
        summary: providerErrorSummary(kind, providerReason).slice(0, 500),
      });
      return { stopped: true };
    }
    addUsage(input.usage, retryReview.usage);
    try {
      return { stopped: false, review: parseReview(redactJobSecrets(retryReview.text, input.credentials), input.round) };
    } catch (retryError) {
      await update(input.run, "needs_human", "reviewer", "review.invalid_protocol", "Reviewer 两次输出均无法解析为审核协议（protocol），转人工处理", {
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
        summary: providerErrorSummary("protocol", `审核输出无法解析：${redactJobSecrets((retryError as Error).message, input.credentials).slice(0, 300)}`).slice(0, 500),
      });
      return { stopped: true };
    }
  }
}

/** Human-triggered re-review: no development happens, the reviewer checks the current worktree again. */
async function executeRetryReview(input: {
  run: Run;
  worktree: string;
  baseCommit: string;
  credentials: JobInput["credentials"];
  controller: AbortController;
  usage: UsageTotals;
  started: number;
}) {
  const { run } = input;
  await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 重新审核（人工触发）`, { summary: "Reviewer Agent 正在重新审核" });
  const diff = await collectDiff(input.worktree, input.controller.signal, input.baseCommit);
  const outcome = await performReview({
    run,
    worktree: input.worktree,
    credentials: input.credentials,
    round: run.round,
    diff,
    signal: input.controller.signal,
    usage: input.usage,
    started: input.started,
  });
  if (outcome.stopped) return;
  const review = outcome.review;
  const findings = mergeFindings(run.findings ?? [], review.findings);
  if (review.verdict === "approved") {
    await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
      findings,
      diff,
      summary: review.summary,
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
    });
    return;
  }
  await update(run, "needs_human", "reviewer", "review.changes_requested", `重试审核仍发现 ${review.findings.length} 个问题，继续人工处理`, {
    findings,
    diff,
    summary: review.summary,
    usage: toRunUsage(input.usage),
    durationMs: Date.now() - input.started,
  });
}

async function executeJob(input: JobInput, controller: AbortController) {
  const run = input.run;
  const started = Date.now();
  const usage: UsageTotals = emptyUsage();
  const tracker = await loadTracker(run.id);
  // COST-002/003: budgets are evaluated before every model call and after each
  // one, with a single 80% warning per dimension.
  const budget = createBudgetContext(run, started, readBudgetLimits(), () => toRunUsage(usage), async (message) => {
    await postUpdate(run.id, {
      patch: { usageRoles: run.usageRoles, modelCalls: run.modelCalls },
      event: { round: run.round, source: "system", type: "run.budget_warning", message },
    }).catch(() => undefined);
  });
  // A re-claimed job (worker restart) resumes against the checkpoints already
  // recorded for this run: reuse the worktree and skip finished stages (REL-002/003).
  const recovering = Boolean(!input.resume && !input.retryReview && (input.recovery || tracker.size > 0));
  const stopHeartbeat = startJobHeartbeat(input.jobId);
  let outcomeState: "done" | "failed" | "cancelled" = "done";
  let terminalRecorded = true;
  try {
    const project = await resolveProject(run.repository);
    const dirty = await git(project, ["status", "--porcelain"], controller.signal);
    if (dirty) throw new Error("Source repository has uncommitted changes; clean it before starting a real run");
    const projectHead = await git(project, ["rev-parse", "HEAD"], controller.signal);
    if (!/^[a-f0-9]{64}$/.test(run.ownerId)) throw new Error("Invalid run owner");
    const worktree = path.join(runsRoot, run.ownerId, run.id);
    const reuseWorktree = Boolean(input.resume || input.retryReview || recovering);
    const humanInstruction = input.resume?.instruction?.trim() || "";
    if (recovering) {
      await postUpdate(run.id, {
        event: { round: run.round, source: "system", type: "run.recovered", message: `Worker 恢复未完成任务：从 ${tracker.size} 个检查点继续，不重复已完成的模型调用` },
      });
    }

    let baseCommit = projectHead;
    if (reuseWorktree) {
      const exists = await stat(worktree).then(() => true).catch(() => false);
      if (!exists) throw new Error("无法恢复：任务 worktree 不存在（可能已被清理）");
      const branch = await git(worktree, ["branch", "--show-current"], controller.signal);
      if (branch !== run.branch) throw new Error(`无法恢复：worktree 当前分支为 ${branch || "detached"}，期望 ${run.branch}`);
      const head = await git(worktree, ["rev-parse", "HEAD"], controller.signal);
      const pending = await git(worktree, ["status", "--porcelain"], controller.signal);
      baseCommit = await git(project, ["merge-base", projectHead, run.branch], controller.signal).catch(() => projectHead);
      const recoveryLabel = input.retryReview
        ? `重试审核：复用现有 worktree（HEAD ${head.slice(0, 7)}）`
        : input.resume
          ? `人工恢复：复用已有 worktree（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的人工修改" : ""}）`
          : `Worker 恢复：复用已有 worktree（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的修改" : ""}）`;
      await update(run,
        input.retryReview ? "reviewing" : "preparing",
        "system",
        input.retryReview ? "review.retry_started" : input.resume ? "run.resume_detected" : "run.recovery_detected",
        recoveryLabel,
        {
          worktree: path.relative(workspaceRoot, worktree),
          summary: input.retryReview ? "Reviewer Agent 正在重新审核" : input.resume ? "人工恢复：正在准备继续执行" : "Worker 恢复：正在从检查点继续执行",
        });
      if (humanInstruction) {
        await postUpdate(run.id, { event: { round: run.round, source: "system", type: "run.resume_instruction", message: `人工指令：${humanInstruction.slice(0, 500)}` } });
      }
    } else {
      await mkdir(path.dirname(worktree), { recursive: true });
      await update(run, "preparing", "system", "workspace.preparing", "正在创建隔离 Git worktree", { worktree: path.relative(workspaceRoot, worktree) });
      await git(project, ["worktree", "add", "-b", run.branch, worktree, "HEAD"], controller.signal);
    }

    if (input.retryReview) {
      await executeRetryReview({ run, worktree, baseCommit, credentials: input.credentials, controller, usage, started });
      return;
    }
    await update(run, "developing", "developer", "agent.started", `${run.developer.model} 主 Agent 开始评估工作量`, { summary: "主 Agent 正在分析任务并决定是否拆分 Sub Agent" });

    let feedback = input.resume || recovering ? unresolvedFeedback(run.findings) : "";
    let findings: Finding[] = input.resume || recovering ? [...(run.findings ?? [])] : [];
    let plan: DevelopmentPlan | undefined;
    const firstRound = input.resume ? Math.max(2, run.round) : recovering ? Math.max(1, run.round) : 1;
    for (let round = firstRound; round <= run.maxRounds; round += 1) {
      run.round = round;
      await postUpdate(run.id, { patch: { round }, event: { round, source: "system", type: "round.started", message: `开始第 ${round} 轮开发` } });
      const developmentDone = tracker.isCompleted(stages.development(round));
      if (developmentDone) {
        // AT-REL-002: the developer stage already finished before the restart, so
        // no developer model call is repeated; continue with checks and review.
        plan = tracker.payload<DevelopmentPlan>(stages.planning) ?? plan ?? fallbackPlan(run.task);
        run.plan = plan;
        await update(run, "developing", "system", "checkpoint.development_restored", `第 ${round} 轮开发已由检查点确认完成，跳过重复的模型调用`, { plan });
        feedback = unresolvedFeedback(run.findings);
        findings = [...(run.findings ?? [])];
      } else if (round === 1) {
        const storedPlan = tracker.isCompleted(stages.planning) ? tracker.payload<DevelopmentPlan>(stages.planning) : undefined;
        plan = storedPlan ?? await planDevelopment(run, worktree, input.credentials, controller.signal, usage, budget);
        run.plan = plan;
        if (storedPlan) {
          await postUpdate(run.id, {
            patch: { plan, usage: toRunUsage(usage) },
            event: { round, source: "system", type: "plan.restored", message: "从检查点恢复开发计划，跳过已完成的主 Agent 规划调用" },
          });
        } else {
          await postUpdate(run.id, {
            patch: { plan, usage: toRunUsage(usage) },
            event: {
              round,
              source: "developer",
              type: "plan.created",
              message: plan.tasks.length === 1
                ? `主 Agent 判定为${plan.complexity}任务，由单 Agent 完成`
                : `主 Agent 判定为${plan.complexity}任务，自动拆分为 ${plan.tasks.length} 个 Sub Agent`,
            },
          });
          await tracker.complete(stages.planning, plan);
        }
        if (plan.tasks.length > 1) {
          const integrationNotes = await orchestrateSubAgents({ run, project, worktree, plan, credentials: input.credentials, signal: controller.signal, usage, tracker, budget });
          const integrationPrompt = [
            "You are the lead integration agent. Work only in the current Git worktree.",
            `Original task: ${run.task}`,
            `Sub-agent plan and final states:\n${JSON.stringify(plan, null, 2)}`,
            integrationNotes.length ? `Items requiring your direct attention:\n${integrationNotes.join("\n")}` : "All completed sub-agent commits were merged successfully.",
            "Inspect the combined code, resolve integration gaps, complete any skipped work, and add or update end-to-end tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not undo correct sub-agent work.",
          ].join("\n\n");
          await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: integrationPrompt, sessionSuffix: "integrator", activityPrefix: "集成 Agent", usage, budget, role: "integrator" });
        } else {
          const task = plan.tasks[0];
          task.status = "running";
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.started", message: "单 Agent 开始实现" } });
          const developerPrompt = [
            "You are the developer agent. Work only in the current Git worktree.",
            `Task: ${run.task}`,
            "Inspect the repository, implement the task completely, and add or update tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not claim checks passed unless you ran them.",
          ].join("\n\n");
          const summary = await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: developerPrompt, sessionSuffix: "developer", usage, budget });
          task.status = "merged";
          task.summary = redactJobSecrets(summary, input.credentials).slice(0, 1_000);
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.completed", message: "单 Agent 实现完成" } });
        }
      } else {
        const repairSections = [
          "You are the repair developer agent. Work only in the current Git worktree.",
          `Original task: ${run.task}`,
          `Required fixes from checks or review:\n${feedback}`,
        ];
        if (round === firstRound && humanInstruction) {
          repairSections.push(`人工指令（来自工作区所有者，最高优先级，必须满足）：\n${humanInstruction}`);
        }
        repairSections.push("Inspect the existing combined implementation, make the required fixes, and update tests.", "Do not push, deploy, delete the repository, or read credentials.");
        // COST-004: 返修复用 Developer 会话（保留已实现上下文），只注入新增反馈与必要上下文。
        await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: repairSections.join("\n\n"), sessionSuffix: "developer", activityPrefix: "修复 Agent", usage, budget });
      }
      if (!developmentDone) await tracker.complete(stages.development(round), { round, at: new Date().toISOString() });
      const diff = await collectDiff(worktree, controller.signal, baseCommit);
      await update(run, "checking", "checks", "checks.started", "Developer 完成，开始确定性检查", { diff, summary: "正在运行项目检查", usage: toRunUsage(usage) });
      const storedChecks = tracker.isCompleted(stages.checks(round)) ? tracker.payload<StoredChecks>(stages.checks(round)) : undefined;
      if (storedChecks) {
        await postUpdate(run.id, { event: { round, source: "checks", type: "checks.checkpoint_restored", message: `从检查点恢复第 ${round} 轮检查结果，未重复执行检查命令` } });
      }
      const checked = storedChecks ?? await runChecks(run, worktree, input.checks, controller.signal);
      if (!storedChecks) await tracker.complete(stages.checks(round), checked);
      if (!checked.passed) {
        feedback = `The deterministic checks failed. Fix these failures:\n${checked.results.filter((item) => item.status === "failed").map((item) => `${item.command}\n${item.output}`).join("\n\n")}`;
        await update(run, "developing", "checks", "checks.returned", "检查失败，已退回 Developer 修复", { summary: "检查失败，等待修复", ...(storedChecks ? {} : { checks: checked.results }) });
        continue;
      }

      const latestDiff = await collectDiff(worktree, controller.signal, baseCommit);
      await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, summary: "Reviewer Agent 正在审核" });
      // AT-REL-003: a review that already produced a verdict is reused, so a
      // restarted worker can never emit two conflicting verdicts for one round.
      let review: ReviewResult;
      const storedReview = tracker.isCompleted(stages.review(round)) ? tracker.payload<StoredReview>(stages.review(round)) : undefined;
      if (storedReview) {
        review = storedReview;
        await postUpdate(run.id, { event: { round, source: "system", type: "review.checkpoint_restored", message: "从检查点恢复本轮审核结论，跳过重复的审核模型调用" } });
      } else {
        await tracker.start(stages.review(round));
        const outcome = await performReview({ run, worktree, credentials: input.credentials, round, diff: latestDiff, signal: controller.signal, usage, started, budget });
        if (outcome.stopped) return;
        review = outcome.review;
        await tracker.complete(stages.review(round), review);
      }
      findings = mergeFindings(findings, review.findings);
      if (review.verdict === "approved") {
        await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
          findings,
          diff: latestDiff,
          summary: review.summary,
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        });
        return;
      }
      feedback = JSON.stringify(review.findings, null, 2);
      await update(run, "developing", "reviewer", "review.changes_requested", `审核发现 ${review.findings.length} 个问题，退回 Developer`, { findings, summary: review.summary, usage: toRunUsage(usage) });
    }
    await update(run, "needs_human", "system", "run.needs_human", "达到最大审核轮次，需要人工处理", { findings, usage: toRunUsage(usage), durationMs: Date.now() - started });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    outcomeState = cancelled ? "cancelled" : "failed";
    if (error instanceof BudgetExceededError && !cancelled) {
      // COST-003 / AT-PERF-008: 100% of a hard budget stops new model calls.
      outcomeState = "failed";
      const message = `运行预算已用尽，已停止新的模型调用：${error.message}`;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await update(run, "needs_human", "system", "run.budget_exhausted", message, {
            usage: toRunUsage(usage),
            usageRoles: run.usageRoles,
            modelCalls: run.modelCalls,
            durationMs: Date.now() - started,
            summary: message.slice(0, 300),
          });
          terminalRecorded = true;
          break;
        } catch (writeError) {
          console.warn(`[store] budget terminal update failed (attempt ${attempt}): ${(writeError as Error).message}`);
          if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
        }
      }
      return;
    }
    const safeMessage = redactJobSecrets((error as Error).message, input.credentials).slice(0, 2_000);
    const followup = Boolean(input.resume || input.retryReview);
    const kind = cancelled ? undefined : classifyProviderError(safeMessage);
    // AT-REL-006/007: classified provider and storage failures are parked for a
    // human (bounded retries already happened above); only unclassified errors
    // mark the run permanently failed.
    const parked = followup || recovering || (kind !== undefined && kind !== "unknown");
    const state: RunState = cancelled ? "cancelled" : parked ? "needs_human" : "failed";
    const type = cancelled
      ? "run.cancelled"
      : kind === "storage"
        ? "run.storage_error"
        : parked
          ? "run.provider_error"
          : followup
            ? "run.resume_failed"
            : recovering
              ? "run.recovery_failed"
              : "run.failed";
    const message = cancelled
      ? "任务已取消"
      : kind === "storage"
        ? `存储错误，任务未完成，保持人工处理（${kind}）：${safeMessage}`
        : `${followup ? "恢复执行失败，保持人工处理" : recovering ? "Worker 恢复执行失败，保持人工处理" : "真实运行失败"}（${kind}）：${safeMessage}`;
    // AT-REL-007: retry the terminal write so a short store outage cannot leave
    // the run silently mid-flight; if it still fails the job stays claimed and a
    // later reclaim repeats this stage (never marking a false completion).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await update(run, state, "system", type, message, {
          summary: cancelled ? "已取消" : providerErrorSummary(kind ?? "unknown", safeMessage).slice(0, 800),
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        });
        terminalRecorded = true;
        break;
      } catch (writeError) {
        console.warn(`[store] terminal update failed (attempt ${attempt}): ${(writeError as Error).message}`);
        if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
      }
    }
    if (!terminalRecorded) {
      console.error(`[store] could not record the terminal state for ${run.id}; leaving the job for reclaim`);
    }
  } finally {
    stopHeartbeat();
    if (input.jobId && terminalRecorded) {
      await jobApi.finish(input.jobId, outcomeState).catch((error) => console.warn(`[jobs] finish failed: ${(error as Error).message}`));
    } else if (input.jobId) {
      console.warn(`[jobs] keeping ${input.jobId} claimed so it can be retried after the store recovers`);
    }
    input.credentials.developer = "";
    input.credentials.reviewer = "";
    active.delete(run.id);
  }
}

/** Picks up jobs that were never delivered or whose worker died mid-run (REL-002). */
async function reclaimPendingJobs() {
  if (active.size >= maxActiveJobs) return 0;
  if ((await storageStatus()).state === "critical") {
    console.warn("[jobs] disk space critically low; skipping reclaim until cleaned up");
    return 0;
  }
  let jobs: PendingJob[] = [];
  try {
    jobs = await jobApi.pending();
  } catch (error) {
    console.warn(`[jobs] reclaim failed: ${(error as Error).message}`);
    return 0;
  }
  let started = 0;
  for (const job of jobs) {
    if (active.size >= maxActiveJobs) break;
    if (active.has(job.run.id)) continue;
    if (!job.credentials?.developer || !job.credentials?.reviewer) {
      console.warn(`[jobs] skipping ${job.jobId}: credentials unavailable`);
      continue;
    }
    const controller = new AbortController();
    active.set(job.run.id, controller);
    started += 1;
    void executeJob({ run: job.run, checks: job.checks, credentials: job.credentials, jobId: job.jobId, recovery: true }, controller);
  }
  if (started > 0) console.warn(`[jobs] reclaimed ${started} unfinished job(s) after restart`);
  return started;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const storage = await storageStatus();
      return json(response, 200, { status: "ok", service: "pigo-worker", activeJobs: active.size, storage: storage.state });
    }
    if (request.method === "GET" && url.pathname === "/health/storage") return json(response, 200, await storageStatus());
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
    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJson(request) as unknown as JobInput;
      if (!body.run?.id || body.run.mode !== "real" || !Array.isArray(body.checks) || !body.credentials?.developer || !body.credentials?.reviewer) return json(response, 400, { error: "Invalid job" });
      // Dispatch is at-least-once: a run already executing locally is not an error.
      if (active.has(body.run.id)) return json(response, 202, { accepted: true, runId: body.run.id, note: "already running" });
      if (active.size >= maxActiveJobs) return json(response, 429, { error: "Worker capacity reached; retry after an active job finishes" });
      const storage = await storageStatus();
      if (storage.state === "critical") {
        return json(response, 507, { error: `Disk space critically low (${Math.round(storage.freeBytes / 1024 / 1024)} MB free); refusing new jobs` });
      }
      const controller = new AbortController();
      active.set(body.run.id, controller);
      void executeJob(body, controller);
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
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 500, { error: (error as Error).message });
  }
});

const resolvedSandbox = await resolveSandboxMode(process.env.PI_SANDBOX_MODE || "auto", () => docker.ping());
sandboxMode = resolvedSandbox.mode;
sandboxReason = resolvedSandbox.reason;
process.stdout.write(`[sandbox] mode=${sandboxMode}${sandboxReason ? ` (${sandboxReason})` : ""} image=${imageForSandbox}\n`);

server.listen(port, host, () => {
  process.stdout.write(`pigo-worker listening on http://${host}:${port}\n`);
  void reclaimPendingJobs();
  const timer = setInterval(() => { void reclaimPendingJobs(); }, 60_000);
  timer.unref?.();
});
