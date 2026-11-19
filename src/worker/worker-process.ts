import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { throwIfCancelled, type CommandResult } from "./checks.js";
import { runHardenedGit } from "./git-hardening.js";
import { awaitSandboxExit, buildContainerSpec, hostPathFor, withSandboxStateDirectory, SANDBOX_KILLED_EXIT_CODE } from "./sandbox.js";
import { captureSnapshotHash } from "./snapshot-hash.js";
import {
  sandboxExtraEnv, imageForSandbox, sandboxUser, workspaceRoot, hostWorkspaceRoot, sandboxExtraBinds,
  docker, sandboxContainers, maxOutput,
} from "./worker-runtime.js";

/** Environment handed to a sandboxed process: nothing but runtime basics and the role credential. */
export function sandboxEnvironment(extra: Record<string, string>) {
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
export async function repositoryForWorktree(worktree: string): Promise<string | undefined> {
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
export async function snapshotHash(worktree: string, signal?: AbortSignal) {
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
  /** Optional Pi state location; must be outside `worktree`. */
  statePath?: string;
  ephemeralState?: boolean;
}

/** Runs one invocation inside its own container and always cleans it up. */
export async function runInSandbox(input: SandboxRunInput): Promise<CommandResult> {
  throwIfCancelled(input.signal);
  return withSandboxStateDirectory({
    worktree: input.worktree,
    statePath: input.statePath,
    ephemeral: input.ephemeralState,
  }, (stateDirectory) => runInSandboxWithState(input, stateDirectory));
}

async function runInSandboxWithState(input: SandboxRunInput, runStateDir: string): Promise<CommandResult> {
  throwIfCancelled(input.signal);
  const spec = buildContainerSpec({
    image: imageForSandbox,
    user: sandboxUser,
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
  // P1: track the container so SIGTERM/SIGINT stops it before the worker exits;
  // otherwise a sandbox can keep writing into the run worktree after exit.
  const forgetContainer = sandboxContainers.add({
    id: containerId,
    stop: (signal) => docker.killContainer(containerId, signal),
    wait: () => docker.waitContainer(containerId).then(() => undefined),
    // AUD-08: shutdown removes the container it stopped/killed too, so an exited
    // sandbox never lingers on the host when this function's `finally` (which
    // normally removes it) does not get to run before the shutdown exit.
    remove: () => docker.removeContainer(containerId),
  });
  let stdout = "";
  let stderr = "";
  // A container timeout of 0/absent means no limit; only a positive value kills it.
  const timer = input.timeoutMs > 0 ? setTimeout(() => { void docker.killContainer(containerId).catch(() => undefined); }, input.timeoutMs) : undefined;
  const onAbort = () => { void docker.killContainer(containerId).catch(() => undefined); };
  try {
    input.signal.addEventListener("abort", onAbort, { once: true });
    // Cancellation can arrive while state or Docker creation is in flight.
    // A listener registered after abort never fires; never start that command.
    throwIfCancelled(input.signal);
    await docker.startContainer(containerId);
    // An early kill may race start and fail because the container was not yet
    // running. Force removal in finally still stops the newly started process.
    throwIfCancelled(input.signal);
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
    const exit = await awaitSandboxExit(() => docker.waitContainer(containerId));
    await logs;
    // AUD follow-up: a wait that ended because the container was concurrently
    // force-removed (shutdown teardown) is a kill, not an error — report SIGKILL's
    // exit code so the run fails deterministically instead of surfacing a 404.
    if (exit.outcome === "failed") throw new Error(`容器等待失败：${exit.error}`);
    const code = exit.outcome === "exited"
      ? (exit.value as { StatusCode: number }).StatusCode
      : SANDBOX_KILLED_EXIT_CODE;
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    await docker.removeContainer(containerId).catch(() => undefined);
    forgetContainer();
    // The outer state owner retains agent sessions but removes disposable check state.
  }
}

export function command(commandName: string, args: string[], options: {
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
export async function git(cwd: string, args: string[], signal?: AbortSignal, options: { maxOutput?: number; env?: Record<string, string> } = {}) {
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
