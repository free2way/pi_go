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
  /**
   * Removes the container from the host after it stopped or was force-killed.
   *
   * Optional so existing callers keep working; when present it is called once
   * per handle during teardown. A rejection or an over-long removal is reported
   * through `SandboxStopResult.removalFailed` and never aborts shutdown.
   */
  remove?: () => Promise<unknown>;
}

/** A container that stopped but could not be confirmed removed. */
export interface SandboxRemovalFailure {
  id: string;
  /** Why the removal was not confirmed (runtime error or timeout). */
  error: string;
}

/** A container whose exit could not be confirmed, with the reason. */
export interface SandboxWaitFailure {
  id: string;
  /** Timeout, or the wait's rejection (a concurrently removed container is not a failure). */
  error: string;
}

export interface SandboxStopResult {
  /** Containers that exited within the grace period after SIGTERM. */
  stopped: string[];
  /** Containers that ignored SIGTERM and had to be force-killed (SIGKILL). */
  forced: string[];
  /** Containers still not confirmed exited after the force-kill wait. */
  unconfirmed: string[];
  /**
   * Containers whose removal was confirmed during this teardown. Optional so
   * pre-existing producers (tests, stubs) stay source compatible; stopAll always
   * populates it.
   */
  removed?: string[];
  /** Containers that stopped (or were killed) but whose removal failed/timed out. */
  removalFailed?: SandboxRemovalFailure[];
  /**
   * Why each `unconfirmed` container could not be confirmed exited. Optional so
   * pre-existing producers stay source compatible; stopAll always populates it.
   */
  unconfirmedReasons?: SandboxWaitFailure[];
}

/** Optional overrides for {@link SandboxContainerRegistry.stopAll}. */
export interface SandboxStopOptions {
  /** How long a container gets to exit after SIGTERM. */
  graceMs?: number;
  /** How long a container gets to exit after SIGKILL. */
  forceKillGraceMs?: number;
  /** Upper bound for each container's removal; `<= 0` skips removal entirely. */
  removalTimeoutMs?: number;
}

export const DEFAULT_SANDBOX_STOP_GRACE_MS = 10_000;
export const DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS = 5_000;
export const DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS = 5_000;
/**
 * Safety cap on teardown passes. Normal shutdown uses one pass, or two when a
 * still-active job registers a sandbox while the first pass waits. The cap only
 * exists so a pathological producer that keeps registering cannot spin forever.
 */
export const MAX_SANDBOX_TEARDOWN_PASSES = 8;
/** Room on top of the phase budget so logging, lock release and exit are not starved. */
export const SANDBOX_TEARDOWN_MARGIN_MS = 5_000;

/**
 * Worst-case wall clock of one {@link SandboxContainerRegistry.stopAll}.
 *
 * Up to two full passes can run (the first SIGTERMs and waits; the second
 * force-kills whatever a still-active job registered meanwhile), and a fully
 * stuck container consumes every phase of both: SIGTERM grace + SIGKILL grace +
 * removal. The old default shutdown bound (20s) was exactly one phase sum, so a
 * fully stuck teardown was cut off *before* its removal pass and the containers
 * lingered — the very thing the removal step exists to prevent. The budget is
 * therefore the worst case plus {@link SANDBOX_TEARDOWN_MARGIN_MS}.
 */
export function sandboxTeardownBudgetMs(options: SandboxStopOptions = {}): number {
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_SANDBOX_STOP_GRACE_MS);
  const forceKillGraceMs = Math.max(0, options.forceKillGraceMs ?? DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS);
  const removalTimeoutMs = Math.max(0, options.removalTimeoutMs ?? DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS);
  return 2 * (graceMs + forceKillGraceMs + removalTimeoutMs) + SANDBOX_TEARDOWN_MARGIN_MS;
}

/**
 * Hard upper bound for the whole SIGTERM/SIGINT teardown. With the default
 * phases this is 2×(10s + 5s + 5s) + 5s = 45s; only a container that ignores
 * SIGTERM *and* SIGKILL *and* a hung removal can approach it.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = sandboxTeardownBudgetMs();

/** Raised when a container is registered after teardown already finished. */
export class SandboxClosingError extends Error {
  readonly code = "SANDBOX_CLOSING";

  constructor(id: string) {
    super(
      `容器注册表已完成回收，拒绝登记沙箱 ${id}：本次关闭流程已无法再回收它。`
      + "该容器已在登记处被直接强制终止并尽力移除，调用方不得在该沙箱中继续执行。",
    );
    this.name = "SandboxClosingError";
  }
}

/** Lifecycle of the registry: open → (stopAll) closing → closed. */
export type SandboxRegistryState = "open" | "closing" | "closed";

/**
 * True when a Docker call failed because the container no longer exists
 * (404 / "No such container"). That is the outcome of a force-remove racing a
 * pending `wait`/`remove`; for teardown it means "gone", not "failed".
 */
export function isContainerGoneError(error: unknown): boolean {
  const message = messageOf(error);
  return /no such container/i.test(message) || /\b404\b/.test(message);
}

export type SandboxExitOutcome =
  | { outcome: "exited"; value: unknown }
  | { outcome: "removed"; error: string }
  | { outcome: "failed"; error: string };

/**
 * AUD follow-up: awaits a container `wait` without letting a concurrent
 * force-remove surface as an error. A wait that ends because the container was
 * removed (shutdown teardown, or the run's own cleanup) resolves as `removed` —
 * the container is definitively gone — so the run/finalisation path treats it
 * deterministically instead of raising a spurious 404.
 */
export async function awaitSandboxExit(wait: () => Promise<unknown>): Promise<SandboxExitOutcome> {
  try {
    return { outcome: "exited", value: await wait() };
  } catch (error) {
    const message = messageOf(error);
    return isContainerGoneError(error) ? { outcome: "removed", error: message } : { outcome: "failed", error: message };
  }
}

/** Exit code reported for a run whose container was force-removed under it (SIGKILL). */
export const SANDBOX_KILLED_EXIT_CODE = 137;

/**
 * P1: containers this worker started, so SIGTERM/SIGINT can stop them before the
 * process exits. Without it a worker exit left its sandbox running and writing
 * into the run worktree.
 *
 * Registration is refused once teardown *finished* (its result is cached, so no
 * pass can ever sweep a newcomer); a refused container is force-killed and
 * best-effort removed right there, so refusing cannot orphan it. Between
 * "stopAll was called" and "teardown finished" registrations are accepted,
 * because the teardown loop keeps running passes until it observes an empty
 * registry — a sandbox registered mid-teardown is therefore always swept, never
 * missed.
 */
export class SandboxContainerRegistry {
  private readonly handles = new Map<string, SandboxContainerHandle>();
  private stopping?: Promise<SandboxStopResult>;
  private state: SandboxRegistryState = "open";

  /** Registers a started container; the returned disposer forgets it. */
  add(handle: SandboxContainerHandle): () => void {
    if (this.state === "closed") {
      // Teardown already cached its result: it will never see this handle again.
      // Tear the container down here (best effort) so the refusal cannot leak a
      // live sandbox, then refuse the registration.
      sweepRefusedContainer(handle);
      throw new SandboxClosingError(handle.id);
    }
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

  /** True once `stopAll` has started (further registrations are swept or refused). */
  get closing(): boolean {
    return this.state !== "open";
  }

  /**
   * Stops every tracked container: SIGTERM, a bounded wait for termination, then
   * SIGKILL for anything still alive with a second bounded wait, and finally a
   * bounded best-effort `remove` so no exited sandbox lingers on the host.
   * Idempotent — concurrent or repeated calls share one teardown and its cached
   * result, so a repeated signal can never double-stop (or race) the containers.
   *
   * Passes repeat until the registry is observed empty (bounded by
   * {@link MAX_SANDBOX_TEARDOWN_PASSES}), so a sandbox registered while a pass is
   * waiting is swept by the next pass instead of being missed.
   */
  stopAll(options: SandboxStopOptions = {}): Promise<SandboxStopResult> {
    if (!this.stopping) {
      this.state = "closing";
      this.stopping = this.teardown(options);
    }
    return this.stopping;
  }

  private async teardown(options: SandboxStopOptions): Promise<SandboxStopResult> {
    const graceMs = options.graceMs ?? DEFAULT_SANDBOX_STOP_GRACE_MS;
    const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_SANDBOX_FORCE_KILL_GRACE_MS;
    const removalTimeoutMs = options.removalTimeoutMs ?? DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS;
    const stopped: string[] = [];
    const forced: string[] = [];
    const unconfirmed: string[] = [];
    const unconfirmedReasons: SandboxWaitFailure[] = [];
    const removalFailed: SandboxRemovalFailure[] = [];
    const removedIds = new Set<string>();
    const markRemoved = (id: string) => { removedIds.add(id); };

    // Pass 1 politely stops the containers already running (SIGTERM, grace wait,
    // then SIGKILL for whatever survived); later passes force-kill the sandboxes
    // a still-active job registered while an earlier pass was waiting, so a
    // shutting-down worker never leaves one writing into a worktree. The loop
    // re-checks the registry after every pass; the empty check and the return
    // below are not separated by an await, so an `add` either lands before the
    // check (seen by another pass) or after `state = "closed"` (refused).
    for (let pass = 0; this.handles.size > 0; pass += 1) {
      const handles = [...this.handles.values()];
      const gone = new Set<string>();
      if (pass >= MAX_SANDBOX_TEARDOWN_PASSES) {
        // Safety valve: a pathological producer keeps registering sandboxes
        // while we tear down. Refuse (and tear down) anything registered from
        // here on — so no newcomer can enter the map — then force-sweep and
        // report what is tracked. Teardown therefore always terminates and never
        // closes with a live sandbox still "tracked".
        this.state = "closed";
        forced.push(...handles.map((handle) => handle.id));
        await Promise.all(handles.map((handle) => handle.stop("SIGKILL").catch(() => undefined)));
        const exits = await waitForExit(handles, forceKillGraceMs);
        for (const handle of handles) {
          const result = exits.get(handle.id);
          if (result?.kind === "removed") { markRemoved(handle.id); continue; }
          if (result?.kind === "exited") continue;
          unconfirmed.push(handle.id);
          unconfirmedReasons.push({ id: handle.id, error: `teardown pass limit (${MAX_SANDBOX_TEARDOWN_PASSES}) reached` });
        }
        await removeHandles(handles, removalTimeoutMs, markRemoved, removalFailed);
        for (const handle of handles) this.handles.delete(handle.id);
        break;
      }
      if (pass > 0) {
        // Late arrival: it never had the chance to receive the polite signal.
        forced.push(...handles.map((handle) => handle.id));
        await Promise.all(handles.map((handle) => handle.stop("SIGKILL").catch(() => undefined)));
        await collectWaitOutcomes(await waitForExit(handles, forceKillGraceMs), handles, gone, unconfirmed, unconfirmedReasons);
      } else {
        await Promise.all(handles.map((handle) => handle.stop("SIGTERM").catch(() => undefined)));
        const exits = await waitForExit(handles, graceMs);
        const survivors: SandboxContainerHandle[] = [];
        for (const handle of handles) {
          const result = exits.get(handle.id);
          if (result?.kind === "removed") { gone.add(handle.id); continue; }
          if (result?.kind === "exited") { stopped.push(handle.id); continue; }
          // Survived SIGTERM (or its wait timed out/failed): force-kill it.
          forced.push(handle.id);
          survivors.push(handle);
        }
        await Promise.all(survivors.map((handle) => handle.stop("SIGKILL").catch(() => undefined)));
        await collectWaitOutcomes(await waitForExit(survivors, forceKillGraceMs), survivors, gone, unconfirmed, unconfirmedReasons);
      }
      for (const id of gone) markRemoved(id);
      // AUD: the normal removal lives in `runInSandbox`'s `finally`, which may
      // never run before `process.exit`; remove here too (a lingering exited
      // container is exactly what this teardown exists to prevent). Handles
      // already confirmed gone are not removed a second time.
      await removeHandles(handles.filter((handle) => !gone.has(handle.id)), removalTimeoutMs, markRemoved, removalFailed);
      for (const handle of handles) this.handles.delete(handle.id);
    }
    this.state = "closed";
    return { stopped, forced, unconfirmed, removed: [...removedIds], removalFailed, unconfirmedReasons };
  }
}

/**
 * Records bounded-wait outcomes: containers confirmed gone (`removed`) count as
 * removed, and only genuine timeouts/failures land in `unconfirmed` — with a
 * reason, so a wait that ended because the container was concurrently removed is
 * never reported as an unexplained unconfirmed one.
 */
async function collectWaitOutcomes(
  outcomes: Map<string, SandboxWaitResult>,
  handles: SandboxContainerHandle[],
  gone: Set<string>,
  unconfirmed: string[],
  reasons: SandboxWaitFailure[],
): Promise<void> {
  for (const handle of handles) {
    const result = outcomes.get(handle.id);
    if (result?.kind === "removed") { gone.add(handle.id); continue; }
    if (result?.kind === "exited") continue;
    unconfirmed.push(handle.id);
    reasons.push({
      id: handle.id,
      error: result === undefined
        ? "wait ended without an outcome"
        : result.kind === "timeout" ? `exit not confirmed within ${result.ms}ms` : result.error,
    });
  }
}

/**
 * Tears down a handle the registry refused (teardown already finished). Fire and
 * forget, deferred to a microtask so a handle whose `stop` hook re-enters `add`
 * cannot recurse synchronously; the caller gets an error and will not track the
 * container, and the worker is about to exit, so this is the last chance to
 * avoid orphaning it.
 */
function sweepRefusedContainer(handle: SandboxContainerHandle): void {
  queueMicrotask(() => {
    void handle.stop("SIGKILL").catch(() => undefined);
    const remove = handle.remove;
    if (typeof remove !== "function") return;
    void outcomeWithin((async () => remove())(), DEFAULT_SANDBOX_REMOVAL_TIMEOUT_MS);
  });
}

/**
 * Best-effort removal of already-stopped containers. Never throws: a failing or
 * over-long removal is recorded so shutdown can report it and still exit, and a
 * handle without a removal hook is skipped. `timeoutMs <= 0` skips removal. A
 * remove that finds the container already gone (another remover won the race)
 * reaches the same end state and counts as removed, not as a failure.
 */
async function removeHandles(
  handles: SandboxContainerHandle[],
  timeoutMs: number,
  markRemoved: (id: string) => void,
  failed: SandboxRemovalFailure[],
): Promise<void> {
  if (timeoutMs <= 0) return;
  await Promise.all(handles.map(async (handle) => {
    const remove = handle.remove;
    if (typeof remove !== "function") return;
    // Wrapped so a synchronous throw in the hook is treated as a rejection.
    const outcome = await outcomeWithin((async () => remove())(), timeoutMs);
    if (outcome.ok || outcome.gone) markRemoved(handle.id);
    else failed.push({ id: handle.id, error: outcome.error });
  }));
}

/** Awaits `promise` for at most `ms`, reporting rejection/timeout instead of throwing. */
async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{ ok: true } | { ok: false; error: string; gone: boolean }> {
  if (ms <= 0) return { ok: false, error: "removal skipped: no removal budget", gone: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ ok: true } as const),
        (error) => ({ ok: false as const, error: messageOf(error), gone: isContainerGoneError(error) }),
      ),
      new Promise<{ ok: false; error: string; gone: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `removal not confirmed within ${ms}ms`, gone: false }), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SandboxWaitResult =
  | { kind: "exited" }
  | { kind: "removed"; error: string }
  | { kind: "timeout"; ms: number }
  | { kind: "failed"; error: string };

/** Bounded wait outcomes for `handles`, keyed by container id (never rejects). */
async function waitForExit(handles: SandboxContainerHandle[], ms: number): Promise<Map<string, SandboxWaitResult>> {
  const outcomes = new Map<string, SandboxWaitResult>();
  await Promise.all(handles.map(async (handle) => {
    outcomes.set(handle.id, await classifyWait(handle, ms));
  }));
  return outcomes;
}

/**
 * Resolves how `handle.wait()` ended within `ms`. The rejection handler is
 * attached immediately, so a wait that fails after the timeout won can never
 * surface as an unhandled rejection.
 */
async function classifyWait(handle: SandboxContainerHandle, ms: number): Promise<SandboxWaitResult> {
  const waiting: Promise<SandboxWaitResult> = (async () => handle.wait())().then(
    () => ({ kind: "exited" } as const),
    (error) => isContainerGoneError(error)
      ? ({ kind: "removed", error: messageOf(error) } as const)
      : ({ kind: "failed", error: messageOf(error) } as const),
  );
  if (ms <= 0) return { kind: "timeout", ms };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waiting,
      new Promise<SandboxWaitResult>((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout", ms }), ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return (error as Error | undefined)?.message ?? String(error);
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
 * teardown is bounded by `timeoutMs` (defaulting to
 * {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}, which covers two full teardown passes plus
 * a margin, so the removal pass is never cut off with containers still on the
 * host). Lock release and the exit always run, even when the sandbox phases
 * exhaust the bound (SIGINT=130, SIGTERM=143).
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
          const removed = result.value.removed?.length ?? 0;
          const removalFailed = result.value.removalFailed?.length ?? 0;
          log(`[shutdown] 沙箱已回收：正常停止 ${result.value.stopped.length} 个，强制终止 ${result.value.forced.length} 个，未确认退出 ${result.value.unconfirmed.length} 个，已移除 ${removed} 个`
            + (removalFailed > 0 ? `，移除失败 ${removalFailed} 个` : ""));
        }
      } catch (error) {
        log(`[shutdown] 回收沙箱失败：${(error as Error).message}`);
      }
      // Lock release and exit must happen even when the sandbox phases exhausted
      // the bound above: a workspace must never stay locked by an exiting worker,
      // and the process must still exit bounded.
      try {
        deps.releaseLocks();
      } catch (error) {
        log(`[shutdown] 释放工作区锁失败：${(error as Error).message}`);
      } finally {
        deps.exit(exitCode);
      }
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
