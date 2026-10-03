import { realpath } from "node:fs/promises";
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
