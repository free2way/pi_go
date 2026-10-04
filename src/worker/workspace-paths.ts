import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sanitizeWorkspaceName(value: string): string | undefined {
  const name = value.trim();
  if (!name || name.length > 80 || name === "." || name === "..") return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  return name;
}

export function validateCloneUrl(value: string): string | undefined {
  const url = value.trim();
  if (!url || url.length > 500) return "Git URL is empty or too long";
  if (/^https?:\/\/[^\s]+$/i.test(url)) return undefined;
  if (/^ssh:\/\/[^\s]+$/i.test(url)) return undefined;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(url)) return undefined;
  return "Only https://, ssh:// or user@host:path Git URLs are allowed";
}

export function sanitizeRelativePath(value: string): string | undefined {
  const relative = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!relative || relative.length > 240) return undefined;
  if (path.isAbsolute(relative)) return undefined;
  if (!/^[A-Za-z0-9._/-]+$/.test(relative)) return undefined;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return relative;
}

/**
 * Resolves a workspace path strictly inside the allowed root, rejecting
 * traversal, absolute paths and symlink escapes. The candidate must exist.
 */
export async function resolveInsideRoot(allowedRoot: string, relative: string): Promise<string> {
  const root = await realpath(allowedRoot);
  const candidate = await realpath(path.join(root, relative)).catch(() => {
    throw new WorkspacePathError("WORKSPACE_INVALID", "Workspace path does not exist");
  });
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new WorkspacePathError("WORKSPACE_OUTSIDE_ROOT", "Workspace resolves outside the allowed root");
  }
  return candidate;
}

export interface PreparedWorkspaceDirectory {
  relativePath: string;
  canonicalPath: string;
  /** True when this call created the directory (it did not exist before). */
  created: boolean;
}

/**
 * Creates `<root>/<name>` on the Worker host, idempotently.
 *
 * The workspace root itself is ensured (the Docker volume may start empty) and
 * a missing/unwritable root surfaces as `WORKSPACE_INVALID` instead of a
 * half-applied create. An existing entry is only reused when it is a plain
 * directory that is empty apart from `.git` (i.e. re-running create on an
 * already-initialized empty workspace); anything else is `WORKSPACE_EXISTS`, so
 * an unrelated directory with the same name is never claimed or overwritten.
 */
export async function prepareWorkspaceDirectory(root: string, name: string): Promise<PreparedWorkspaceDirectory> {
  const clean = sanitizeWorkspaceName(name);
  if (!clean) throw new WorkspacePathError("WORKSPACE_INVALID", "Invalid workspace name");

  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw new WorkspacePathError("WORKSPACE_INVALID", `Workspace root is unavailable: ${(error as Error).message}`);
  }
  const resolvedRoot = await realpath(root).catch(() => undefined);
  if (!resolvedRoot) throw new WorkspacePathError("WORKSPACE_INVALID", "Workspace root is unavailable");

  const target = path.join(resolvedRoot, clean);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new WorkspacePathError("WORKSPACE_OUTSIDE_ROOT", "Workspace resolves outside the allowed root");
  }

  const existing = await lstat(target).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new WorkspacePathError("WORKSPACE_EXISTS", `Workspace path already exists and is not a plain directory: ${clean}`);
    }
    const entries = await readdir(target);
    if (entries.some((entry) => entry !== ".git")) {
      throw new WorkspacePathError("WORKSPACE_EXISTS", `Workspace directory already exists with different content: ${clean}`);
    }
    return { relativePath: clean, canonicalPath: await realpath(target), created: false };
  }

  await mkdir(target);
  return { relativePath: clean, canonicalPath: await realpath(target), created: true };
}
