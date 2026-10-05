import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ChatChannel, ChatParticipant, ChatRole, DevelopmentPlan, Finding, ProjectInfo, Run, RunEvent, RunRoleUsage, RunState, SubAgentTask, WorkspaceVerifyResult } from "../shared/types.js";
import { clipChatContent } from "../shared/chat.js";
import { assignSubAgentCodenames } from "../shared/codenames.js";
import { runChecks as runCheckSuite, throwIfCancelled, type CommandResult } from "./checks.js";
import { CheckpointTracker, isCheckpointCurrent, memoryCheckpointClient, stages, type Checkpoint, type CheckpointClient, type StoredChecks, type StoredReview } from "./checkpoints.js";
import { conflictFreeBatches, executionWaves, fallbackPlan, parseDevelopmentPlan } from "./orchestrator.js";
import { UsageTracker, addUsage, assistantErrorFromEvent, assistantTextFromEvent, toRunUsage, toolNameFromEvent, type UsageTotals } from "./pi-events.js";
import { DockerApi } from "./docker-api.js";
import { readBudgetLimits } from "./budget.js";
import { BudgetExceededError, createRunBudget, type RunBudgetContext } from "./run-budget.js";
import { runProviderOperation } from "./provider-attempts.js";
import { scrubEnvironment } from "./pi-env.js";
import { runHardenedGit } from "./git-hardening.js";
import { apiKeyEnvName, classifyProviderError, providerErrorSummary } from "./provider-errors.js";
import { sleep } from "./provider-retry.js";
import { parseReview, type ReviewResult } from "./review-protocol.js";
import { convergenceGuardEnabled, convergenceStop } from "./review-convergence.js";
import { blockingFindings, deferredFindings, deferredMessage, isDeferral, resolveReviewScope, shouldAcceptRound } from "./review-scope.js";
import { buildContainerSpec, hostPathFor, resolveSandboxMode } from "./sandbox.js";
import { mergeFindings, repeatedSevereFindings, severeRepeatThreshold, unresolvedFeedback } from "./review-findings.js";
import {
  buildSnapshotDivergenceFinding,
  createGitReviewSnapshotMaterializer,
  destroyReviewSnapshot,
  evaluateSnapshotDivergence,
  reviewSnapshotDirectory,
  type MaterializedReviewSnapshot,
} from "./review-snapshot.js";
import { WorkspacePathError, prepareWorkspaceDirectory, resolveInsideRoot, sanitizeRelativePath, sanitizeWorkspaceName, validateCloneUrl } from "./workspace-paths.js";
import { RunCleanupPathError, planRunDirectoryRemoval, removeRunDirectory } from "./run-cleanup.js";
import { runGuardedMerge, type GuardedMergeResult, type MergeGuardGitExec } from "./merge-guard.js";
import { WorkspaceLockManager, workspaceKeyFor } from "./workspace-lock.js";
import { PiRunError, failureOutputForEvent } from "./agent-failure.js";
import { captureFailedSubAgentWorktree } from "./subagent-artifacts.js";
import { MAX_ROUNDS_MESSAGE, planRecovery, recoveryResumePhase, recoveryUpdateState } from "./run-recovery.js";
import { callbackBodyExceedsInlineLimit, encodeCallbackBody, persistDiffArtifact, type DiffArtifactRef } from "./diff-artifacts.js";
import { uploadRunArtifact } from "./artifact-upload.js";
import { captureSnapshotHash } from "./snapshot-hash.js";
import { startRunDeadline } from "./run-deadline.js";
import { detectProjectPlugins, pluginArguments, pluginMounts, selectPlugins, verifyPluginPins, type PluginDenial } from "./plugin-policy.js";
import { buildPluginPolicy } from "./plugin-registry.js";
import { CliSessionManager, SessionAccumulator, planPiSession, sessionReuseEnabled, type PiSessionRole } from "./pi-session.js";

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
// GAP-05 / AT-RUN-012: one run per workspace at a time. Lock files live under
// the workspace root so a worker restart cannot leave a workspace locked: the
// heartbeat goes stale and the next claim reclaims it.
const configuredLockStale = Number(process.env.PI_WORKSPACE_LOCK_STALE_SECONDS || 300);
const workspaceLockStaleMs = Number.isFinite(configuredLockStale) ? Math.max(30, configuredLockStale) * 1_000 : 300_000;
const workspaceLocks = new WorkspaceLockManager({
  directory: path.join(runsRoot, "_locks"),
  workerId: process.env.PI_WORKER_ID || `worker-${process.pid}`,
  staleMs: workspaceLockStaleMs,
});
const minFreeDiskMb = Math.max(64, Number(process.env.PI_MIN_FREE_DISK_MB || 2048));
// Critical is a quarter of the configured minimum (2048 MB -> 512 MB by default),
// so raising PI_MIN_FREE_DISK_MB also scales the hard stop threshold.
const criticalFreeDiskMb = Math.max(32, Number(process.env.PI_CRITICAL_FREE_DISK_MB || Math.round(minFreeDiskMb / 4)));
// Convergence guard (incident run_e2eabf51532448b3): stop a review loop whose NEW
// critical/high finding count has not decreased for two consecutive rounds,
// before it burns another repair round. Default on; `off` disables it.
const reviewConvergenceGuardEnabled = convergenceGuardEnabled();

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

/**
 * GAP-03: creates the reviewer's immutable one-shot snapshot. Injectable so the
 * decision logic can be exercised without shelling out to git.
 */
const materializeReviewSnapshot = createGitReviewSnapshotMaterializer();

/**
 * GAP-02: Pi plugins are default-off. Only resources in the operator allowlist
 * are re-enabled through explicit `--extension/--skill/--prompt-template`
 * flags; anything requested but not allowlisted produces a `plugin.denied`
 * event instead of being silently dropped.
 *
 * Sprint 2: when `PI_PLUGIN_REGISTRY` is set, the SHA-256 pinned registry file is
 * loaded and merged (registry wins on a path conflict). A missing/invalid file
 * throws here, so the worker fails loudly instead of silently disabling plugins.
 */
const pluginPolicy = buildPluginPolicy({
  allowlist: process.env.PI_PLUGIN_ALLOWLIST,
  requests: process.env.PI_PLUGIN_REQUESTS,
  registry: process.env.PI_PLUGIN_REGISTRY,
});
const allowProjectPlugins = process.env.PI_PLUGIN_ALLOW_PROJECT === "true";
/** AT-PI-007/AT-SEC-014: when set, every allowlisted plugin must carry a sha256 pin. */
const requirePluginPin = process.env.PI_PLUGIN_REQUIRE_PIN === "true";
/** Container directory that hosts read-only allowlisted plugin mounts. */
const pluginContainerBase = process.env.PI_PLUGIN_CONTAINER_DIR || "/opt/pigo/plugins";
/** Sprint 2: single CLI-backed Pi session manager (adds instrumentation only). */
const cliSessionManager = new CliSessionManager();
/**
 * Sprint 2 A/B switch, read once here so the decision is a plain boolean at the
 * call site (never an env lookup deep inside `runPiWithRetry`). Default on.
 */
const sessionReuse = sessionReuseEnabled();

const reportedPluginEvents = new Set<string>();
async function reportPluginPolicy(runId: string, round: number, enabled: string[], denials: PluginDenial[]) {
  if (reportedPluginEvents.size > 500) reportedPluginEvents.clear();
  for (const denial of denials) {
    const key = `${runId}:denied:${denial.path}:${denial.reason}`;
    if (reportedPluginEvents.has(key)) continue;
    reportedPluginEvents.add(key);
    await postUpdate(runId, {
      event: {
        round,
        source: "system",
        type: "plugin.denied",
        message: `插件未启用：${denial.path}（${denial.reason}）`,
        meta: { path: denial.path, kind: denial.kind, reason: denial.reason },
      },
    }).catch(() => undefined);
  }
  const enabledKey = `${runId}:enabled`;
  if (enabled.length > 0 && !reportedPluginEvents.has(enabledKey)) {
    reportedPluginEvents.add(enabledKey);
    await postUpdate(runId, {
      event: {
        round,
        source: "system",
        type: "plugin.enabled",
        message: `已按 allowlist 启用 ${enabled.length} 个受控插件：${enabled.join("、")}`,
        meta: { plugins: enabled },
      },
    }).catch(() => undefined);
  }
}

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

/**
 * AUD-04 / NEW-03: content-bound identity of the run directory. Delegates to a
 * scratch-index tree OID (see `captureSnapshotHash`), so the identity is a pure
 * function of the tracked + untracked (non-ignored) file contents.
 */
async function snapshotHash(worktree: string, signal?: AbortSignal) {
  return captureSnapshotHash(
    (cwd, args, options = {}) => git(cwd, args, options.signal ?? signal, { env: options.env }),
    worktree,
    signal,
  );
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
  pluginMounts?: Array<{ hostPath: string; containerPath: string }>;
  /** GAP-03: mount the worktree read-only (reviewer snapshot). */
  readOnly?: boolean;
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
    readOnly: input.readOnly,
    repositoryPath: input.repository,
    hostRepositoryPath: input.repository ? hostPathFor(input.repository, workspaceRoot, hostWorkspaceRoot) : undefined,
    modelsFile: "/home/node/.pi/agent/models.json",
    hostModelsFile: process.env.PI_SANDBOX_MODELS_FILE || path.resolve("/app/pi-models.json"),
    stateDir: "/home/node/.pi",
    stateMount: "bind",
    hostStateDir: hostPathFor(runStateDir, workspaceRoot, hostWorkspaceRoot),
    ...(input.pluginMounts ? { pluginMounts: input.pluginMounts } : {}),
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
  // A container timeout of 0/absent means no limit; only a positive value kills it.
  const timer = input.timeoutMs > 0 ? setTimeout(() => { void docker.killContainer(containerId).catch(() => undefined); }, input.timeoutMs) : undefined;
  const onAbort = () => { void docker.killContainer(containerId).catch(() => undefined); };
  try {
    input.signal.addEventListener("abort", onAbort, { once: true });
    await docker.startContainer(containerId);
    // Logs are read after the container starts: Docker only exposes the full
    // log of a started container, and `follow=1` then streams to completion.
    const maxSandboxOutput = 256_000;
    const logs = docker.logsFollow(containerId, (line, stream) => {
      if (stream === "stderr") {
        stderr = `${stderr}${line}\n`.slice(-maxSandboxOutput);
        return;
      }
      stdout = `${stdout}${line}\n`.slice(-maxSandboxOutput);
      input.onStdoutLine?.(line);
    }, input.signal).catch((error) => { stderr += String(error.message); });
    const { StatusCode } = await docker.waitContainer(containerId);
    await logs;
    return { code: StatusCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    await docker.removeContainer(containerId).catch(() => undefined);
    // AUD-07: the per-run Pi state directory is intentionally kept so the next
    // call (repair round, retry review, recovery) can resume the same session.
    // It is removed together with the run directory during explicit cleanup.
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
  /** AUD-05: false means the job never started, so it must create the run directory. */
  wasStarted: boolean;
  resume?: { instruction?: string };
  retryReview?: boolean;
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

/** How often a lock holder proves it is still alive. */
const workspaceLockHeartbeatMs = 30_000;

/**
 * GAP-05 / AT-RUN-012: jobs that could not start because another run holds the
 * workspace lock. They are not failed — they stay queued locally and are
 * retried as soon as the holder releases or its lock goes stale. The durable
 * job row is never finished here, so a worker restart re-delivers it too.
 */
const deferredJobs = new Map<string, { input: JobInput; reason: string }>();
let drainingDeferred = false;

async function dispatchJob(input: JobInput, controller: AbortController) {
  const key = workspaceKeyFor(input.run);
  const result = await workspaceLocks.acquire(key, input.run.id);
  if (!result.acquired) {
    // Do not run, do not finish the job: leave it for the drain loop / durable
    // requeue. `active` is cleared so capacity accounting stays honest.
    active.delete(input.run.id);
    const holder = result.holder;
    const reason = holder
      ? `工作区「${key}」正被运行 ${holder.runId} 占用（心跳 ${new Date(holder.heartbeatAt).toISOString()}）`
      : `工作区「${key}」已被占用`;
    deferredJobs.set(input.run.id, { input, reason });
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "system",
        type: "workspace.locked",
        message: `保持排队：${reason}。等待其结束或锁过期（约 ${Math.round(workspaceLockStaleMs / 1000)} 秒）后自动重试。`,
        meta: { workspace: key, holderRunId: holder?.runId, holderWorkerId: holder?.workerId, staleSeconds: Math.round(workspaceLockStaleMs / 1000) },
      },
    }).catch((error) => console.warn(`[jobs] could not record workspace.locked for ${input.run.id}: ${(error as Error).message}`));
    console.warn(`[jobs] deferring ${input.run.id}: ${reason}`);
    return false;
  }

  deferredJobs.delete(input.run.id);
  if (result.reclaimedStale) {
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "system",
        type: "workspace.lock_reclaimed",
        message: `工作区「${key}」上一个持有者（运行 ${result.reclaimedStale.runId}）的锁已过期，本次运行已接管。`,
        meta: { workspace: key, staleRunId: result.reclaimedStale.runId, staleWorkerId: result.reclaimedStale.workerId },
      },
    }).catch(() => undefined);
  }
  const touch = setInterval(() => { void result.handle.touch().catch(() => undefined); }, workspaceLockHeartbeatMs);
  touch.unref?.();
  try {
    await executeJob(input, controller);
  } finally {
    clearInterval(touch);
    await result.handle.release().catch(() => undefined);
    void drainDeferredJobs();
  }
  return true;
}

/** Retries locally deferred jobs whose workspace lock has freed up. */
async function drainDeferredJobs() {
  if (drainingDeferred || deferredJobs.size === 0) return 0;
  drainingDeferred = true;
  let started = 0;
  try {
    for (const [runId, entry] of [...deferredJobs]) {
      if (active.has(runId)) { deferredJobs.delete(runId); continue; }
      if (active.size >= maxActiveJobs) break;
      if (workspaceLocks.isHeld(workspaceKeyFor(entry.input.run))) continue;
      const controller = new AbortController();
      active.set(runId, controller);
      deferredJobs.delete(runId);
      started += 1;
      void dispatchJob(entry.input, controller).catch((error) => {
        active.delete(runId);
        console.error(`[jobs] deferred dispatch failed for ${runId}: ${(error as Error).message}`);
      });
    }
  } finally {
    drainingDeferred = false;
  }
  if (started > 0) console.warn(`[jobs] resumed ${started} deferred job(s) after the workspace lock freed up`);
  return started;
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
    const message = `完整 Diff 制品上传失败，保留本地全量制品 ${local.id}（bytes=${local.bytes} sha256=${local.sha256}）：${(error as Error).message.slice(0, 300)}`;
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

async function postUpdate(runId: string, input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}, options: { diffArtifact?: DiffArtifactRef; ownerId?: string; round?: number } = {}) {
  let response: Response;
  // AUD-15: every internal update carries a delivery key so a retried or
  // duplicated call is applied at most once (patch and event atomically).
  const deliveryId = `${runId}:${Date.now().toString(36)}:${randomBytes(6).toString("hex")}`;
  const payload: { patch?: object; event?: object; deliveryId: string } = {
    ...input,
    deliveryId,
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
    throw new Error(`Callback failed: ${(error as Error).message || "store unreachable"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Callback failed: ${response.status} ${body.slice(0, 200)}`);
  }
}

async function update(run: Run, state: RunState, source: RunEvent["source"], type: string, message: string, patch: Partial<Run> = {}, options: { diffArtifact?: DiffArtifactRef; meta?: Record<string, unknown> } = {}) {
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
async function chat(
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

function command(commandName: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutput?: number;
  onStdoutLine?: (line: string) => void;
}): Promise<CommandResult> {
  const captureLimit = options.maxOutput ?? maxOutput;
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    // A timeout of 0/undefined means no limit; only a positive value arms the
    // timer. (Previously `options.timeoutMs || 1_800_000` silently turned an
    // explicit 0 into the 30 minute default instead of "unlimited".)
    const timeoutMs = options.timeoutMs === undefined ? 1_800_000 : options.timeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : undefined;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-captureLimit);
      options.onStdoutLine?.(line);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-captureLimit); });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (error.name === "AbortError") resolve({ code: 130, stdout, stderr: "aborted" });
      else reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * AUD-01 / NEW-01: every platform Git invocation runs with hooks, credential
 * helpers, repository-local filters/diff/merge drivers and fsmonitor disabled,
 * and with a scrubbed environment. Untrusted code from a task can therefore
 * never execute inside the Worker through Git. Delegates to the single hardened
 * runner (`runHardenedGit`) shared by every git call site.
 */
async function git(cwd: string, args: string[], signal?: AbortSignal, options: { maxOutput?: number; env?: Record<string, string> } = {}) {
  const result = await runHardenedGit({
    cwd,
    args,
    signal,
    timeoutMs: 120_000,
    maxOutput: options.maxOutput ?? maxOutput,
    env: options.env,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

/**
 * AUD-01 / AT-GIT-001: prepares the run directory as a standalone clone of the
 * source repository. No shared, writable Git metadata is exposed to agents; the
 * clone is the only repository the sandbox can see.
 */
async function prepareRunDirectory(input: {
  project: string;
  runDir: string;
  branch: string;
  baseSha?: string;
  reuse: boolean;
  signal: AbortSignal;
}): Promise<{ baseSha: string }> {
  const { project, runDir, branch, signal } = input;
  const exists = await stat(runDir).then(() => true).catch(() => false);
  if (input.reuse) {
    if (!exists) throw new Error("无法恢复：任务运行目录不存在（可能已被清理）");
    const current = await git(runDir, ["branch", "--show-current"], signal);
    if (current !== branch) throw new Error(`无法恢复：运行目录当前分支为 ${current || "detached"}，期望 ${branch}`);
    const baseSha = input.baseSha ?? await git(runDir, ["rev-parse", "HEAD"], signal);
    return { baseSha };
  }
  await mkdir(path.dirname(runDir), { recursive: true });
  if (exists) await rm(runDir, { recursive: true, force: true });
  // The file transport is allowed only for this clone (the source is an
  // operator-registered local workspace); every other Git call keeps it off.
  await serializeWorktreeMutation(() => git(project, [
    "-c", "protocol.file.allow=always",
    "clone", "--local", "--no-hardlinks", "--quiet", project, runDir,
  ], signal));
  await git(runDir, ["config", "core.hooksPath", "/dev/null"], signal);
  await git(runDir, ["config", "credential.helper", ""], signal);
  await git(runDir, ["config", "gc.auto", "0"], signal);
  const head = input.baseSha ?? await git(project, ["rev-parse", "HEAD"], signal);
  await git(runDir, ["checkout", "-b", branch, head], signal);
  return { baseSha: head };
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
  const result = await runHardenedGit({ cwd: root, args: ["clone", "--quiet", url, target], timeoutMs: 600_000 });
  if (result.code !== 0) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    const reason = redactCredentials(`${result.stderr}\n${result.stdout}`.trim()).slice(0, 500);
    return { ok: false, code: "CLONE_FAILED", error: reason || "git clone failed" };
  }
  return verifyWorkspace(cleanName);
}

/**
 * Creates a new workspace directory under the projects root and initializes it
 * as an empty Git repository so it is immediately registrable (real runs clone
 * a repository; a bare directory would fail verification). Idempotent for an
 * already-created empty workspace; an existing non-empty directory is reported
 * as WORKSPACE_EXISTS instead of being claimed or overwritten.
 */
async function createWorkspace(name: string): Promise<WorkspaceVerifyResult> {
  const cleanName = sanitizeWorkspaceName(name);
  if (!cleanName) return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace name" };
  let prepared;
  try {
    prepared = await prepareWorkspaceDirectory(projectsRoot, cleanName);
  } catch (error) {
    if (error instanceof WorkspacePathError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }
  try {
    const isGit = await git(prepared.canonicalPath, ["rev-parse", "--is-inside-work-tree"]).then((value) => value === "true").catch(() => false);
    if (!isGit) await git(prepared.canonicalPath, ["init", "--quiet"]);
  } catch (error) {
    if (prepared.created) await rm(prepared.canonicalPath, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, code: "WORKSPACE_INVALID", error: `Failed to initialize workspace repository: ${(error as Error).message}` };
  }
  return verifyWorkspace(prepared.relativePath);
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
  /** COST/GAP-02: the calling role gates which allowlisted plugins are enabled. */
  role?: RunRoleUsage["role"];
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
  // GAP-02: re-enable only allowlisted resources. The `--no-*` flags above
  // disable discovery (including project `.pi/extensions`); explicit paths still
  // load, so the allowlist is the single source of truth.
  const selected = selectPlugins(pluginPolicy, input.role ?? "developer");
  // AT-PI-007 / AT-SEC-014: re-verify pinned content immediately before every Pi
  // invocation. A mismatch (or a missing pin when required) denies that plugin;
  // it is never passed to Pi and the denial is reported as a `plugin.denied` event.
  const verified = await verifyPluginPins(selected.enabled, { requirePin: requirePluginPin });
  const enabled = verified.enabled;
  const denials = [...selected.denials, ...verified.denials];
  const mounts = sandboxMode === "container" ? pluginMounts(enabled, pluginContainerBase) : [];
  const containerPathByHost = new Map(mounts.map((mount) => [mount.hostPath, mount.containerPath]));
  args.push(...pluginArguments(enabled, (hostPath) => containerPathByHost.get(hostPath) ?? hostPath));
  const enabledLabels = enabled.map((entry) => `${entry.kind}:${entry.path}`);
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
        // GAP-03: the reviewer reads its own snapshot, which has no git metadata
        // to share, and the mount is read-only.
        repository: input.readOnly ? undefined : await repositoryForWorktree(input.cwd),
        readOnly: input.readOnly,
        env: sandboxEnvironment({ [input.apiKeyEnvironmentName]: input.apiKey, ...(input.readOnly ? { PIGO_SANDBOX_READONLY: "1" } : {}) }),
        network: agentNetwork,
        timeoutMs: runTimeoutMs,
        signal: input.signal,
        onStdoutLine,
        label: "pi-agent",
        ...(mounts.length > 0 ? { pluginMounts: mounts } : {}),
      })
    : await command("pi", args, {
        cwd: input.cwd,
        env: childEnvironment,
        signal: input.signal,
        timeoutMs: runTimeoutMs,
        onStdoutLine,
      });
  await activityQueue;
  // GAP-05: carry the captured output so a failed call's evidence is not lost.
  if (result.code !== 0) {
    throw new PiRunError(result.stderr.trim() || `Pi exited with ${result.code}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (lastAssistantError) throw new Error(lastAssistantError);
  return { text: finalText.trim(), usage: tracker.totals, plugins: { enabled: enabledLabels, denials } };
}

/** AUD-16: cap is high enough for realistic diffs; when it is hit the artifact
 * says so explicitly instead of silently clipping. */
const maxDiffOutput = 3_400_000;

async function collectDiff(worktree: string, signal: AbortSignal, baseRef?: string) {
  await git(worktree, ["add", "-N", "."], signal);
  const args = baseRef ? ["diff", "--no-ext-diff", baseRef, "--", "."] : ["diff", "--no-ext-diff", "--", "."];
  const diff = await git(worktree, args, signal, { maxOutput: maxDiffOutput });
  if (diff.length >= maxDiffOutput) {
    return `${diff}\n# [PiGO] diff truncated at ${maxDiffOutput} characters (AUD-16)\n`;
  }
  return diff;
}

/**
 * REL-005 / AT-REL-006: wraps one Pi invocation with bounded backoff so a burst
 * of 429/5xx errors retries a few times before the run is parked for a human.
 *
 * Sprint 2: also resolves the Pi *session* plan (id, resume, fresh) and emits a
 * `session.metrics` event, aggregating the invocation into the run's additive
 * `sessions` summary. The run's token totals still come from the existing
 * `addUsage`/`budget.record` path, so sessions never double count them.
 */
async function runPiWithRetry(
  input: Parameters<typeof runPi>[0],
  context: { runId: string; round: number; label: string; role: PiSessionRole; sessionKey?: string; retry?: boolean; budget?: RunBudgetContext; sessions?: SessionAccumulator },
) {
  const budget = context.budget;
  const plan = planPiSession({ role: context.role, run: context.runId, round: context.round, retry: context.retry, key: context.sessionKey, reuse: sessionReuse });
  // Sprint 2: the CLI session manager wraps the existing invocation (same
  // session id, same retry/budget behaviour) and reports per-session metrics.
  const call = await cliSessionManager.execute({
    plan,
    signal: input.signal,
    onActivity: input.onActivity,
    invoke: async (sessionId) => {
      let modelCalls = 0;
      // NEW-08/AUD-10: every provider attempt (including failed retries) is
      // reserved and accounted; the hard model-call limit stops the retry loop.
      const outcome = await runProviderOperation(() => {
        modelCalls += 1;
        return runPi({ ...input, sessionId, role: context.role });
      }, {
        signal: input.signal,
        budget: budget
          ? { reserve: () => budget.reserve(context.role), recordUnknown: () => budget.recordUnknown() }
          : undefined,
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
      return { result: outcome, usage: outcome.usage, modelCalls };
    },
    onMetrics: async (metrics) => {
      // Instrumentation only: the run's token totals still come from the
      // addUsage/budget.record path, so sessions never double count them. A
      // failed metrics write never fails the run.
      const summaries = context.sessions?.merge(metrics, new Date().toISOString());
      await postUpdate(context.runId, {
        ...(summaries ? { patch: { sessions: summaries } } : {}),
        event: {
          round: context.round,
          source: "system",
          type: "session.metrics",
          message: `会话 ${metrics.sessionId}（${plan.role} · 第 ${plan.round} 轮 · ${plan.resume ? "复用" : "新建"}）：${metrics.modelCalls} 次调用，${(metrics.durationMs / 1000).toFixed(1)}s`,
          meta: { ...metrics },
        },
      }).catch(() => undefined);
    },
  });
  const result = call.result;
  // GAP-02: surface allowlist decisions as audit events (never silent).
  await reportPluginPolicy(context.runId, context.round, result.plugins.enabled, result.plugins.denials);
  if (budget) await budget.record(context.role, input, result.usage);
  return result;
}

async function planDevelopment(run: Run, worktree: string, credentials: JobInput["credentials"], signal: AbortSignal, usage: UsageTotals, budget?: RunBudgetContext, sessions?: SessionAccumulator) {
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
    }, { runId: run.id, round: run.round, label: "主 Agent 规划", role: "planner", budget, sessions });
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
  /** Item-3: sub-agent codename surfaced in chat instead of only the task title. */
  agentName?: string;
  usage: UsageTotals;
  budget?: RunBudgetContext;
  role?: PiSessionRole;
  sessions?: SessionAccumulator;
}) {
  const extra = input.agentName ? { agent: input.agentName } : {};
  await chat(input.run, "developer", "orchestrator", "developer", "prompt", input.prompt, input.signal, extra);
  const result = await runPiWithRetry({
    cwd: input.worktree,
    provider: input.run.developer.provider,
    model: input.run.developer.model,
    prompt: input.prompt,
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
  }, { runId: input.run.id, round: input.run.round, label: input.activityPrefix ?? "开发 Agent", role: input.role ?? "developer", sessionKey: input.sessionSuffix, budget: input.budget, sessions: input.sessions });
  addUsage(input.usage, result.usage);
  await chat(input.run, "developer", "developer", "orchestrator", "response", redactJobSecrets(result.text, input.credentials), input.signal, extra);
  return result.text;
}

/**
 * Item-3: stamp every task of a split plan with a deterministic codename. The
 * single-task plan is left untouched (it is the developer agent, not a sub-agent).
 * Idempotent: a restored checkpoint already carrying names keeps them, and a
 * fresh assignment is reproducible from runId + task id.
 */
function assignPlanCodenames(runId: string, plan: DevelopmentPlan): DevelopmentPlan {
  if (plan.tasks.length <= 1) return plan;
  if (plan.tasks.every((task) => task.name)) return plan;
  const names = assignSubAgentCodenames(runId, plan.tasks.map((task) => task.id));
  plan.tasks.forEach((task, index) => { task.name = task.name ?? names[index]; });
  return plan;
}

/** Item-3: event/chat label — codename when assigned, task title otherwise. */
function subAgentLabel(task: SubAgentTask): string {
  return task.name ? `${task.name}｜${task.title}` : task.title;
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
  sessions?: SessionAccumulator;
}): Promise<SubAgentResult> {
  const startedAt = Date.now();
  const branch = `${input.mainBranch}-sub-${input.task.id}`;
  const worktree = path.join(input.project, "subagents", input.task.id);
  input.task.status = "running";
  input.task.branch = branch;
  await mkdir(path.dirname(worktree), { recursive: true });
  await postUpdate(input.run.id, {
    event: {
      round: input.run.round,
      source: "developer",
      type: "subagent.started",
      message: `Sub Agent「${subAgentLabel(input.task)}」开始执行`,
      meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
    },
  });
  try {
    await serializeWorktreeMutation(() => git(input.project, ["worktree", "add", "-b", branch, worktree, input.mainBranch], input.signal));
    const prompt = [
      "You are a focused implementation sub-agent. Work only in the current Git worktree.",
      `Overall task: ${input.run.task}`,
      input.task.name ? `Your codename: ${input.task.name}` : "",
      `Your assigned task: ${input.task.title}\n${input.task.description}`,
      input.task.files.length ? `Primary file ownership: ${input.task.files.join(", ")}` : "Inspect and limit changes to the smallest coherent scope.",
      "Implement only your assigned part and its focused tests. Do not push, deploy, read credentials, or modify unrelated areas.",
      "Other sub-agents may work in parallel. Avoid broad formatting and generated dependency updates unless explicitly required.",
    ].filter(Boolean).join("\n\n");
    const summary = await runDeveloperAgent({
      run: input.run,
      worktree,
      credentials: input.credentials,
      signal: input.signal,
      prompt,
      sessionSuffix: `sub-${input.task.id}`,
      activityPrefix: `Sub Agent「${subAgentLabel(input.task)}」`,
      agentName: input.task.name,
      usage: input.usage,
      budget: input.budget,
      role: "sub-agent",
      sessions: input.sessions,
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
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "subagent.completed",
        message: `Sub Agent「${subAgentLabel(input.task)}」完成`,
        meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
      },
    });
    return { task: input.task, branch, worktree, commit };
  } catch (error) {
    const safeMessage = redactJobSecrets((error as Error).message, input.credentials);
    input.task.status = "failed";
    input.task.summary = safeMessage.slice(0, 1_000);
    input.task.durationMs = Date.now() - startedAt;
    // GAP-05 / AT-AGENT-008: keep a bounded, redacted tail of the failed call's
    // output as a run event so the failure stays diagnosable after the
    // sub-agent worktree is force-removed.
    const captured = failureOutputForEvent(error);
    if (captured) {
      const meta: Record<string, unknown> = { taskId: input.task.id, codename: input.task.name, exitCode: captured.exitCode };
      if (captured.stdout) meta.stdoutTail = redactJobSecrets(captured.stdout, input.credentials);
      if (captured.stderr) meta.stderrTail = redactJobSecrets(captured.stderr, input.credentials);
      await postUpdate(input.run.id, {
        event: {
          round: input.run.round,
          source: "developer",
          type: "subagent.failure_output",
          message: `Sub Agent「${subAgentLabel(input.task)}」失败输出已保留（退出码 ${captured.exitCode}，每路最多 8 KB）`,
          meta,
        },
      }).catch(() => undefined);
    }
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "subagent.failed",
        message: `Sub Agent「${subAgentLabel(input.task)}」失败，将由集成 Agent 接管：${safeMessage.slice(0, 200)}`,
        meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
      },
    });
    return { task: input.task, branch, worktree, error: safeMessage };
  }
}

async function removeSubAgentWorktree(project: string, worktree: string) {
  await serializeWorktreeMutation(() => git(project, ["worktree", "remove", "--force", worktree])).catch(() => undefined);
}

/**
 * AT-AGENT-008: before a failed sub-agent's worktree is force-removed, persist
 * its uncommitted work (patch + per-file inventory) under the run's
 * `.state/artifacts/` and emit a `subagent.failure_artifact` event. A capture
 * failure is recorded as `subagent.failure_artifact_failed`, never dropped.
 */
async function captureFailedSubAgentArtifact(run: Run, mainWorktree: string, worktree: string, task: SubAgentTask) {
  const artifactsDirectory = path.join(`${mainWorktree}.state`, "artifacts");
  const result = await captureFailedSubAgentWorktree({
    worktree,
    artifactsDirectory,
    taskId: task.id,
    // Deliberately independent of the run's abort signal: retention must still
    // work when the sub-agent failed because the run was cancelled/timed out.
    exec: (args) => runHardenedGit({ cwd: worktree, args, timeoutMs: 30_000 }),
  });
  if (result.ok) {
    const artifact = result.artifact;
    await postUpdate(run.id, {
      event: {
        round: run.round,
        source: "developer",
        type: "subagent.failure_artifact",
        message: `Sub Agent「${subAgentLabel(task)}」未提交成果已保留为制品 ${artifact.id}（patch ${artifact.patchBytes} 字节 sha256=${artifact.patchSha256}；共 ${artifact.files.length} 个文件）`,
        meta: {
          taskId: task.id,
          codename: task.name,
          artifactId: artifact.id,
          path: artifact.patchPath,
          bytes: artifact.patchBytes,
          sha256: artifact.patchSha256,
          inventoryPath: artifact.inventoryPath,
          inventorySha256: artifact.inventorySha256,
          files: artifact.files.length,
          truncated: artifact.truncated,
        },
      },
    }).catch(() => undefined);
    return;
  }
  await postUpdate(run.id, {
    event: {
      round: run.round,
      source: "developer",
      type: "subagent.failure_artifact_failed",
      message: `Sub Agent「${subAgentLabel(task)}」未提交成果保存失败：${result.error}`,
      meta: { taskId: task.id, codename: task.name, error: result.error },
    },
  }).catch(() => undefined);
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
  sessions?: SessionAccumulator;
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
        sessions: input.sessions,
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
            const merged = await runHardenedGit({ cwd: input.worktree, args: ["-c", "user.name=PiGO Integration", "-c", "user.email=agent@pigo.local", "cherry-pick", result.commit], signal: input.signal, timeoutMs: 120_000 });
            if (merged.code !== 0) {
              await runHardenedGit({ cwd: input.worktree, args: ["cherry-pick", "--abort"], timeoutMs: 120_000 }).catch(() => undefined);
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
          await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.merged", message: `Sub Agent「${subAgentLabel(result.task)}」已合并`, meta: { taskId: result.task.id, codename: result.task.name, title: result.task.title } } });
        } finally {
          // AT-AGENT-008: retain the failed sub-agent's uncommitted work before
          // its worktree is force-removed.
          if (result.error) await captureFailedSubAgentArtifact(input.run, input.worktree, result.worktree, result.task);
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
  // Delegates to the extracted suite so check execution, cancellation handling
  // and the structured `checks` chat entries are unit-tested in one place.
  return runCheckSuite({
    commands,
    signal,
    execute: async (checkCommand, execSignal) => {
      // SEC-004/010: check commands run with the worker's secrets stripped, so a
      // malicious check cannot read the internal callback token or provider keys.
      return sandboxMode === "container"
        ? await runInSandbox({
            argv: ["/bin/sh", "-lc", checkCommand],
            worktree,
            repository: await repositoryForWorktree(worktree),
            env: sandboxEnvironment({}),
            network: "none",
            timeoutMs: 600_000,
            signal: execSignal,
            label: "check",
          })
        : await command("/bin/sh", ["-lc", checkCommand], {
            cwd: worktree,
            signal: execSignal,
            timeoutMs: 600_000,
            env: scrubEnvironment(process.env),
          });
    },
    started: (checks, checkCommand) =>
      update(run, "checking", "checks", "check.started", `执行检查：${checkCommand}`, { checks }),
    finished: (checks, checkCommand, passed) =>
      postUpdate(run.id, {
        patch: { checks },
        event: { round: run.round, source: "checks", type: passed ? "check.passed" : "check.failed", message: `${checkCommand} ${passed ? "通过" : "失败"}` },
      }),
    chat: (payload) => chat(run, payload.channel, payload.from, payload.to, payload.role, payload.content, signal),
  });
}

type ReviewOutcome = { stopped: true } | { stopped: false; review: ReviewResult };

/**
 * GAP-03: materialize and verify the reviewer's immutable snapshot before the
 * review phase. Returns the snapshot directory to review, or `undefined` when
 * the run was escalated (snapshot creation failed, or the developer tree moved
 * under the snapshot). The live worktree is never handed to the reviewer.
 */
async function prepareReviewSnapshot(input: {
  run: Run;
  worktree: string;
  round: number;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { run, round } = input;
  const directory = reviewSnapshotDirectory(input.worktree, round);
  let materialized: MaterializedReviewSnapshot;
  try {
    materialized = await materializeReviewSnapshot({ worktree: input.worktree, snapshotDir: directory, signal: input.signal });
  } catch (error) {
    await destroyReviewSnapshot(directory);
    await update(run, "needs_human", "reviewer", "review.snapshot_failed", `无法创建审核只读快照，已停止审核（绝不回退到可写 worktree）：${(error as Error).message.slice(0, 300)}`, {
      summary: "审核快照创建失败，已转人工",
    });
    return undefined;
  }
  const decision = evaluateSnapshotDivergence(materialized);
  const evidence = {
    round,
    developerTree: materialized.developerTreeHash,
    developerTreeAfter: materialized.developerTreeHashAfter,
    snapshotTree: materialized.snapshotTreeHash,
    directory: path.relative(workspaceRoot, directory),
    diverged: decision.divergent,
    at: new Date().toISOString(),
  };
  await postUpdate(run.id, {
    event: {
      round,
      source: "reviewer",
      type: "review.snapshot_created",
      message: `已创建第 ${round} 轮审核只读快照（tree ${materialized.snapshotTreeHash.slice(0, 12)}）${decision.divergent ? "：与开发 worktree 不一致" : ""}`,
      meta: evidence,
    },
  });
  if (decision.divergent) {
    // GAP-03: reviewing a different tree is never allowed, so this is a
    // blocking escalation rather than a warning.
    const findings = mergeFindings(run.findings ?? [], [buildSnapshotDivergenceFinding(round, decision.reasons)]);
    await destroyReviewSnapshot(directory);
    await update(run, "needs_human", "reviewer", "review.snapshot_diverged", `审核快照与开发 worktree 的 tree hash 不一致，已阻断审核：${decision.reasons.join("；")}`, {
      findings,
      summary: "审核快照与开发 worktree 不一致，已转人工",
    });
    return undefined;
  }
  return directory;
}

async function performReview(input: {
  run: Run;
  /** GAP-03: immutable snapshot directory the reviewer reads (never the live worktree). */
  snapshotPath: string;
  credentials: JobInput["credentials"];
  round: number;
  diff: string;
  signal: AbortSignal;
  usage: UsageTotals;
  started: number;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
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
  await chat(input.run, "reviewer", "orchestrator", "reviewer", "prompt", reviewPrompt, input.signal);
  try {
    firstReview = await runPiWithRetry({
      cwd: input.snapshotPath,
      provider: input.run.reviewer.provider,
      model: input.run.reviewer.model,
      prompt: reviewPrompt,
      readOnly: true,
      apiKey: input.credentials.reviewer,
      apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
      signal: input.signal,
      onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
    }, { runId: input.run.id, round: input.round, label: "审核 Agent", role: "reviewer", budget: input.budget, sessions: input.sessions });
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
  await chat(input.run, "reviewer", "reviewer", "orchestrator", "response", redactJobSecrets(firstReview.text, input.credentials), input.signal);
  try {
    return { stopped: false, review: parseReview(redactJobSecrets(firstReview.text, input.credentials), input.round) };
  } catch (protocolError) {
    const reason = redactJobSecrets((protocolError as Error).message, input.credentials).slice(0, 200);
    await postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "review.retry", message: `审核输出无法解析（${reason}），已要求 Reviewer 重新输出` } });
    let retryReview: { text: string; usage: UsageTotals };
    try {
      retryReview = await runPiWithRetry({
        cwd: input.snapshotPath,
        provider: input.run.reviewer.provider,
        model: input.run.reviewer.model,
        prompt: `${reviewPrompt}\n\n上一次回复被拒绝：不是合法的协议 JSON。只输出 JSON 对象本身，不要 markdown 代码块，不要任何解释。`,
        readOnly: true,
        apiKey: input.credentials.reviewer,
        apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
        signal: input.signal,
        onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
      }, { runId: input.run.id, round: input.round, label: "审核 Agent（协议重试）", role: "reviewer", retry: true, budget: input.budget, sessions: input.sessions });
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
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
  checks: string[];
}) {
  const { run } = input;
  // AUD-04 / AT-RUN-007 / CHECK-003: an approval may only be produced for a
  // snapshot whose required checks passed. Re-run them here instead of trusting
  // a previous round or manual edits.
  await update(run, "checking", "checks", "checks.started", "重新审核前先复验当前代码快照", { summary: "正在复验检查命令" });
  const checked = await runChecks(run, input.worktree, input.checks, input.controller.signal);
  const checkSnapshot = await snapshotHash(input.worktree, input.controller.signal);
  await postUpdate(run.id, { patch: { checks: checked.results, checkSnapshot, checkPassed: checked.passed } });
  if (!checked.passed) {
    const failed = checked.results.filter((item) => item.status === "failed").map((item) => item.command);
    await update(run, "needs_human", "checks", "checks.blocked_retry_review", `当前快照检查未通过，已阻止重试审核：${failed.join(" / ")}`, {
      summary: "检查未通过，重试审核被拒绝",
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
    });
    return;
  }
  const diff = await collectDiff(input.worktree, input.controller.signal, input.baseCommit);
  const reviewSnapshot = await snapshotHash(input.worktree, input.controller.signal);
  // NEW-07: durable full-diff artifact for the retry-review path too.
  const retryDiffArtifact = await persistDiffArtifact(input.worktree, diff, run.round);
  // GAP-03: the reviewer reads an immutable snapshot, never the live worktree.
  const snapshotPath = await prepareReviewSnapshot({ run, worktree: input.worktree, round: run.round, signal: input.controller.signal });
  if (!snapshotPath) return;
  await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 重新审核（人工触发）`, { summary: "Reviewer Agent 正在重新审核" });
  let outcome: ReviewOutcome;
  try {
    outcome = await performReview({
      run,
      snapshotPath,
      credentials: input.credentials,
      round: run.round,
      diff,
      signal: input.controller.signal,
      usage: input.usage,
      started: input.started,
      budget: input.budget,
      sessions: input.sessions,
    });
  } finally {
    // AT-REVIEW-012: the one-shot snapshot (and its Pi state) is discarded after
    // the review, so the reviewer can never leave files behind.
    await destroyReviewSnapshot(snapshotPath);
  }
  if (outcome.stopped) return;
  const review = outcome.review;
  const findings = mergeFindings(run.findings ?? [], review.findings, { approved: review.verdict === "approved" });
  const scope = resolveReviewScope(run);
  const blocking = blockingFindings(findings, scope);
  if (shouldAcceptRound({ verdict: review.verdict, scope, blocking })) {
    if (blocking.length > 0) {
      await update(run, "needs_human", "system", "run.completion_blocked", `完成守卫拒绝：审核结论为通过但仍存在 ${blocking.length} 个阻断级问题`, {
        findings,
        diff,
        checkSnapshot,
        reviewSnapshot,
        summary: "存在未解决的阻断级问题，未完成任务",
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
      }, { diffArtifact: retryDiffArtifact });
      return;
    }
    const deferred = deferredFindings(findings, scope);
    if (isDeferral(scope, deferred)) {
      await postUpdate(run.id, {
        event: {
          round: run.round,
          source: "reviewer",
          type: "review.nonblocking_deferred",
          message: deferredMessage(run.round, deferred),
          meta: { round: run.round, scope, count: deferred.length, ids: deferred.map((finding) => finding.id) },
        },
      });
    }
    await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
      findings,
      diff,
      checkSnapshot,
      reviewSnapshot,
      checkPassed: true,
      summary: review.summary,
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
    }, { diffArtifact: retryDiffArtifact });
    return;
  }
  await update(run, "needs_human", "reviewer", "review.changes_requested", `重试审核仍发现 ${review.findings.length} 个问题，继续人工处理`, {
    findings,
    diff,
    checkSnapshot,
    reviewSnapshot,
    summary: review.summary,
    usage: toRunUsage(input.usage),
    durationMs: Date.now() - input.started,
  }, { diffArtifact: retryDiffArtifact });
}

function usageFromRun(documentUsage: Run["usage"] | undefined): UsageTotals {
  return {
    input: documentUsage?.inputTokens ?? 0,
    output: documentUsage?.outputTokens ?? 0,
    cacheRead: documentUsage?.cacheReadTokens ?? 0,
    cacheWrite: documentUsage?.cacheWriteTokens ?? 0,
    totalTokens: documentUsage?.totalTokens ?? 0,
    cost: documentUsage?.estimatedCost ?? 0,
  };
}

async function executeJob(input: JobInput, controller: AbortController) {
  const run = input.run;
  const started = Date.now();
  // AUD-10: resumes, worker restarts and human continuations accumulate into the
  // persisted usage instead of resetting it.
  const usage: UsageTotals = usageFromRun(run.usage);
  // Sprint 2: per-session summary, seeded from the run document so a restart
  // resumes the totals instead of resetting them.
  const sessions = new SessionAccumulator(run.sessions);
  const tracker = await loadTracker(run.id);
  // COST-002/003: budgets are evaluated before every model call and after each
  // one, with a single 80% warning per dimension.
  const runLimits = run.budget ?? readBudgetLimits();
  const budget = createRunBudget({
    run,
    startedAt: started,
    limits: runLimits,
    usage: () => toRunUsage(usage),
    persist: (patch) => { void postUpdate(run.id, { patch }).catch(() => undefined); },
    onWarning: async (message) => {
      await postUpdate(run.id, {
        patch: { usageRoles: run.usageRoles, modelCalls: run.modelCalls },
        event: { round: run.round, source: "system", type: "run.budget_warning", message },
      }).catch(() => undefined);
    },
  });
  // A re-claimed job (worker restart) resumes against the checkpoints already
  // recorded for this run: reuse the worktree and skip finished stages (REL-002/003).
  const recovering = Boolean(!input.resume && !input.retryReview && (input.recovery || tracker.size > 0));
  const stopHeartbeat = startJobHeartbeat(input.jobId);
  let outcomeState: "done" | "failed" | "cancelled" = "done";
  let terminalRecorded = true;
  // AUD-10: one Run level deadline covers model calls, checks and container work.
  // COST-002: a duration budget of 0/absent means unlimited, so no timer is armed.
  let deadlineExceeded = false;
  const deadline = startRunDeadline({
    startedAt: started,
    createdAt: new Date(run.createdAt).getTime(),
    maxDurationSeconds: runLimits.maxDurationSeconds,
    // RESUME: a human continue/resume stamps a fresh window base so the round is
    // not aborted against the original createdAt window that already elapsed.
    deadlineBaseAt: run.deadlineBaseAt ? new Date(run.deadlineBaseAt).getTime() : undefined,
  }, () => {
    deadlineExceeded = true;
    controller.abort();
  });
  try {
    // R3-001 / R3-FINAL-ROUND-AMBIGUOUS: terminal stop conditions are evaluated
    // before any worktree-dependent recovery/preparation, so a reclaimed run that
    // already reached its round cap, exhausted its budget or overran its deadline
    // stops with the existing event/message semantics instead of being processed
    // further. The worktree is still required (fail-closed) for a genuine
    // mid-flight resume, which the planner lets through.
    if (recovering) {
      const plan = planRecovery({
        state: run.state,
        recovery: true,
        resume: Boolean(input.resume),
        retryReview: Boolean(input.retryReview),
        round: run.round,
        maxRounds: run.maxRounds,
        usage: run.usage,
        modelCalls: run.modelCalls,
        limits: runLimits,
        createdAt: run.createdAt,
        deadlineBaseAt: run.deadlineBaseAt,
      });
      if (plan.stop) {
        const maxRoundsStop = plan.reason === "max_rounds";
        await update(run, "needs_human", "system", plan.eventType, plan.message, {
          ...(maxRoundsStop ? { findings: run.findings } : {}),
          usage: toRunUsage(usage),
          usageRoles: run.usageRoles,
          modelCalls: run.modelCalls,
          durationMs: Date.now() - started,
          summary: maxRoundsStop ? plan.message : plan.message.slice(0, 300),
        });
        return;
      }
    }
    const project = await resolveProject(run.repository);
    const dirty = await git(project, ["status", "--porcelain"], controller.signal);
    if (dirty) throw new Error("Source repository has uncommitted changes; clean it before starting a real run");
    if (!/^[a-f0-9]{64}$/.test(run.ownerId)) throw new Error("Invalid run owner");
    // AUD-01: the run directory is a standalone clone; source repositories are
    // never mounted into agent containers and their Git metadata is never shared.
    const worktree = path.join(runsRoot, run.ownerId, run.id);
    const reuseWorktree = Boolean(input.resume || input.retryReview || recovering);
    const humanInstruction = input.resume?.instruction?.trim() || "";
    if (recovering) {
      await postUpdate(run.id, {
        event: { round: run.round, source: "system", type: "run.recovered", message: `Worker 恢复未完成任务：从 ${tracker.size} 个检查点继续，不重复已完成的模型调用` },
      });
    }

    let baseCommit = run.baseSha ?? await git(project, ["rev-parse", "HEAD"], controller.signal);
    if (reuseWorktree) {
      const exists = await stat(worktree).then(() => true).catch(() => false);
      if (!exists) throw new Error("无法恢复：任务运行目录不存在（可能已被清理）");
      const branch = await git(worktree, ["branch", "--show-current"], controller.signal);
      if (branch !== run.branch) throw new Error(`无法恢复：运行目录当前分支为 ${branch || "detached"}，期望 ${run.branch}`);
      const head = await git(worktree, ["rev-parse", "HEAD"], controller.signal);
      const pending = await git(worktree, ["status", "--porcelain"], controller.signal);
      // AT-GIT-001: the pinned base SHA keeps diffs and recovery stable even if
      // the source branch moved on while the task was queued.
      baseCommit = run.baseSha ?? baseCommit;
      const recoveryLabel = input.retryReview
        ? `重试审核：复用现有运行目录（HEAD ${head.slice(0, 7)}）`
        : input.resume
          ? `人工恢复：复用已有运行目录（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的人工修改" : ""}）`
          : `Worker 恢复：复用已有运行目录（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的修改" : ""}）`;
      const recoveryState = recoveryUpdateState({
        current: run.state,
        resume: Boolean(input.resume),
        retryReview: Boolean(input.retryReview),
      });
      await update(run,
        recoveryState,
        "system",
        input.retryReview ? "review.retry_started" : input.resume ? "run.resume_detected" : "run.recovery_detected",
        recoveryLabel,
        {
          worktree: path.relative(workspaceRoot, worktree),
          summary: input.retryReview ? "Reviewer Agent 正在重新审核" : input.resume ? "人工恢复：正在准备继续执行" : `Worker 恢复：保留当前阶段（${recoveryResumePhase(recoveryState)}）并从检查点继续`,
        });
      if (humanInstruction) {
        await postUpdate(run.id, { event: { round: run.round, source: "system", type: "run.resume_instruction", message: `人工指令：${humanInstruction.slice(0, 500)}` } });
      }
    } else {
      await update(run, "preparing", "system", "workspace.preparing", "正在创建独立运行目录（克隆）", { worktree: path.relative(workspaceRoot, worktree) });
      const prepared = await prepareRunDirectory({
        project,
        runDir: worktree,
        branch: run.branch,
        baseSha: run.baseSha,
        reuse: false,
        signal: controller.signal,
      });
      baseCommit = prepared.baseSha;
      if (!run.baseSha) {
        run.baseSha = prepared.baseSha;
        await postUpdate(run.id, { patch: { baseSha: prepared.baseSha } });
      }
    }

    // AT-PI-006: project-local plugin resources stay unloaded (the `--no-*`
    // flags disable discovery); report them so an unapproved extension is
    // visible in the run audit instead of silently ignored.
    const ignoredPlugins = await detectProjectPlugins(worktree).catch(() => []);
    if (ignoredPlugins.length > 0 && !allowProjectPlugins) {
      await postUpdate(run.id, {
        event: {
          round: run.round,
          source: "system",
          type: "workspace.plugins_ignored",
          message: `检测到仓库内插件资源但默认不加载：${ignoredPlugins.join("、")}。仅启用管理员 allowlist（PI_PLUGIN_ALLOWLIST）中的插件。`,
          meta: { ignored: ignoredPlugins },
        },
      }).catch(() => undefined);
    }

    if (input.retryReview) {
      await executeRetryReview({ run, worktree, baseCommit, credentials: input.credentials, controller, usage, started, budget, sessions, checks: input.checks });
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
        assignPlanCodenames(run.id, plan);
        run.plan = plan;
        await update(run, "developing", "system", "checkpoint.development_restored", `第 ${round} 轮开发已由检查点确认完成，跳过重复的模型调用`, { plan });
        feedback = unresolvedFeedback(run.findings);
        findings = [...(run.findings ?? [])];
      } else if (round === 1) {
        const storedPlan = tracker.isCompleted(stages.planning) ? tracker.payload<DevelopmentPlan>(stages.planning) : undefined;
        plan = storedPlan ?? await planDevelopment(run, worktree, input.credentials, controller.signal, usage, budget, sessions);
        assignPlanCodenames(run.id, plan);
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
          const integrationNotes = await orchestrateSubAgents({ run, project: worktree, worktree, plan, credentials: input.credentials, signal: controller.signal, usage, tracker, budget, sessions });
          const integrationPrompt = [
            "You are the lead integration agent. Work only in the current Git worktree.",
            `Original task: ${run.task}`,
            `Sub-agent plan and final states:\n${JSON.stringify(plan, null, 2)}`,
            integrationNotes.length ? `Items requiring your direct attention:\n${integrationNotes.join("\n")}` : "All completed sub-agent commits were merged successfully.",
            "Inspect the combined code, resolve integration gaps, complete any skipped work, and add or update end-to-end tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not undo correct sub-agent work.",
          ].join("\n\n");
          await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: integrationPrompt, sessionSuffix: "integrator", activityPrefix: "集成 Agent", usage, budget, role: "integrator", sessions });
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
          const summary = await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: developerPrompt, sessionSuffix: "developer", usage, budget, sessions });
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
        await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: repairSections.join("\n\n"), sessionSuffix: "developer", activityPrefix: "修复 Agent", usage, budget, sessions });
      }
      if (!developmentDone) await tracker.complete(stages.development(round), { round, at: new Date().toISOString() });
      const diff = await collectDiff(worktree, controller.signal, baseCommit);
      const checkSnapshot = await snapshotHash(worktree, controller.signal);
      // NEW-07: persist the full diff durably before reporting it, so an
      // oversized inline patch is always recoverable (visible in the audit log).
      const checkDiffArtifact = await persistDiffArtifact(worktree, diff, round);
      await postUpdate(run.id, { event: {
        round, source: "checks", type: "diff.artifact_persisted",
        message: `第 ${round} 轮完整 diff 已持久化为制品 ${checkDiffArtifact.id}（${checkDiffArtifact.bytes} 字节，sha256=${checkDiffArtifact.sha256}）`,
        meta: { artifactId: checkDiffArtifact.id, sha256: checkDiffArtifact.sha256, bytes: checkDiffArtifact.bytes, kind: "diff" },
      } });
      await update(run, "checking", "checks", "checks.started", "Developer 完成，开始确定性检查", { diff, checkSnapshot, summary: "正在运行项目检查", usage: toRunUsage(usage) }, { diffArtifact: checkDiffArtifact });
      const storedChecksRaw = tracker.isCompleted(stages.checks(round)) ? tracker.payload<StoredChecks>(stages.checks(round)) : undefined;
      const storedChecks = isCheckpointCurrent(storedChecksRaw, { round, snapshotHash: checkSnapshot }) ? storedChecksRaw : undefined;
      if (storedChecks) {
        await postUpdate(run.id, { event: { round, source: "checks", type: "checks.checkpoint_restored", message: `从检查点恢复第 ${round} 轮检查结果，未重复执行检查命令` } });
      } else if (storedChecksRaw) {
        // NEW-03: the recorded checks were produced for different content; never
        // reuse them, re-run instead of trusting a stale verdict.
        await postUpdate(run.id, { event: { round, source: "checks", type: "checks.checkpoint_stale", message: `第 ${round} 轮检查点与当前内容不匹配，重新执行检查命令` } });
      }
      const checked = storedChecks ?? await runChecks(run, worktree, input.checks, controller.signal);
      if (!storedChecks) await tracker.complete(stages.checks(round), { ...checked, round, snapshotHash: checkSnapshot });
      if (!checked.passed) {
        feedback = `The deterministic checks failed. Fix these failures:\n${checked.results.filter((item) => item.status === "failed").map((item) => `${item.command}\n${item.output}`).join("\n\n")}`;
        await chat(run, "handoff", "checks", "developer", "feedback", feedback, controller.signal);
        await update(run, "developing", "checks", "checks.returned", "检查失败，已退回 Developer 修复", { summary: "检查失败，等待修复", checkPassed: false, ...(storedChecks ? {} : { checks: checked.results }) });
        continue;
      }

      const latestDiff = await collectDiff(worktree, controller.signal, baseCommit);
      const reviewSnapshot = await snapshotHash(worktree, controller.signal);
      const reviewDiffArtifact = await persistDiffArtifact(worktree, latestDiff, round);
      // AT-REL-003: a review that already produced a verdict is reused, so a
      // restarted worker can never emit two conflicting verdicts for one round.
      let review: ReviewResult;
      const storedReviewRaw = tracker.isCompleted(stages.review(round)) ? tracker.payload<StoredReview>(stages.review(round)) : undefined;
      const storedReview = isCheckpointCurrent(storedReviewRaw, { round, snapshotHash: reviewSnapshot }) ? storedReviewRaw : undefined;
      if (storedReview) {
        await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, checkSnapshot, reviewSnapshot, checkPassed: true, checks: checked.results, summary: "Reviewer Agent 正在审核" }, { diffArtifact: reviewDiffArtifact });
        review = storedReview;
        await postUpdate(run.id, { event: { round, source: "system", type: "review.checkpoint_restored", message: "从检查点恢复本轮审核结论，跳过重复的审核模型调用" } });
      } else {
        if (storedReviewRaw) {
          await postUpdate(run.id, { event: { round, source: "system", type: "review.checkpoint_stale", message: "本轮审核检查点与当前内容不匹配，重新执行审核" } });
        }
        // GAP-03: materialize the reviewer's immutable snapshot before announcing
        // the review, so the reviewer never reads the developer's live worktree.
        const snapshotPath = await prepareReviewSnapshot({ run, worktree, round, signal: controller.signal });
        if (!snapshotPath) return;
        await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, checkSnapshot, reviewSnapshot, checkPassed: true, checks: checked.results, summary: "Reviewer Agent 正在审核" }, { diffArtifact: reviewDiffArtifact });
        await tracker.start(stages.review(round));
        let outcome: ReviewOutcome;
        try {
          outcome = await performReview({ run, snapshotPath, credentials: input.credentials, round, diff: latestDiff, signal: controller.signal, usage, started, budget, sessions });
        } finally {
          // AT-REVIEW-012: snapshot and its state are destroyed after one use.
          await destroyReviewSnapshot(snapshotPath);
        }
        if (outcome.stopped) return;
        review = outcome.review;
        await tracker.complete(stages.review(round), { ...review, round, snapshotHash: reviewSnapshot });
      }
      findings = mergeFindings(findings, review.findings, { round, approved: review.verdict === "approved" });
      const scope = resolveReviewScope(run);
      const blocking = blockingFindings(findings, scope);
      // AT-REVIEW-010 / REVIEW-007: stop auto-repairing when the same severe
      // finding persists across the policy threshold of consecutive rounds,
      // instead of starting yet another repair round.
      const repeatedSevere = repeatedSevereFindings(findings);
      if (repeatedSevere.length > 0) {
        const labels = repeatedSevere
          .slice(0, 3)
          .map((finding) => `${finding.severity}「${finding.title}」(${finding.consecutiveRounds ?? 0} 轮)`)
          .join("；");
        await update(
          run,
          "needs_human",
          "reviewer",
          "review.severe_finding_repeated",
          `同一严重问题连续 ${severeRepeatThreshold} 轮未解决（fingerprint 稳定），已停止自动返修并转人工处理：${labels}`,
          {
            findings,
            diff: latestDiff,
            summary: `重复严重问题达到策略阈值（${severeRepeatThreshold} 轮），停止自动循环`,
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
          },
          { diffArtifact: reviewDiffArtifact },
        );
        return;
      }
      if (shouldAcceptRound({ verdict: review.verdict, scope, blocking })) {
        // AUD-03/AUD-04: independent completion guard. The review verdict alone
        // never completes a run: the checks for this snapshot must have passed
        // and no blocking finding may remain open. Under scope "blocking" the
        // blocking set is critical/high only, so a changes_requested review whose
        // remaining findings are medium/low becomes an approval-with-notes.
        const snapshotConsistent = !run.checkSnapshot || !reviewSnapshot || run.checkSnapshot === reviewSnapshot;
        if (blocking.length > 0 || !checked.passed || !snapshotConsistent) {
          const reasons = [
            blocking.length > 0 ? `${blocking.length} 个阻断级问题未解决` : "",
            checked.passed ? "" : "当前快照检查未通过",
            snapshotConsistent ? "" : "检查与审核的快照不一致（代码在检查后被修改）",
          ].filter(Boolean).join("；");
          await update(run, "needs_human", "system", "run.completion_blocked", `完成守卫拒绝：${reasons}`, {
            findings,
            diff: latestDiff,
            checkSnapshot,
            reviewSnapshot,
            checkPassed: checked.passed,
            summary: "完成守卫拒绝：存在未满足的检查或未解决的阻断问题",
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
          }, { diffArtifact: reviewDiffArtifact });
          return;
        }
        const deferred = deferredFindings(findings, scope);
        if (isDeferral(scope, deferred)) {
          // The non-blocking findings stay on the run (and in the acceptance
          // snapshot's remaining list); this event keeps them visible instead of
          // silently dropped.
          await postUpdate(run.id, {
            event: {
              round,
              source: "reviewer",
              type: "review.nonblocking_deferred",
              message: deferredMessage(round, deferred),
              meta: { round, scope, count: deferred.length, ids: deferred.map((finding) => finding.id) },
            },
          });
        }
        await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
          findings,
          diff: latestDiff,
          summary: review.summary,
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        }, { diffArtifact: reviewDiffArtifact });
        return;
      }
      // Convergence guard (incident run_e2eabf51532448b3): fire BEFORE another
      // repair round starts when the reviewer keeps raising NEW severe findings.
      // Runs after the repeated-severe/budget/deadline guards and the completion
      // path, so it never overrides a stronger terminal reason.
      const convergence = convergenceStop({
        findings,
        currentRound: round,
        enabled: reviewConvergenceGuardEnabled,
      });
      if (convergence.stop) {
        await update(run, "needs_human", "reviewer", "review.not_converging", convergence.message, {
          findings,
          diff: latestDiff,
          checkSnapshot,
          reviewSnapshot,
          checkPassed: checked.passed,
          summary: "审核未收敛，已停止自动返修并转人工处理",
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        }, { diffArtifact: reviewDiffArtifact, meta: convergence.meta });
        return;
      }
      feedback = JSON.stringify(review.findings, null, 2);
      await chat(run, "handoff", "reviewer", "developer", "feedback", feedback, controller.signal, { findings: review.findings.map((item) => ({ ...item, resolved: false })) });
      await update(run, "developing", "reviewer", "review.changes_requested", `审核发现 ${review.findings.length} 个问题，退回 Developer`, { findings, summary: review.summary, usage: toRunUsage(usage) });
    }
    await update(run, "needs_human", "system", "run.needs_human", MAX_ROUNDS_MESSAGE, { findings, usage: toRunUsage(usage), usageRoles: run.usageRoles, modelCalls: run.modelCalls, durationMs: Date.now() - started });
  } catch (error) {
    if (deadlineExceeded) {
      terminalRecorded = false;
      const message = `运行超过时限预算（${runLimits.maxDurationSeconds}s），已终止本次执行并转人工处理`;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await update(run, "needs_human", "system", "run.deadline_exceeded", message, {
            usage: toRunUsage(usage),
            usageRoles: run.usageRoles,
            modelCalls: run.modelCalls,
            durationMs: Date.now() - started,
            summary: message,
          });
          terminalRecorded = true;
          break;
        } catch (writeError) {
          console.warn(`[store] deadline terminal update failed (attempt ${attempt}): ${(writeError as Error).message}`);
          if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
        }
      }
      return;
    }
    const cancelled = controller.signal.aborted;
    outcomeState = cancelled ? "cancelled" : "failed";
    // AUD-06: nothing is recorded yet; the finally block may only finish the job
    // after this retry loop wrote the terminal state successfully.
    terminalRecorded = false;
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
    deadline.cancel();
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
    // AUD-05: only a job that actually started is a recovery; a queued job that
    // never ran begins normally (and creates its clone).
    void dispatchJob({
      run: job.run,
      checks: job.checks,
      credentials: job.credentials,
      jobId: job.jobId,
      recovery: job.wasStarted,
      ...(job.resume ? { resume: job.resume } : {}),
      ...(job.retryReview ? { retryReview: true } : {}),
    }, controller).catch((error) => {
      active.delete(job.run.id);
      console.error(`[jobs] reclaimed job ${job.jobId} failed to start: ${(error as Error).message}`);
    });
  }
  if (started > 0) console.warn(`[jobs] reclaimed ${started} unfinished job(s) after restart`);
  return started;
}

/**
 * A1: regenerates a run's full patch from its run directory, using the same
 * `git add -N . && git diff <base>` path the worker uses while executing. Used
 * by the web export route when no diff artifact body is stored (e.g. the run was
 * accepted before artifacts existed). Read-only: it never mutates the worktree
 * beyond the intent-to-add index entries the normal flow already creates.
 */
async function generateRunDiff(input: { ownerId: string; runId: string; baseSha?: string }) {
  let plan;
  try {
    plan = planRunDirectoryRemoval(runsRoot, input.ownerId, input.runId);
  } catch (error) {
    if (error instanceof RunCleanupPathError) return { ok: false as const, status: 400, code: error.code, error: error.message };
    throw error;
  }
  const exists = await stat(plan.worktree).then(() => true).catch(() => false);
  if (!exists) return { ok: false as const, status: 404, code: "RUN_DIRECTORY_MISSING", error: "任务运行目录不存在（可能已被清理）" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  timer.unref?.();
  try {
    const baseRef = input.baseSha?.trim() || undefined;
    const diff = await collectDiff(plan.worktree, controller.signal, baseRef);
    return { ok: true as const, diff, baseSha: input.baseSha ?? null };
  } catch (error) {
    return { ok: false as const, status: 500, code: "DIFF_FAILED", error: (error as Error).message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * B2: records a `run.merge_failed` event so the run timeline shows that a merge
 * failed and whether the workspace was verified back on its pre-merge branch and
 * HEAD. The event is best-effort: a callback outage must not change the merge
 * result, but a failed restore is logged loudly (never dressed up as success).
 */
async function recordMergeFailure(runId: string, result: Extract<GuardedMergeResult, { ok: false }>) {
  const originalBranch = result.original?.branch ?? null;
  const originalHead = result.original?.headSha ?? null;
  const where = originalBranch ?? `detached@${(originalHead ?? "unknown").slice(0, 12)}`;
  const message = result.restored
    ? `合并失败（${result.code}），工作区已恢复到合并前的 ${where}`
    : `合并失败（${result.code}），工作区恢复未通过校验：${result.restoreError ?? "未知原因"}`;
  if (!result.restored) console.error(`[merge] ${runId} ${message}`);
  await postUpdate(runId, {
    event: {
      round: 1,
      source: "system",
      type: "run.merge_failed",
      message,
      meta: {
        code: result.code,
        restored: result.restored,
        originalBranch,
        originalHead,
        targetBranch: result.targetBranch ?? null,
        ...(result.restoreError ? { restoreError: result.restoreError } : {}),
        ...(result.conflictingPaths?.length ? { conflictingPaths: result.conflictingPaths } : {}),
      },
    },
  });
}

/**
 * A2/B2: merges a run branch into the workspace's default branch. Fast-forwards
 * when possible, otherwise creates a merge commit. Never force-pushes and never
 * auto-resolves conflicts. The whole operation runs inside `runGuardedMerge`,
 * which captures the workspace's original branch/HEAD before any mutation and,
 * on every failure path, aborts the merge and restores + verifies that state, so
 * "the workspace was left untouched" is actually true.
 */
async function mergeRunBranch(input: {
  ownerId: string;
  runId: string;
  repository: string;
  branch: string;
  targetBranch?: string;
  message?: string;
}) {
  let plan;
  try {
    plan = planRunDirectoryRemoval(runsRoot, input.ownerId, input.runId);
  } catch (error) {
    if (error instanceof RunCleanupPathError) return { ok: false as const, status: 400, code: error.code, error: error.message };
    throw error;
  }
  const runDirExists = await stat(plan.worktree).then(() => true).catch(() => false);
  if (!runDirExists) return { ok: false as const, status: 404, code: "RUN_DIRECTORY_MISSING", error: "任务运行目录不存在（可能已被清理），无法合并" };

  let project: string;
  try {
    project = await resolveProject(input.repository);
  } catch (error) {
    return { ok: false as const, status: 400, code: "WORKSPACE_INVALID", error: (error as Error).message };
  }

  const exec: MergeGuardGitExec = (args, options) => runHardenedGit({ cwd: project, args, timeoutMs: options?.timeoutMs ?? 120_000 });
  const result = await runGuardedMerge({
    exec,
    sourcePath: plan.worktree,
    sourceBranch: input.branch,
    targetBranch: input.targetBranch,
    message: input.message,
    runId: input.runId,
  });
  if (!result.ok) {
    await recordMergeFailure(input.runId, result).catch((error) => {
      console.warn(`[merge] could not record run.merge_failed for ${input.runId}: ${(error as Error).message}`);
    });
  }
  return result;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const storage = await storageStatus();
      const version = (process.env.PI_WORKER_VERSION ?? "").trim();
      return json(response, 200, { status: "ok", service: "pigo-worker", version: version || null, activeJobs: active.size, storage: storage.state });
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
    if (request.method === "POST" && url.pathname === "/workspaces/create") {
      const body = await readJson(request) as { name?: unknown };
      return json(response, 200, await createWorkspace(String(body.name ?? "")));
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
      void dispatchJob(body, controller).catch((error) => {
        active.delete(body.run.id);
        console.error(`[jobs] job ${body.run.id} failed to start: ${(error as Error).message}`);
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
    return json(response, 500, { error: (error as Error).message });
  }
});

const resolvedSandbox = await resolveSandboxMode(process.env.PI_SANDBOX_MODE || "auto", () => docker.ping());
sandboxMode = resolvedSandbox.mode;
sandboxReason = resolvedSandbox.reason;
process.stdout.write(`[sandbox] mode=${sandboxMode}${sandboxReason ? ` (${sandboxReason})` : ""} image=${imageForSandbox}\n`);

// GAP-05: never leave a workspace locked by a worker that is shutting down.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    workspaceLocks.releaseAllSync();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

server.listen(port, host, () => {
  process.stdout.write(`pigo-worker listening on http://${host}:${port}\n`);
  void reclaimPendingJobs();
  const timer = setInterval(() => {
    void reclaimPendingJobs();
    // A deferred job whose holder went stale (crash) has no release event.
    void drainDeferredJobs();
  }, 60_000);
  timer.unref?.();
});
