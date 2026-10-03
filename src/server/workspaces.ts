import type { Workspace, WorkspaceStatus, WorkspaceVerifyResult } from "../shared/types.js";
import { newId, type Database } from "./db.js";

export type WorkerCall = <T>(pathName: string, init?: RequestInit) => Promise<T>;

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type WorkspaceRow = {
  id: string;
  owner_id: string;
  node_id: string;
  name: string;
  type: string;
  root_path: string;
  canonical_path: string;
  repository_url: string | null;
  default_branch: string | null;
  default_checks_json: string;
  status: string;
  git_branch: string | null;
  git_head: string | null;
  git_dirty: number | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    ownerId: row.owner_id,
    nodeId: row.node_id,
    name: row.name,
    type: "server",
    rootPath: row.root_path,
    canonicalPath: row.canonical_path,
    repositoryUrl: row.repository_url,
    defaultBranch: row.default_branch,
    defaultChecks: JSON.parse(row.default_checks_json) as string[],
    status: row.status as WorkspaceStatus,
    git: row.git_head
      ? { branch: row.git_branch, head: row.git_head, dirty: Boolean(row.git_dirty) }
      : null,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function redactGitUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//***@");
  }
}

export function isValidWorkspaceName(value: string) {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value) && value !== "." && value !== "..";
}

export class WorkspaceService {
  constructor(
    private readonly db: Database,
    private readonly callWorker: WorkerCall,
  ) {}

  list(ownerKeys: string[]): Workspace[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM workspaces WHERE owner_id IN (${placeholders}) AND status != 'unregistered' ORDER BY updated_at DESC`)
      .all(...ownerKeys) as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  get(ownerKeys: string[], id: string): Workspace {
    const row = this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return toWorkspace(row);
  }

  async register(ownerId: string, relativePath: string): Promise<Workspace> {
    const result = await this.verifyOnWorker(relativePath);
    return this.persist(ownerId, result, null);
  }

  async clone(ownerId: string, url: string, name: string): Promise<Workspace> {
    if (!isValidWorkspaceName(name)) {
      throw new WorkspaceError("WORKSPACE_INVALID", "Workspace name may only contain letters, digits, dot, dash and underscore", 422);
    }
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/clone", {
      method: "POST",
      body: JSON.stringify({ url, name }),
    });
    return this.persist(ownerId, result, redactGitUrl(url));
  }

  async refresh(ownerKeys: string[], id: string): Promise<Workspace> {
    const row = this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/verify", {
      method: "POST",
      body: JSON.stringify({ relativePath: row.root_path }),
    });
    const now = new Date().toISOString();
    if (!result.ok) {
      this.db.prepare("UPDATE workspaces SET status = 'invalid', last_checked_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, row.id);
      throw this.verifyError(result);
    }
    this.db.prepare(`
      UPDATE workspaces
      SET status = 'active', canonical_path = ?, git_branch = ?, git_head = ?, git_dirty = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result.canonicalPath ?? row.canonical_path, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, row.id);
    return toWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(row.id) as WorkspaceRow);
  }

  patch(ownerKeys: string[], id: string, patch: { defaultChecks?: string[]; defaultBranch?: string }): Workspace {
    const row = this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const now = new Date().toISOString();
    if (patch.defaultChecks !== undefined) {
      this.db.prepare("UPDATE workspaces SET default_checks_json = ? WHERE id = ?").run(JSON.stringify(patch.defaultChecks), row.id);
    }
    if (patch.defaultBranch !== undefined) {
      this.db.prepare("UPDATE workspaces SET default_branch = ? WHERE id = ?").run(patch.defaultBranch, row.id);
    }
    this.db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, row.id);
    return toWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(row.id) as WorkspaceRow);
  }

  unregister(ownerKeys: string[], id: string) {
    const row = this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workspaces SET status = 'unregistered', updated_at = ? WHERE id = ?").run(now, row.id);
  }

  private async verifyOnWorker(relativePath: string): Promise<WorkspaceVerifyResult> {
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/verify", {
      method: "POST",
      body: JSON.stringify({ relativePath }),
    });
    if (!result.ok) throw this.verifyError(result);
    return result;
  }

  private persist(ownerId: string, result: WorkspaceVerifyResult, repositoryUrl: string | null): Workspace {
    const now = new Date().toISOString();
    const name = result.name!;
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE owner_id = ? AND name = ?").get(ownerId, name) as WorkspaceRow | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE workspaces
        SET root_path = ?, canonical_path = ?, repository_url = COALESCE(?, repository_url), status = 'active',
            default_branch = COALESCE(default_branch, ?), git_branch = ?, git_head = ?, git_dirty = ?, last_checked_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        result.relativePath ?? existing.root_path, result.canonicalPath ?? existing.canonical_path, repositoryUrl,
        result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, existing.id,
      );
      return toWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(existing.id) as WorkspaceRow);
    }
    const id = newId("ws");
    this.db.prepare(`
      INSERT INTO workspaces (id, owner_id, node_id, name, type, root_path, canonical_path, repository_url, default_branch, default_checks_json, status, git_branch, git_head, git_dirty, last_checked_at, created_at, updated_at)
      VALUES (?, ?, 'server', ?, 'server', ?, ?, ?, ?, '[]', 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      id, ownerId, name, result.relativePath ?? name, result.canonicalPath ?? "", repositoryUrl,
      result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, now,
    );
    return toWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow);
  }

  private verifyError(result: WorkspaceVerifyResult) {
    const code = result.code || "WORKSPACE_INVALID";
    const status = code === "WORKSPACE_EXISTS" ? 409 : code === "WORKSPACE_OUTSIDE_ROOT" ? 422 : 422;
    return new WorkspaceError(code, result.error || "Workspace validation failed", status);
  }

  private findRow(ownerKeys: string[], id: string): WorkspaceRow | undefined {
    if (ownerKeys.length === 0) return undefined;
    const placeholders = ownerKeys.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM workspaces WHERE id = ? AND owner_id IN (${placeholders})`)
      .get(id, ...ownerKeys) as WorkspaceRow | undefined;
  }
}
