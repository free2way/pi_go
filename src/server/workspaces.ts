import type { Workspace, WorkspaceStatus, WorkspaceVerifyResult } from "../shared/types.js";
import { newId, type Db } from "./db.js";

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
    private readonly db: Db,
    private readonly callWorker: WorkerCall,
  ) {}

  async list(ownerKeys: string[]): Promise<Workspace[]> {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map((_, index) => `$${index + 1}`).join(", ");
    const rows = (await this.db.query(
      `SELECT * FROM workspaces WHERE owner_id IN (${placeholders}) AND status != 'unregistered' ORDER BY updated_at DESC`,
      ownerKeys,
    )).rows as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  async get(ownerKeys: string[], id: string): Promise<Workspace> {
    const row = await this.findRow(ownerKeys, id);
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
    const row = await this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/verify", {
      method: "POST",
      body: JSON.stringify({ relativePath: row.root_path }),
    });
    const now = new Date().toISOString();
    if (!result.ok) {
      await this.db.query("UPDATE workspaces SET status = 'invalid', last_checked_at = $1, updated_at = $2 WHERE id = $3", [now, now, row.id]);
      throw this.verifyError(result);
    }
    await this.db.query(`
      UPDATE workspaces
      SET status = 'active', canonical_path = $1, git_branch = $2, git_head = $3, git_dirty = $4, last_checked_at = $5, updated_at = $6
      WHERE id = $7
    `, [result.canonicalPath ?? row.canonical_path, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, row.id]);
    return toWorkspace((await this.db.query("SELECT * FROM workspaces WHERE id = $1", [row.id])).rows[0] as WorkspaceRow);
  }

  async patch(ownerKeys: string[], id: string, patch: { defaultChecks?: string[]; defaultBranch?: string }): Promise<Workspace> {
    const row = await this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const now = new Date().toISOString();
    if (patch.defaultChecks !== undefined) {
      await this.db.query("UPDATE workspaces SET default_checks_json = $1 WHERE id = $2", [JSON.stringify(patch.defaultChecks), row.id]);
    }
    if (patch.defaultBranch !== undefined) {
      await this.db.query("UPDATE workspaces SET default_branch = $1 WHERE id = $2", [patch.defaultBranch, row.id]);
    }
    await this.db.query("UPDATE workspaces SET updated_at = $1 WHERE id = $2", [now, row.id]);
    return toWorkspace((await this.db.query("SELECT * FROM workspaces WHERE id = $1", [row.id])).rows[0] as WorkspaceRow);
  }

  async unregister(ownerKeys: string[], id: string): Promise<void> {
    const row = await this.findRow(ownerKeys, id);
    if (!row) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    await this.db.query("UPDATE workspaces SET status = 'unregistered', updated_at = $1 WHERE id = $2", [new Date().toISOString(), row.id]);
  }

  private async verifyOnWorker(relativePath: string): Promise<WorkspaceVerifyResult> {
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/verify", {
      method: "POST",
      body: JSON.stringify({ relativePath }),
    });
    if (!result.ok) throw this.verifyError(result);
    return result;
  }

  private async persist(ownerId: string, result: WorkspaceVerifyResult, repositoryUrl: string | null): Promise<Workspace> {
    const now = new Date().toISOString();
    const name = result.name!;
    return this.db.withTransaction(async (tx) => {
      const existing = (await tx.query("SELECT * FROM workspaces WHERE owner_id = $1 AND name = $2", [ownerId, name])).rows[0] as WorkspaceRow | undefined;
      if (existing) {
        await tx.query(`
          UPDATE workspaces
          SET root_path = $1, canonical_path = $2, repository_url = COALESCE($3, repository_url), status = 'active',
              default_branch = COALESCE(default_branch, $4), git_branch = $5, git_head = $6, git_dirty = $7, last_checked_at = $8, updated_at = $9
          WHERE id = $10
        `, [
          result.relativePath ?? existing.root_path, result.canonicalPath ?? existing.canonical_path, repositoryUrl,
          result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, existing.id,
        ]);
        return toWorkspace((await tx.query("SELECT * FROM workspaces WHERE id = $1", [existing.id])).rows[0] as WorkspaceRow);
      }
      const id = newId("ws");
      await tx.query(`
        INSERT INTO workspaces (id, owner_id, node_id, name, type, root_path, canonical_path, repository_url, default_branch, default_checks_json, status, git_branch, git_head, git_dirty, last_checked_at, created_at, updated_at)
        VALUES ($1, $2, 'server', $3, 'server', $4, $5, $6, $7, '[]', 'active', $8, $9, $10, $11, $12, $13)
      `, [
        id, ownerId, name, result.relativePath ?? name, result.canonicalPath ?? "", repositoryUrl,
        result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, now, now, now,
      ]);
      return toWorkspace((await tx.query("SELECT * FROM workspaces WHERE id = $1", [id])).rows[0] as WorkspaceRow);
    });
  }

  private verifyError(result: WorkspaceVerifyResult) {
    const code = result.code || "WORKSPACE_INVALID";
    const status = code === "WORKSPACE_EXISTS" ? 409 : code === "WORKSPACE_NOT_FOUND" ? 404 : 422;
    return new WorkspaceError(code, result.error || "Workspace validation failed", status);
  }

  private async findRow(ownerKeys: string[], id: string): Promise<WorkspaceRow | undefined> {
    if (ownerKeys.length === 0) return undefined;
    const placeholders = ownerKeys.map((_, index) => `$${index + 2}`).join(", ");
    return (await this.db.query(
      `SELECT * FROM workspaces WHERE id = $1 AND owner_id IN (${placeholders})`,
      [id, ...ownerKeys],
    )).rows[0] as WorkspaceRow | undefined;
  }
}
