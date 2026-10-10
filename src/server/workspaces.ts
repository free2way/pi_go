import type {
  ScmAuthMode,
  ScmProvider,
  Workspace,
  WorkspacePermission,
  WorkspacePushResult,
  WorkspaceRemoteStatus,
  WorkspaceScmAttempt,
  WorkspaceScmOverview,
  WorkspaceStatus,
  WorkspaceVerifyResult,
} from "../shared/types.js";
import { newId, type Db } from "./db.js";
import { ScmSettingsStore, scmSettingsStatus } from "./scm-settings.js";

export type WorkerCall = <T>(pathName: string, init?: RequestInit) => Promise<T>;

export const DEFAULT_SCM_WORKER_TIMEOUT_MS = 300_000;

/**
 * SCM push includes remote discovery, fetch, export-policy scanning and push.
 * It must not inherit the control plane's 15-second health-call timeout. Keep
 * the operator value bounded so a typo cannot create an unbounded HTTP request.
 */
export function scmWorkerTimeoutMs(value?: string): number {
  const parsed = Number(value ?? DEFAULT_SCM_WORKER_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_SCM_WORKER_TIMEOUT_MS;
  return Math.min(900_000, Math.max(30_000, Math.floor(parsed)));
}

/**
 * B4: extra context for access decisions. `isAdmin` lets an admin act on a
 * workspace they do not own (matching the reopen/cleanup `scope=all` rules);
 * `allowRead` lets the run-start preflight refresh metadata on behalf of a
 * read-granted user without granting the general `/refresh` mutation.
 */
export type WorkspaceAccessOptions = { isAdmin?: boolean; allowRead?: boolean };

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function workspaceWorkerFailure(error: unknown, fallbackCode: string, fallbackStatus: number): WorkspaceError {
  const typed = error as Error & { code?: string; status?: number };
  if (typed.name === "TimeoutError" || /aborted due to timeout/i.test(typed.message ?? "")) {
    return new WorkspaceError(
      "SCM_OPERATION_TIMEOUT",
      "Repository synchronization exceeded the configured server timeout; retry after checking Git remote connectivity",
      504,
    );
  }
  return new WorkspaceError(typed.code ?? fallbackCode, typed.message, typed.status ?? fallbackStatus);
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
  git_dirty_files_json: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toWorkspace(row: WorkspaceRow, permission: WorkspacePermission = "write"): Workspace {
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
      ? { branch: row.git_branch, head: row.git_head, dirty: Boolean(row.git_dirty), dirtyFiles: JSON.parse(row.git_dirty_files_json || "[]") as string[] }
      : null,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permission,
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
    private readonly scmSettings?: ScmSettingsStore,
  ) {}

  async list(ownerKeys: string[]): Promise<Workspace[]> {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map((_, index) => "$" + (index + 1)).join(", ");
    // AUD-02: owned workspaces plus explicitly granted ones (shared access).
    const rows = (await this.db.query(
      `SELECT * FROM workspaces
       WHERE (owner_id IN (${placeholders})
              OR id IN (SELECT workspace_id FROM workspace_grants WHERE user_id IN (${placeholders})))
         AND status != 'unregistered'
       ORDER BY updated_at DESC`,
      ownerKeys,
    )).rows as WorkspaceRow[];
    if (rows.length === 0) return [];
    // B4: resolve the caller's permission for each row that is not owned.
    const grants = (await this.db.query(
      `SELECT workspace_id, permission FROM workspace_grants WHERE user_id IN (${placeholders})`,
      ownerKeys,
    )).rows as Array<{ workspace_id: string; permission: string }>;
    const byWorkspace = new Map<string, WorkspacePermission>();
    for (const grant of grants) {
      if (grant.permission === "write" || !byWorkspace.has(grant.workspace_id)) {
        byWorkspace.set(grant.workspace_id, grant.permission === "write" ? "write" : "read");
      }
    }
    const owners = new Set(ownerKeys);
    return rows.map((row) => toWorkspace(row, owners.has(row.owner_id) ? "write" : (byWorkspace.get(row.id) ?? "read")));
  }

  async get(ownerKeys: string[], id: string, options: WorkspaceAccessOptions = {}): Promise<Workspace> {
    const access = await this.resolveAccess(ownerKeys, id, options.isAdmin ?? false);
    if (!access) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return toWorkspace(access.row, access.permission);
  }

  async register(ownerId: string, relativePath: string, options: { isAdmin?: boolean } = {}): Promise<Workspace> {
    const result = await this.verifyOnWorker(relativePath);
    return this.persist(ownerId, result, null, options);
  }

  /**
   * AUD-02 / AT-WS-011: a physical repository belongs to exactly one owner. A
   * second user either already owns it, holds an explicit grant, or is rejected.
   */
  private async resolvePathOwnership(tx: Db, ownerId: string, canonicalPath: string, isAdmin: boolean, currentId?: string):
  Promise<{ sharedWorkspaceId?: string; permission?: WorkspacePermission }> {
    if (!canonicalPath) return {};
    const existing = (await tx.query("SELECT id, owner_id FROM workspaces WHERE canonical_path = $1", [canonicalPath])).rows[0] as { id: string; owner_id: string } | undefined;
    if (!existing || existing.id === currentId) return {};
    if (existing.owner_id === ownerId || isAdmin) return { sharedWorkspaceId: existing.id, permission: "write" };
    // B4: a shared registration echoes the grant's actual permission, so a
    // read-only member cannot be told they may mutate the owner's workspace.
    const grant = (await tx.query("SELECT permission FROM workspace_grants WHERE workspace_id = $1 AND user_id = $2", [existing.id, ownerId])).rows[0] as { permission: string } | undefined;
    if (grant) return { sharedWorkspaceId: existing.id, permission: grant.permission === "write" ? "write" : "read" };
    throw new WorkspaceError(
      "WORKSPACE_PATH_TAKEN",
      "该物理仓库已归属于其他用户；如需共享，请联系管理员在 workspace_grants 中授权",
      409,
    );
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

  /**
   * Creates a new workspace directory on the worker host (under its projects
   * root) and registers it for the caller. The worker validates the name with
   * the same rules as `isValidWorkspaceName` before touching the filesystem.
   */
  async create(ownerId: string, name: string): Promise<Workspace> {
    if (!isValidWorkspaceName(name)) {
      throw new WorkspaceError("WORKSPACE_INVALID", "Workspace name may only contain letters, digits, dot, dash and underscore", 422);
    }
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/create", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!result.ok) throw this.verifyError(result);
    return this.persist(ownerId, result, null);
  }

  async refresh(ownerKeys: string[], id: string, options: WorkspaceAccessOptions = {}): Promise<Workspace> {
    const access = await this.requirePermission(ownerKeys, id, options);
    const row = access.row;
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
      SET status = 'active', canonical_path = $1, git_branch = $2, git_head = $3, git_dirty = $4, git_dirty_files_json = $5, last_checked_at = $6, updated_at = $7
      WHERE id = $8
    `, [result.canonicalPath ?? row.canonical_path, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, JSON.stringify(result.dirtyFiles ?? []), now, now, row.id]);
    return toWorkspace((await this.db.query("SELECT * FROM workspaces WHERE id = $1", [row.id])).rows[0] as WorkspaceRow, access.permission);
  }

  async patch(ownerKeys: string[], id: string, patch: { defaultChecks?: string[]; defaultBranch?: string }, options: WorkspaceAccessOptions = {}): Promise<Workspace> {
    const access = await this.requirePermission(ownerKeys, id, options);
    const row = access.row;
    const now = new Date().toISOString();
    if (patch.defaultChecks !== undefined) {
      await this.db.query("UPDATE workspaces SET default_checks_json = $1 WHERE id = $2", [JSON.stringify(patch.defaultChecks), row.id]);
    }
    if (patch.defaultBranch !== undefined) {
      await this.db.query("UPDATE workspaces SET default_branch = $1 WHERE id = $2", [patch.defaultBranch, row.id]);
    }
    await this.db.query("UPDATE workspaces SET updated_at = $1 WHERE id = $2", [now, row.id]);
    return toWorkspace((await this.db.query("SELECT * FROM workspaces WHERE id = $1", [row.id])).rows[0] as WorkspaceRow, access.permission);
  }

  async unregister(ownerKeys: string[], id: string, options: WorkspaceAccessOptions = {}): Promise<void> {
    const access = await this.requirePermission(ownerKeys, id, options);
    await this.db.query("UPDATE workspaces SET status = 'unregistered', updated_at = $1 WHERE id = $2", [new Date().toISOString(), access.row.id]);
  }

  async scmOverview(ownerKeys: string[], id: string, options: WorkspaceAccessOptions = {}): Promise<WorkspaceScmOverview> {
    const access = await this.resolveAccess(ownerKeys, id, options.isAdmin ?? false);
    if (!access) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const saved = this.scmSettings?.get(id);
    const inferredProvider = inferScmProvider(access.row.repository_url);
    return {
      settings: saved ? scmSettingsStatus(saved) : {
        ...scmSettingsStatus(),
        provider: inferredProvider,
        authMode: inferScmAuthMode(access.row.repository_url),
      },
      remote: null,
      attempts: await this.listScmAttempts(id),
    };
  }

  async saveScmSettings(ownerKeys: string[], id: string, input: {
    provider: ScmProvider;
    authMode: ScmAuthMode;
    username?: string | null;
    token?: string | null;
  }, options: WorkspaceAccessOptions = {}) {
    await this.requirePermission(ownerKeys, id, options);
    if (!this.scmSettings) throw new WorkspaceError("SCM_SETTINGS_UNAVAILABLE", "SCM settings store is unavailable", 503);
    try {
      return scmSettingsStatus(await this.scmSettings.set(id, input));
    } catch (error) {
      throw new WorkspaceError("SCM_SETTINGS_INVALID", (error as Error).message, 422);
    }
  }

  async deleteScmSettings(ownerKeys: string[], id: string, options: WorkspaceAccessOptions = {}) {
    await this.requirePermission(ownerKeys, id, options);
    await this.scmSettings?.delete(id);
    const repositoryUrl = (await this.findRow(ownerKeys, id, options.isAdmin ?? false))?.repository_url ?? null;
    return {
      ...scmSettingsStatus(),
      provider: inferScmProvider(repositoryUrl),
      authMode: inferScmAuthMode(repositoryUrl),
    };
  }

  async remoteStatus(ownerKeys: string[], id: string, options: WorkspaceAccessOptions & { requiredCommit?: string } = {}): Promise<WorkspaceRemoteStatus> {
    const access = await this.resolveAccess(ownerKeys, id, options.isAdmin ?? false);
    if (!access) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    const branch = access.row.default_branch ?? access.row.git_branch;
    if (!branch) throw new WorkspaceError("SCM_BRANCH_MISSING", "Workspace default branch is not configured", 409);
    const credential = this.scmSettings?.get(id);
    try {
      return await this.callWorker<WorkspaceRemoteStatus>("/workspaces/remote-status", {
        method: "POST",
        body: JSON.stringify({
          relativePath: access.row.root_path,
          branch,
          ...(options.requiredCommit ? { requiredCommit: options.requiredCommit } : {}),
          ...(credential ? { credential } : {}),
        }),
      });
    } catch (error) {
      throw workspaceWorkerFailure(error, "SCM_REMOTE_FAILED", 503);
    }
  }

  async push(ownerKeys: string[], id: string, actorId: string, options: WorkspaceAccessOptions = {}): Promise<WorkspacePushResult> {
    const access = await this.requirePermission(ownerKeys, id, options);
    const branch = access.row.default_branch ?? access.row.git_branch;
    if (!branch) throw new WorkspaceError("SCM_BRANCH_MISSING", "Workspace default branch is not configured", 409);
    const credential = this.scmSettings?.get(id);
    const createdAt = new Date().toISOString();
    try {
      const result = await this.callWorker<WorkspacePushResult>("/workspaces/push", {
        method: "POST",
        body: JSON.stringify({ relativePath: access.row.root_path, branch, ...(credential ? { credential } : {}) }),
      });
      await this.recordScmAttempt({
        id: newId("scm"), workspaceId: id, actorId, operation: "push",
        status: result.pushed ? "succeeded" : "noop",
        localHead: result.after.localHead, remoteHead: result.after.remoteHead,
        detail: result.pushed ? `Pushed ${result.after.localHead.slice(0, 12)} to origin/${branch}` : "Local and remote branches were already synchronized",
        createdAt,
      });
      return result;
    } catch (error) {
      const failure = workspaceWorkerFailure(error, "SCM_PUSH_FAILED", 503);
      await this.recordScmAttempt({
        id: newId("scm"), workspaceId: id, actorId, operation: "push", status: "failed",
        localHead: access.row.git_head, remoteHead: null, detail: failure.message.slice(0, 800), createdAt,
      }).catch(() => undefined);
      throw failure;
    }
  }

  private async listScmAttempts(workspaceId: string): Promise<WorkspaceScmAttempt[]> {
    const rows = (await this.db.query(
      "SELECT * FROM workspace_scm_sync_attempts WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 10",
      [workspaceId],
    )).rows as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), operation: "push", status: String(row.status) as WorkspaceScmAttempt["status"],
      actorId: String(row.actor_id), localHead: row.local_head ? String(row.local_head) : null,
      remoteHead: row.remote_head ? String(row.remote_head) : null, detail: row.detail ? String(row.detail) : null,
      createdAt: String(row.created_at),
    }));
  }

  private async recordScmAttempt(input: {
    id: string; workspaceId: string; actorId: string; operation: "push"; status: WorkspaceScmAttempt["status"];
    localHead: string | null; remoteHead: string | null; detail: string | null; createdAt: string;
  }) {
    await this.db.query(
      `INSERT INTO workspace_scm_sync_attempts (id, workspace_id, actor_id, operation, status, local_head, remote_head, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.id, input.workspaceId, input.actorId, input.operation, input.status, input.localHead, input.remoteHead, input.detail, input.createdAt],
    );
  }

  private async verifyOnWorker(relativePath: string): Promise<WorkspaceVerifyResult> {
    const result = await this.callWorker<WorkspaceVerifyResult>("/workspaces/verify", {
      method: "POST",
      body: JSON.stringify({ relativePath }),
    });
    if (!result.ok) throw this.verifyError(result);
    return result;
  }

  private async persist(ownerId: string, result: WorkspaceVerifyResult, repositoryUrl: string | null, options: { isAdmin?: boolean } = {}): Promise<Workspace> {
    const now = new Date().toISOString();
    const name = result.name!;
    return this.db.withTransaction(async (tx) => {
      const existing = (await tx.query("SELECT * FROM workspaces WHERE owner_id = $1 AND name = $2", [ownerId, name])).rows[0] as WorkspaceRow | undefined;
      const ownership = await this.resolvePathOwnership(tx, ownerId, result.canonicalPath ?? "", options.isAdmin ?? false, existing?.id);
      if (ownership.sharedWorkspaceId && !existing) {
        // AUD-02: a granted (or admin) caller shares the owner's workspace record
        // instead of creating a second row for the same physical repository.
        return toWorkspace((await tx.query("SELECT * FROM workspaces WHERE id = $1", [ownership.sharedWorkspaceId])).rows[0] as WorkspaceRow, ownership.permission ?? "write");
      }
      if (existing) {
        await tx.query(`
          UPDATE workspaces
          SET root_path = $1, canonical_path = $2, repository_url = COALESCE($3, repository_url), status = 'active',
              default_branch = COALESCE(default_branch, $4), git_branch = $5, git_head = $6, git_dirty = $7, git_dirty_files_json = $8, last_checked_at = $9, updated_at = $10
          WHERE id = $11
        `, [
          result.relativePath ?? existing.root_path, result.canonicalPath ?? existing.canonical_path, repositoryUrl,
          result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, JSON.stringify(result.dirtyFiles ?? []), now, now, existing.id,
        ]);
        return toWorkspace((await tx.query("SELECT * FROM workspaces WHERE id = $1", [existing.id])).rows[0] as WorkspaceRow);
      }
      const id = newId("ws");
      await tx.query(`
        INSERT INTO workspaces (id, owner_id, node_id, name, type, root_path, canonical_path, repository_url, default_branch, default_checks_json, status, git_branch, git_head, git_dirty, git_dirty_files_json, last_checked_at, created_at, updated_at)
        VALUES ($1, $2, 'server', $3, 'server', $4, $5, $6, $7, '[]', 'active', $8, $9, $10, $11, $12, $13, $14)
      `, [
        id, ownerId, name, result.relativePath ?? name, result.canonicalPath ?? "", repositoryUrl,
        result.branch ?? null, result.branch ?? null, result.head ?? null, result.dirty ? 1 : 0, JSON.stringify(result.dirtyFiles ?? []), now, now, now,
      ]);
      return toWorkspace((await tx.query("SELECT * FROM workspaces WHERE id = $1", [id])).rows[0] as WorkspaceRow);
    });
  }

  private verifyError(result: WorkspaceVerifyResult) {
    const code = result.code || "WORKSPACE_INVALID";
    const status = code === "WORKSPACE_EXISTS" ? 409 : code === "WORKSPACE_NOT_FOUND" ? 404 : 422;
    return new WorkspaceError(code, result.error || "Workspace validation failed", status);
  }

  private async findRow(ownerKeys: string[], id: string, isAdmin = false): Promise<WorkspaceRow | undefined> {
    // B4: an admin may read/mutate any workspace, even without ownership/grant.
    if (isAdmin) return (await this.db.query("SELECT * FROM workspaces WHERE id = $1", [id])).rows[0] as WorkspaceRow | undefined;
    if (ownerKeys.length === 0) return undefined;
    const placeholders = ownerKeys.map((_, index) => "$" + (index + 2)).join(", ");
    return (await this.db.query(
      `SELECT * FROM workspaces
       WHERE id = $1
         AND (owner_id IN (${placeholders})
              OR id IN (SELECT workspace_id FROM workspace_grants WHERE user_id IN (${placeholders})))`,
      [id, ...ownerKeys],
    )).rows[0] as WorkspaceRow | undefined;
  }

  /** B4: the caller's permission on a workspace, if they may see it at all. */
  private async resolveAccess(
    ownerKeys: string[],
    id: string,
    isAdmin: boolean,
  ): Promise<{ row: WorkspaceRow; permission: WorkspacePermission } | undefined> {
    const row = await this.findRow(ownerKeys, id, isAdmin);
    if (!row) return undefined;
    if (isAdmin || ownerKeys.includes(row.owner_id)) return { row, permission: "write" };
    const placeholders = ownerKeys.map((_, index) => "$" + (index + 2)).join(", ");
    const grants = ownerKeys.length === 0
      ? []
      : (await this.db.query(
        `SELECT permission FROM workspace_grants WHERE workspace_id = $1 AND user_id IN (${placeholders})`,
        [id, ...ownerKeys],
      )).rows as Array<{ permission: string }>;
    return { row, permission: grants.some((grant) => grant.permission === "write") ? "write" : "read" };
  }

  /**
   * B4: resolves access and enforces the write requirement for mutating routes.
   * A read-granted caller (or a missing workspace) gets a typed error; the run
   * preflight passes `allowRead` so a read grant may still start a run.
   */
  private async requirePermission(
    ownerKeys: string[],
    id: string,
    options: WorkspaceAccessOptions,
  ): Promise<{ row: WorkspaceRow; permission: WorkspacePermission }> {
    const access = await this.resolveAccess(ownerKeys, id, options.isAdmin ?? false);
    if (!access) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (!options.allowRead && access.permission !== "write") {
      throw new WorkspaceError("WORKSPACE_READ_ONLY", "只读授权：仅工作区所有者、管理员或拥有写权限的成员可以修改该工作区", 403);
    }
    return access;
  }
}

function inferScmProvider(repositoryUrl: string | null): ScmProvider {
  const lower = (repositoryUrl ?? "").toLowerCase();
  if (lower.includes("github.com")) return "github";
  if (lower.includes("gitlab")) return "gitlab";
  return "generic";
}

function inferScmAuthMode(repositoryUrl: string | null): ScmAuthMode {
  try {
    const protocol = new URL(repositoryUrl ?? "").protocol;
    return protocol === "http:" || protocol === "https:" ? "https_token" : "server_ssh";
  } catch {
    return "server_ssh";
  }
}
