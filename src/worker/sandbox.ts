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

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
}

/** Sandbox mode is explicit; `auto` enables it only when the socket answers. */
export async function resolveSandboxMode(
  mode: string,
  ping: () => Promise<boolean>,
): Promise<{ mode: "container" | "process"; reason?: string }> {
  if (mode === "process") return { mode: "process", reason: "disabled by PI_SANDBOX_MODE=process" };
  if (mode === "container") {
    // Requested explicitly: keep it even when the socket is unreachable so the
    // failure is loud instead of silently degrading isolation.
    try {
      await ping();
      return { mode: "container" };
    } catch (error) {
      return { mode: "container", reason: `docker socket not usable: ${(error as Error).message}` };
    }
  }
  try {
    await ping();
    return { mode: "container" };
  } catch (error) {
    return { mode: "process", reason: `docker socket unavailable: ${(error as Error).message}` };
  }
}
