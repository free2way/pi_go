import path from "node:path";
import type { Run } from "../shared/types.js";
import { DockerApi } from "./docker-api.js";
import { readStorageStatus, type StorageStatus } from "./storage-status.js";
import { convergenceGuardEnabled, reviewStallRounds } from "./review-convergence.js";
import { parseSandboxAllowDegraded, resolveSandboxMode, SandboxContainerRegistry, SandboxUnavailableError, type SandboxMode } from "./sandbox.js";
import { createGitReviewSnapshotMaterializer } from "./review-snapshot.js";
import { WorkspaceLockManager } from "./workspace-lock.js";
import { workerDiagnosticMessage } from "./diagnostic-redaction.js";
import { buildPluginPolicy } from "./plugin-registry.js";
import { CliSessionManager, sessionReuseEnabled } from "./pi-session.js";
import { defaultReviewerThinking, parseThinkingLevel, reviewerRetryMaxElapsedMs } from "./review-performance.js";

export const port = Number(process.env.PORT || 3200);
export const host = process.env.HOST || "localhost";
export const workspaceRoot = path.resolve(process.env.PI_WORKSPACE_ROOT || "/workspace");
export const projectsRoot = path.join(workspaceRoot, "projects");
export const runsRoot = path.join(workspaceRoot, "runs");
export const callbackBase = process.env.PI_WEB_CALLBACK_URL || "http://web:3100";
export const internalToken = process.env.PI_INTERNAL_TOKEN || "";
export function diagnosticMessage(error: unknown, credentials: readonly string[] = [], limit = 2_000) {
  return workerDiagnosticMessage(error, { credentials: [...credentials, callbackBase], privatePaths: [workspaceRoot], limit });
}
export const maxOutput = 48_000;
const configuredMaxSubagents = Number(process.env.PI_MAX_SUBAGENTS || 3);
export const maxSubagents = Number.isInteger(configuredMaxSubagents) ? Math.min(4, Math.max(1, configuredMaxSubagents)) : 3;
const configuredMaxActiveJobs = Number(process.env.PI_MAX_ACTIVE_JOBS || 1);
export const maxActiveJobs = Number.isInteger(configuredMaxActiveJobs) ? Math.min(4, Math.max(1, configuredMaxActiveJobs)) : 1;
export const active = new Map<string, AbortController>();
// P1: set by the SIGTERM/SIGINT handler so a shutting-down worker never claims
// (or starts) another job while it reclaims its sandbox containers.
export let shuttingDown = false;
// GAP-05 / AT-RUN-012: one run per workspace at a time. Lock files live under
// the workspace root so a worker restart cannot leave a workspace locked: the
// heartbeat goes stale and the next claim reclaims it.
const configuredLockStale = Number(process.env.PI_WORKSPACE_LOCK_STALE_SECONDS || 300);
export const workspaceLockStaleMs = Number.isFinite(configuredLockStale) ? Math.max(30, configuredLockStale) * 1_000 : 300_000;
export const workspaceLocks = new WorkspaceLockManager({
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
export const reviewConvergenceGuardEnabled = convergenceGuardEnabled();
// incident run_e7c565d6335a4bc7: also stop when the SAME batch of blocking
// findings (stable key) is re-reported for PI_REVIEW_STALL_ROUNDS rounds.
export const reviewStallRoundsThreshold = reviewStallRounds();
export const reviewerThinking = parseThinkingLevel(process.env.PI_REVIEWER_THINKING, defaultReviewerThinking);
export const reviewerRetryMaxElapsed = reviewerRetryMaxElapsedMs();

/**
 * AT-REL-010: reports workspace disk headroom so new work stops before the
 * source repositories or their worktrees are damaged by a full disk.
 */
export async function storageStatus(): Promise<StorageStatus> {
  return readStorageStatus({
    path: workspaceRoot,
    minFreeMb: minFreeDiskMb,
    criticalFreeMb: criticalFreeDiskMb,
    onError: (error) => console.warn(`[storage] statfs failed: ${diagnosticMessage(error)}`),
  });
}
let worktreeMutationQueue: Promise<void> = Promise.resolve();

export function serializeWorktreeMutation<T>(operation: () => Promise<T>) {
  const result = worktreeMutationQueue.then(operation, operation);
  worktreeMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export type JobInput = {
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

export const workerId = process.env.PI_WORKER_ID || `worker-${process.pid}`;

// SEC-004 / AT-SEC-007:每次 Agent 调用与检查命令都在独立容器中执行，只挂载本次
// 运行的 worktree（及其仓库 .git 元数据）、只读模型定义与本次运行的 Pi 状态目录。
const sandboxImage = process.env.PI_SANDBOX_IMAGE || "local/pigo-sandbox:0.1.0";
export const sandboxUser = process.env.PI_SANDBOX_USER || "node";
/** Network used for agent calls (provider egress). Checks always run with none. */
export const agentNetwork = process.env.PI_SANDBOX_NETWORK || "pi-agent-network";
export const hostWorkspaceRoot = process.env.PI_HOST_WORKSPACE_ROOT || workspaceRoot;
export const docker = new DockerApi();
export let sandboxMode: SandboxMode = "process";
export let sandboxReason: string | undefined = "not initialised";
/** True when the container sandbox was unusable and the operator opted into the degraded mode. */
export let sandboxDegraded = false;
/**
 * P1: every sandbox container this worker started, so a shutdown can stop them
 * before the process exits instead of leaving one writing into a run worktree.
 */
export const sandboxContainers = new SandboxContainerRegistry();

export const imageForSandbox = sandboxImage;
/** Extra bind mounts for the sandbox container (operator/test escape hatch). */
export const sandboxExtraBinds = (process.env.PI_SANDBOX_EXTRA_BINDS || "").split(",").map((item) => item.trim()).filter(Boolean);
/** Extra environment variable names to pass through into the sandbox. */
export const sandboxExtraEnv = (process.env.PI_SANDBOX_EXTRA_ENV || "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * P1 (fail-closed): refuse to execute an agent when the container sandbox could
 * not be established. The default must never silently degrade to in-process
 * execution; only `PI_SANDBOX_ALLOW_DEGRADED=1` (strictly parsed) or an explicit
 * `PI_SANDBOX_MODE=process` makes `sandboxMode` a usable non-container mode.
 */
export function assertSandboxReady() {
  if (sandboxMode === "unavailable") throw new SandboxUnavailableError(sandboxReason);
}

/**
 * GAP-03: creates the reviewer's immutable one-shot snapshot. Injectable so the
 * decision logic can be exercised without shelling out to git.
 */
export const materializeReviewSnapshot = createGitReviewSnapshotMaterializer();

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
export const pluginPolicy = buildPluginPolicy({
  allowlist: process.env.PI_PLUGIN_ALLOWLIST,
  requests: process.env.PI_PLUGIN_REQUESTS,
  registry: process.env.PI_PLUGIN_REGISTRY,
});
export const allowProjectPlugins = process.env.PI_PLUGIN_ALLOW_PROJECT === "true";
/** AT-PI-007/AT-SEC-014: when set, every allowlisted plugin must carry a sha256 pin. */
export const requirePluginPin = process.env.PI_PLUGIN_REQUIRE_PIN === "true";
/** Container directory that hosts read-only allowlisted plugin mounts. */
export const pluginContainerBase = process.env.PI_PLUGIN_CONTAINER_DIR || "/opt/pigo/plugins";
/** Sprint 2: single CLI-backed Pi session manager (adds instrumentation only). */
export const cliSessionManager = new CliSessionManager();
/**
 * Sprint 2 A/B switch, read once here so the decision is a plain boolean at the
 * call site (never an env lookup deep inside `runPiWithRetry`). Default on.
 */
export const sessionReuse = sessionReuseEnabled();

export function stopClaimingJobs() {
  shuttingDown = true;
}

export async function initializeSandbox() {
  // P1 (fail-closed): the default never degrades to in-process execution; only
  // PI_SANDBOX_ALLOW_DEGRADED=1 (strictly parsed) or PI_SANDBOX_MODE=process does.
  const resolvedSandbox = await resolveSandboxMode(
    process.env.PI_SANDBOX_MODE || "auto",
    () => docker.ping(),
    { allowDegraded: parseSandboxAllowDegraded(process.env.PI_SANDBOX_ALLOW_DEGRADED) },
  );
  sandboxMode = resolvedSandbox.mode;
  sandboxReason = resolvedSandbox.reason;
  sandboxDegraded = resolvedSandbox.degraded === true;
  process.stdout.write(`[sandbox] mode=${sandboxMode}${sandboxReason ? ` (${sandboxReason})` : ""} image=${imageForSandbox}\n`);
  if (sandboxMode === "unavailable") {
    process.stderr.write(
      "[sandbox] 容器沙箱不可用：已启用 fail-closed，worker 将拒绝执行任何 Agent。"
      + "请修复 Sandbox Gateway / Docker runtime / 沙箱镜像后重启；"
      + "仅在明确接受关闭隔离时，才可设置 PI_SANDBOX_ALLOW_DEGRADED=1 允许降级执行。\n",
    );
  }
}
