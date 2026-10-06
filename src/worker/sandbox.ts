import path from "node:path";
import type { ContainerCreateSpec } from "./docker-api.js";

export type SandboxNetwork = "none" | "bridge" | (string & {});

export interface SandboxRequest {
  /** Container image that provides the Pi runtime (has pi, node, git). */
  image: string;
  /** Container-visible worktree path; also used as the working directory. */
  worktree: string;
  /** Host path backing `worktree` (the Docker daemon resolves bind sources on the host). */
  hostWorktreePath: string;
  /**
   * GAP-03: mount the worktree read-only and skip the repository metadata bind.
   * Used for the reviewer's one-shot snapshot so a review cannot write back.
   */
  readOnly?: boolean;
  /** Host path of the repository the worktree belongs to (git metadata must stay writable). */
  hostRepositoryPath?: string;
  /** Container path that receives git metadata access (worktree `.git` link target). */
  repositoryPath?: string;
  /** Read-only provider/model definition mount. */
  hostModelsFile?: string;
  modelsFile?: string;
  /** Container path for per-run Pi state (sessions, caches). */
  stateDir: string;
  stateMount?: "volume" | "bind";
  /** Absolute host path backing the state directory when using a bind mount. */
  hostStateDir?: string;
  /** GAP-02: allowlisted Pi plugins, mounted read-only into the sandbox. */
  pluginMounts?: Array<{ hostPath: string; containerPath: string }>;
  env: Record<string, string>;
  argv: string[];
  user?: string;
  network: SandboxNetwork;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  labels?: Record<string, string>;
}

/**
 * SEC-004 / AT-SEC-007 / AT-SEC-010: builds the per-invocation container spec.
 *
 * Only the run's own worktree (plus the repository git metadata the worktree
 * links to) is mounted; other projects, the worker environment and the Docker
 * socket are never exposed. Check commands run with `network: "none"`.
 */
export function buildContainerSpec(request: SandboxRequest): ContainerCreateSpec {
  // GAP-03 / AT-SEC-009: the reviewer snapshot is mounted read-only, and the
  // repository metadata bind is skipped entirely (a snapshot has no `.git`, and
  // the reviewer must never see the developer repository's mutable metadata).
  const binds = [`${request.hostWorktreePath}:${request.worktree}:${request.readOnly ? "ro" : "rw"}`];
  if (!request.readOnly && request.hostRepositoryPath && request.repositoryPath) {
    // `.git` is shared so the worktree can commit; working trees of other
    // projects are still invisible because only this repository's metadata is
    // mounted.
    binds.push(`${request.hostRepositoryPath}/.git:${request.repositoryPath}/.git:rw`);
  }
  if (request.hostModelsFile && request.modelsFile) {
    binds.push(`${request.hostModelsFile}:${request.modelsFile}:ro`);
  }
  if (request.stateMount === "bind" && request.hostStateDir) {
    binds.push(`${request.hostStateDir}:${request.stateDir}:rw`);
  }
  for (const plugin of request.pluginMounts ?? []) {
    // GAP-02: only explicitly allowlisted resources are exposed, and read-only
    // so a task can never tamper with an approved plugin.
    binds.push(`${plugin.hostPath}:${plugin.containerPath}:ro`);
  }

  const env = Object.entries(request.env).map(([key, value]) => `${key}=${value}`);

  return {
    Image: request.image,
    Cmd: request.argv,
    Env: env,
    WorkingDir: request.worktree,
    User: request.user ?? "node",
    HostConfig: {
      Binds: binds,
      NetworkMode: request.network,
      AutoRemove: false,
      ReadonlyRootfs: true,
      // Pi and the toolchain need scratch space, but nothing persists outside
      // the run worktree and the per-run state directory.
      Tmpfs: {
        "/tmp": "size=512m,mode=1777",
        "/run": "size=16m,mode=755",
        "/home/node/.cache": "size=64m,mode=700,uid=1000,gid=1000",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: request.pidsLimit ?? 256,
      Memory: request.memoryBytes ?? 2 * 1024 * 1024 * 1024,
      NanoCpus: request.nanoCpus ?? 1_500_000_000,
    },
    Labels: { "pigo.sandbox": "1", ...(request.labels ?? {}) },
  };
}

/** Maps a container path to its host path using the configured workspace root. */
export function hostPathFor(containerPath: string, containerRoot: string, hostRoot: string) {
  const relative = path.relative(containerRoot, containerPath);
  if (relative.startsWith("..")) throw new Error(`Path ${containerPath} escapes ${containerRoot}`);
  return path.join(hostRoot, relative);
}

/**
 * Pi state must live outside the code worktree. For a nested sub-agent worktree,
 * its historical sibling `<subagent>.state` was still inside the main run tree
 * and `git add -N .` treated the runtime files as source changes.
 */
export function sandboxStateDirectory(worktree: string, override?: string): string {
  const resolvedWorktree = path.resolve(worktree);
  const state = override?.trim() ? path.resolve(override) : `${resolvedWorktree}.state`;
  const relative = path.relative(resolvedWorktree, state);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`Sandbox state directory must be outside worktree: ${state}`);
  }
  return state;
}

export type SandboxMode = "container" | "process" | "unavailable";

export interface ResolvedSandboxMode {
  mode: SandboxMode;
  reason?: string;
  /** True when the container sandbox was unusable and the operator opted in. */
  degraded?: boolean;
}

/**
 * P1: the opt-in that closes the fail-open default is parsed strictly. Only the
 * exact literal `1` enables in-process execution when the container sandbox
 * cannot be established; unset/empty, `true`, `yes`, ` 1` and `01` all keep the
 * fail-closed default, so degraded isolation can never be entered by accident.
 */
export function parseSandboxAllowDegraded(value: string | undefined): boolean {
  return value === "1";
}

/**
 * P1 (fail-closed): raised when the container sandbox cannot be established and
 * the operator did not opt into degraded execution. The worker refuses to run
 * the agent instead of silently dropping isolation.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";

  constructor(reason?: string) {
    super(
      "容器沙箱不可用，已按 fail-closed 策略拒绝执行本次 Agent（不会降级为进程内运行，避免隔离静默失效）。"
      + "请检查 Docker daemon 与 PI_DOCKER_SOCKET 是否可用、沙箱镜像（PI_SANDBOX_IMAGE）是否存在后重试；"
      + "仅在完全受信且明确接受关闭隔离的环境，才可显式设置 PI_SANDBOX_ALLOW_DEGRADED=1（仅接受字面值 1）后重启 worker。"
      + (reason ? `原因：${reason}` : ""),
    );
    this.name = "SandboxUnavailableError";
  }
}

/**
 * P1 (fail-closed): sandbox mode is explicit.
 *
 * - `process` is a deliberate operator opt-out (PI_SANDBOX_MODE=process).
 * - `container`/`auto` require a reachable Docker socket. When it is unusable
 *   the result is `unavailable` — never a silent fall back to in-process
 *   execution. Only `allowDegraded` (PI_SANDBOX_ALLOW_DEGRADED=1) permits the
 *   degraded `process` mode, and the result is flagged `degraded` so the run can
 *   report it.
 */
export async function resolveSandboxMode(
  mode: string,
  ping: () => Promise<boolean>,
  options: { allowDegraded?: boolean } = {},
): Promise<ResolvedSandboxMode> {
  if (mode === "process") return { mode: "process", reason: "disabled by PI_SANDBOX_MODE=process" };
  let reason: string | undefined;
  try {
    await ping();
  } catch (error) {
    reason = mode === "container"
      ? `docker socket not usable: ${(error as Error).message}`
      : `docker socket unavailable: ${(error as Error).message}`;
  }
  if (reason === undefined) return { mode: "container" };
  if (options.allowDegraded) return { mode: "process", reason, degraded: true };
  return { mode: "unavailable", reason };
}

export interface SandboxContainerHandle {
  /** Container id, used for logging and teardown bookkeeping. */
  id: string;
  /** Sends a stop signal; the container runtime decides how it is delivered. */
  stop: (signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  /** Resolves when the container has exited (best effort; may never resolve). */
  wait: () => Promise<unknown>;
}

export interface SandboxStopResult {
  /** Containers that exited within the grace period after SIGTERM. */
  stopped: string[];
  /** Containers that ignored SIGTERM and had to be force-killed (SIGKILL). */
  forced: string[];
  /** Containers still not confirmed exited after the force-kill wait. */
  unconfirmed: string[];
}

export const DEFAULT_SANDBOX_STOP_GRACE_MS = 10_000;
export const DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS = 5_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * P1: containers this worker started, so SIGTERM/SIGINT can stop them before the
 * process exits. Without it a worker exit left its sandbox running and writing
 * into the run worktree.
 */
export class SandboxContainerRegistry {
  private readonly handles = new Map<string, SandboxContainerHandle>();
  private stopping?: Promise<SandboxStopResult>;

  /** Registers a started container; the returned disposer forgets it. */
  add(handle: SandboxContainerHandle): () => void {
    this.handles.set(handle.id, handle);
    return () => { this.handles.delete(handle.id); };
  }

  /** Ids of the containers currently tracked as running. */
  running(): string[] {
    return [...this.handles.keys()];
  }

  get size(): number {
    return this.handles.size;
  }

  /**
   * Stops every tracked container: SIGTERM, a bounded wait for termination, then
   * SIGKILL for anything still alive with a second bounded wait. Idempotent —
   * concurrent or repeated calls share one teardown, so a repeated signal can
   * never double-stop (or race) the containers.
   */
  stopAll(options: { graceMs?: number; forceKillGraceMs?: number } = {}): Promise<SandboxStopResult> {
    this.stopping ??= this.teardown(options);
    return this.stopping;
  }

  private async teardown(options: { graceMs?: number; forceKillGraceMs?: number }): Promise<SandboxStopResult> {
    const graceMs = options.graceMs ?? DEFAULT_SANDBOX_STOP_GRACE_MS;
    const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS;
    const stopped: string[] = [];
    const forced: string[] = [];
    const unconfirmed: string[] = [];
    // Two bounded passes: pass 1 politely stops the containers already running
    // (SIGTERM, grace wait, then SIGKILL for whatever survived); pass 2
    // force-kills any sandbox a still-active job registered while pass 1 was
    // waiting, so a shutting-down worker never leaves one writing into a worktree.
    for (let pass = 0; pass < 2; pass += 1) {
      const handles = [...this.handles.values()];
      if (handles.length === 0) break;
      if (pass > 0) {
        // Late arrival: it never had the chance to receive the polite signal.
        forced.push(...handles.map((handle) => handle.id));
        await Promise.all(handles.map((handle) => handle.stop("SIGKILL").catch(() => undefined)));
        await Promise.all(handles.map(async (handle) => {
          if (!(await settlesWithin(handle.wait(), forceKillGraceMs))) unconfirmed.push(handle.id);
        }));
      } else {
        await Promise.all(handles.map((handle) => handle.stop("SIGTERM").catch(() => undefined)));
        const exited = await waitForExit(handles, graceMs);
        for (const handle of handles) (exited.has(handle.id) ? stopped : forced).push(handle.id);
        const survivors = handles.filter((handle) => !exited.has(handle.id));
        await Promise.all(survivors.map((handle) => handle.stop("SIGKILL").catch(() => undefined)));
        await Promise.all(survivors.map(async (handle) => {
          if (!(await settlesWithin(handle.wait(), forceKillGraceMs))) unconfirmed.push(handle.id);
        }));
      }
      for (const handle of handles) this.handles.delete(handle.id);
    }
    return { stopped, forced, unconfirmed };
  }
}

/** Ids of `handles` that exited within `ms` (bounded, never rejects). */
async function waitForExit(handles: SandboxContainerHandle[], ms: number): Promise<Set<string>> {
  const exited = new Set<string>();
  await Promise.all(handles.map(async (handle) => {
    if (await settlesWithin(handle.wait(), ms)) exited.add(handle.id);
  }));
  return exited;
}

/** Resolves true when `promise` resolves within `ms`; false on timeout/rejection. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WorkerShutdownDeps {
  /** Runs once: stop accepting and claiming new jobs. */
  stopClaiming: () => void;
  /** Stops every sandbox container this worker started (bounded internally). */
  stopSandboxes: () => Promise<SandboxStopResult>;
  /** Releases workspace locks synchronously (never leave a workspace locked). */
  releaseLocks: () => void;
  exit: (code: number) => void;
  /** Hard upper bound for the whole teardown before the process exits. */
  timeoutMs?: number;
  /** Optional structured log sink (defaults to no logging). */
  log?: (message: string) => void;
}

/**
 * P1: builds the SIGTERM/SIGINT handler. The first signal stops job claiming and
 * reclaims the sandbox containers; repeated signals are ignored so a second
 * signal can never exit the process before the sandboxes have stopped. The whole
 * teardown is bounded by `timeoutMs`, so even a stuck stop exits (SIGINT=130,
 * SIGTERM=143).
 */
export function createShutdownHandler(deps: WorkerShutdownDeps): (signal: "SIGTERM" | "SIGINT") => Promise<void> {
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let shutdown: Promise<void> | undefined;
  return (signal) => {
    if (shutdown) {
      log(`[shutdown] 已在停止中，忽略重复的 ${signal}`);
      return shutdown;
    }
    shutdown = (async () => {
      const exitCode = signal === "SIGINT" ? 130 : 143;
      log(`[shutdown] 收到 ${signal}：停止领取新任务并回收沙箱容器`);
      deps.stopClaiming();
      try {
        const result = await withTimeout(deps.stopSandboxes(), timeoutMs);
        if (result.timedOut) {
          log(`[shutdown] 沙箱回收超过 ${timeoutMs}ms 仍未完成，进程将强制退出`);
        } else if (result.value) {
          log(`[shutdown] 沙箱已回收：正常停止 ${result.value.stopped.length} 个，强制终止 ${result.value.forced.length} 个，未确认退出 ${result.value.unconfirmed.length} 个`);
        }
      } catch (error) {
        log(`[shutdown] 回收沙箱失败：${(error as Error).message}`);
      }
      deps.releaseLocks();
      deps.exit(exitCode);
    })();
    return shutdown;
  };
}

/** Awaits `promise`, giving up after `ms`; a rejection still propagates. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: boolean; value?: T }> {
  if (ms <= 0) return { timedOut: false, value: await promise };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise<{ timedOut: boolean }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
