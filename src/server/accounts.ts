/**
 * 账户管理 (account management) — admin-only service + pure helpers.
 *
 * The instance owner hit the trap where their account was still `role: "user"`
 * while an admin-only action (merge) refused with 403. This module makes the
 * role/status of every account inspectable and manageable, with hard guardrails
 * so an administrator cannot lock everyone out.
 *
 * Design notes:
 * - The store is the existing `users` / `user_identities` / `workspaces` /
 *   `workspace_grants` / `runs` schema. Only `user_audit` is new (migration 10).
 * - Sensitive identity data (issuer/subject) is deliberately never projected.
 * - Guardrails are pure functions (`planAccountChange`) so the HTTP layer and
 *   the tests share exactly one implementation.
 */
import type {
  AccountDetail,
  AccountGrant,
  AccountRole,
  AccountStatus,
  AccountSummary,
  AccountWorkspaceOption,
  WorkspacePermission,
  WorkspaceStatus,
} from "../shared/types.js";
import { newId, type Db } from "./db.js";

export type AccountAuditAction = "account.role_changed" | "account.status_changed";
export type AccountAuditField = "role" | "status";

/** A shaped `user_audit` row (actor + target + before/after). */
export type AccountAuditEvent = {
  id: string;
  actorId: string;
  targetUserId: string;
  action: AccountAuditAction;
  field: AccountAuditField;
  before: string;
  after: string;
  createdAt: string;
};

/** Typed, HTTP-mappable account error. */
export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type AdminGate = { allowed: true } | { allowed: false; status: 403; code: "ADMIN_REQUIRED"; message: string };

/**
 * Admin-only gate for the whole account section. Kept pure so the HTTP layer
 * and the tests share the exact admin-vs-user decision (403 for non-admins).
 */
export function accountAdminGate(isAdmin: boolean): AdminGate {
  return isAdmin
    ? { allowed: true }
    : { allowed: false, status: 403, code: "ADMIN_REQUIRED", message: "仅管理员可以管理账户" };
}

type UserRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  legacy_owner_id: string | null;
  created_at: string;
  updated_at: string;
};

type CountRow = { owner_id: string; count: number };
type LastLoginRow = { user_id: string; last_login_at: string | null };

/** Any unknown stored role collapses to `user`; only `admin` is privileged. */
export function normalizeRole(value: string | null | undefined): AccountRole {
  return value === "admin" ? "admin" : "user";
}

/** Any status other than the explicit `disabled` is treated as usable. */
export function normalizeStatus(value: string | null | undefined): AccountStatus {
  return value === "disabled" ? "disabled" : "active";
}

/**
 * Owner keys for a user. Kept identical to `identity.ownerKeys`: resources
 * created before internal ids existed are keyed by `legacy_owner_id`.
 */
export function accountOwnerKeys(user: { id: string; legacyOwnerId?: string | null }): string[] {
  return user.legacyOwnerId ? [user.id, user.legacyOwnerId] : [user.id];
}

/** Shape one `users` row + derived counters into the list projection. */
export function projectAccount(
  row: { id: string; email: string; role: string; status: string; created_at: string; updated_at: string },
  derived: { lastLoginAt?: string | null; runsOwned?: number; workspacesOwned?: number } = {},
): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: derived.lastLoginAt ?? null,
    runsOwned: derived.runsOwned ?? 0,
    workspacesOwned: derived.workspacesOwned ?? 0,
  };
}

export type AccountChangePlan =
  | { ok: true; roleChanged: boolean; statusChanged: boolean }
  | { ok: false; code: "NO_CHANGES" | "SELF_ROLE_CHANGE" | "LAST_ADMIN"; status: number; message: string };

/**
 * Guardrails for a `PATCH /api/accounts/:id`:
 * - `NO_CHANGES` (400): neither field actually changes anything.
 * - `SELF_ROLE_CHANGE` (409): an administrator may not change their own role,
 *   so a single mistake can never silently drop the last privileged actor.
 * - `LAST_ADMIN` (409): the last active admin can neither be demoted nor
 *   disabled — that would leave nobody able to manage accounts or merge.
 */
export function planAccountChange(input: {
  actorId: string;
  target: { id: string; role: string | null | undefined; status: string | null | undefined };
  activeAdminCount: number;
  patch: { role?: AccountRole; status?: AccountStatus };
}): AccountChangePlan {
  const { actorId, target, activeAdminCount, patch } = input;
  const currentRole = normalizeRole(target.role);
  const currentStatus = normalizeStatus(target.status);
  const roleChanged = patch.role !== undefined && patch.role !== currentRole;
  const statusChanged = patch.status !== undefined && patch.status !== currentStatus;

  if (!roleChanged && !statusChanged) {
    return { ok: false, code: "NO_CHANGES", status: 400, message: "没有需要变更的角色或状态" };
  }
  if (roleChanged && target.id === actorId) {
    return { ok: false, code: "SELF_ROLE_CHANGE", status: 409, message: "不能修改自己的角色：请让另一位管理员操作" };
  }
  const removesActiveAdmin = currentRole === "admin" && currentStatus === "active"
    && ((roleChanged && patch.role === "user") || (statusChanged && patch.status === "disabled"));
  if (removesActiveAdmin && activeAdminCount <= 1) {
    return { ok: false, code: "LAST_ADMIN", status: 409, message: "不能降级或禁用最后一个可用管理员：请先指派另一位管理员" };
  }
  return { ok: true, roleChanged, statusChanged };
}

/** Build a shaped `user_audit` row for one changed field. */
export function buildAuditEvent(input: {
  id: string;
  actorId: string;
  targetUserId: string;
  field: AccountAuditField;
  before: string;
  after: string;
  at: string;
}): AccountAuditEvent {
  return {
    id: input.id,
    actorId: input.actorId,
    targetUserId: input.targetUserId,
    action: input.field === "role" ? "account.role_changed" : "account.status_changed",
    field: input.field,
    before: input.before,
    after: input.after,
    createdAt: input.at,
  };
}

/**
 * Read/write access to the user account domain. Every method assumes the caller
 * has already been authorised as an admin (the HTTP layer enforces it).
 */
export class AccountService {
  constructor(private readonly db: Db) {}

  /** All users, newest first, each with last login and owned resource counts. */
  async list(): Promise<AccountSummary[]> {
    const rows = (await this.db.query("SELECT * FROM users ORDER BY created_at DESC")).rows as UserRow[];
    if (rows.length === 0) return [];
    const [runCounts, workspaceCounts, lastLogins] = await Promise.all([
      this.db.query("SELECT owner_id, COUNT(*)::int AS count FROM runs GROUP BY owner_id"),
      this.db.query("SELECT owner_id, COUNT(*)::int AS count FROM workspaces WHERE status != 'unregistered' GROUP BY owner_id"),
      this.db.query("SELECT user_id, MAX(last_login_at) AS last_login_at FROM user_identities GROUP BY user_id"),
    ]);
    const runsByOwner = new Map((runCounts.rows as CountRow[]).map((row) => [row.owner_id, Number(row.count)]));
    const workspacesByOwner = new Map((workspaceCounts.rows as CountRow[]).map((row) => [row.owner_id, Number(row.count)]));
    const lastLoginByUser = new Map((lastLogins.rows as LastLoginRow[]).map((row) => [row.user_id, row.last_login_at]));

    return rows.map((row) => projectAccount(row, {
      lastLoginAt: lastLoginByUser.get(row.id) ?? null,
      runsOwned: sumForKeys(accountOwnerKeys({ id: row.id, legacyOwnerId: row.legacy_owner_id }), runsByOwner),
      workspacesOwned: sumForKeys(accountOwnerKeys({ id: row.id, legacyOwnerId: row.legacy_owner_id }), workspacesByOwner),
    }));
  }

  /** One account with its workspace grants (grantee side). */
  async get(id: string): Promise<AccountDetail | undefined> {
    const user = await this.getUserRow(id);
    if (!user) return undefined;
    const summaries = await this.list();
    const summary = summaries.find((item) => item.id === user.id);
    if (!summary) return undefined;

    const keys = accountOwnerKeys({ id: user.id, legacyOwnerId: user.legacy_owner_id });
    const placeholders = keys.map((_, index) => "$" + (index + 1)).join(", ");
    const grantRows = (await this.db.query(
      `SELECT g.workspace_id, g.permission, g.granted_by, g.created_at, w.name AS workspace_name
       FROM workspace_grants g LEFT JOIN workspaces w ON w.id = g.workspace_id
       WHERE g.user_id IN (${placeholders})
       ORDER BY g.created_at DESC`,
      keys,
    )).rows as Array<{ workspace_id: string; permission: string; granted_by: string | null; created_at: string; workspace_name: string | null }>;

    const grants: AccountGrant[] = grantRows.map((grant) => ({
      workspaceId: grant.workspace_id,
      workspaceName: grant.workspace_name,
      permission: grant.permission === "write" ? "write" : "read",
      grantedBy: grant.granted_by,
      createdAt: grant.created_at,
    }));
    return { ...summary, grants };
  }

  /**
   * Apply a role/status change with guardrails, appending one `user_audit` row
   * per changed field in the same transaction as the update.
   */
  async update(id: string, patch: { role?: AccountRole; status?: AccountStatus }, actorId: string): Promise<AccountDetail> {
    await this.db.withTransaction(async (tx) => {
      const row = (await tx.query("SELECT * FROM users WHERE id = $1", [id])).rows[0] as UserRow | undefined;
      if (!row) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
      const adminCount = Number(
        ((await tx.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'")).rows[0] as { count: number }).count,
      );
      const plan = planAccountChange({ actorId, target: row, activeAdminCount: adminCount, patch });
      if (!plan.ok) throw new AccountError(plan.code, plan.message, plan.status);

      const nextRole = patch.role ?? normalizeRole(row.role);
      const nextStatus = patch.status ?? normalizeStatus(row.status);
      const now = new Date().toISOString();
      if (plan.roleChanged || plan.statusChanged) {
        await tx.query("UPDATE users SET role = $1, status = $2, updated_at = $3 WHERE id = $4", [nextRole, nextStatus, now, id]);
      }
      if (plan.roleChanged) {
        await insertAudit(tx, buildAuditEvent({ id: newId("audit"), actorId, targetUserId: id, field: "role", before: normalizeRole(row.role), after: nextRole, at: now }));
      }
      if (plan.statusChanged) {
        await insertAudit(tx, buildAuditEvent({ id: newId("audit"), actorId, targetUserId: id, field: "status", before: normalizeStatus(row.status), after: nextStatus, at: now }));
      }
    });
    const detail = await this.get(id);
    if (!detail) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
    return detail;
  }

  /** Upsert one workspace grant for a user (reuses `workspace_grants`). */
  async setGrant(id: string, input: { workspaceId: string; permission: WorkspacePermission }, actorId: string): Promise<AccountDetail> {
    const user = await this.getUserRow(id);
    if (!user) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
    const workspace = (await this.db.query("SELECT id FROM workspaces WHERE id = $1 AND status != 'unregistered'", [input.workspaceId])).rows[0] as { id: string } | undefined;
    if (!workspace) throw new AccountError("WORKSPACE_NOT_FOUND", "工作区不存在", 404);
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO workspace_grants (workspace_id, user_id, granted_by, created_at, permission)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET permission = $5, granted_by = $3`,
      [workspace.id, user.id, actorId, now, input.permission],
    );
    const detail = await this.get(id);
    if (!detail) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
    return detail;
  }

  /** Remove a user's grant for one workspace (both internal and legacy grantee keys). */
  async removeGrant(id: string, workspaceId: string): Promise<AccountDetail> {
    const user = await this.getUserRow(id);
    if (!user) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
    const keys = accountOwnerKeys({ id: user.id, legacyOwnerId: user.legacy_owner_id });
    const placeholders = keys.map((_, index) => "$" + (index + 2)).join(", ");
    await this.db.query(`DELETE FROM workspace_grants WHERE workspace_id = $1 AND user_id IN (${placeholders})`, [workspaceId, ...keys]);
    const detail = await this.get(id);
    if (!detail) throw new AccountError("ACCOUNT_NOT_FOUND", "账户不存在", 404);
    return detail;
  }

  /** Admin-only catalog of registerable workspaces for the grants editor. */
  async listWorkspaces(): Promise<AccountWorkspaceOption[]> {
    const rows = (await this.db.query(
      "SELECT id, name, owner_id, status FROM workspaces WHERE status != 'unregistered' ORDER BY updated_at DESC",
    )).rows as Array<{ id: string; name: string; owner_id: string; status: string }>;
    return rows.map((row) => ({ id: row.id, name: row.name, ownerId: row.owner_id, status: row.status as WorkspaceStatus }));
  }

  private async getUserRow(id: string): Promise<UserRow | undefined> {
    return (await this.db.query("SELECT * FROM users WHERE id = $1", [id])).rows[0] as UserRow | undefined;
  }
}

function sumForKeys(keys: string[], counts: Map<string, number>): number {
  return keys.reduce((total, key) => total + (counts.get(key) ?? 0), 0);
}

async function insertAudit(tx: Db, event: AccountAuditEvent): Promise<void> {
  await tx.query(
    "INSERT INTO user_audit (id, actor_id, target_user_id, action, field, before_value, after_value, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [event.id, event.actorId, event.targetUserId, event.action, event.field, event.before, event.after, event.createdAt],
  );
}
