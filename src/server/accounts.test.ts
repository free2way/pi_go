import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import {
  AccountError,
  AccountService,
  accountAdminGate,
  accountOwnerKeys,
  buildAuditEvent,
  normalizeRole,
  normalizeStatus,
  planAccountChange,
  projectAccount,
} from "./accounts.js";
import { createTestDb } from "./test-db.js";

const NOW = "2026-01-02T03:04:05.000Z";

async function seedUser(
  db: Db,
  input: { id: string; email: string; role?: "admin" | "user"; status?: string; legacyOwnerId?: string | null; createdAt?: string },
) {
  await db.query(
    "INSERT INTO users (id, email, role, status, legacy_owner_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [input.id, input.email, input.role ?? "user", input.status ?? "active", input.legacyOwnerId ?? null, input.createdAt ?? NOW, NOW],
  );
}

async function seedWorkspace(db: Db, id: string, ownerId: string, status = "active") {
  await db.query(
    `INSERT INTO workspaces (id, owner_id, node_id, name, type, root_path, canonical_path, repository_url, default_branch, default_checks_json, status, git_branch, git_head, git_dirty, git_dirty_files_json, last_checked_at, created_at, updated_at)
     VALUES ($1, $2, 'server', $3, 'server', $3, $3, NULL, NULL, '[]', $4, NULL, NULL, NULL, '[]', NULL, $5, $5)`,
    [id, ownerId, `ws-${id}`, status, NOW],
  );
}

async function seedRun(db: Db, id: string, ownerId: string) {
  await db.query(
    "INSERT INTO runs (id, owner_id, state, mode, created_at, updated_at, last_seq, document_json, revision) VALUES ($1, $2, 'completed', 'demo', $3, $3, 0, '{}', 0)",
    [id, ownerId, NOW],
  );
}

describe("account helpers", () => {
  it("normalizes unknown roles/statuses to the safe defaults", () => {
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("user")).toBe("user");
    expect(normalizeRole("root")).toBe("user");
    expect(normalizeStatus("disabled")).toBe("disabled");
    expect(normalizeStatus("active")).toBe("active");
    expect(normalizeStatus("suspended")).toBe("active");
  });

  it("keeps the legacy owner key so pre-migration resources stay counted", () => {
    expect(accountOwnerKeys({ id: "u1", legacyOwnerId: "legacy" })).toEqual(["u1", "legacy"]);
    expect(accountOwnerKeys({ id: "u1", legacyOwnerId: null })).toEqual(["u1"]);
  });

  it("projects only non-sensitive account fields with zeroed counters by default", () => {
    const summary = projectAccount({ id: "u1", email: "a@example.com", role: "admin", status: "disabled", created_at: NOW, updated_at: NOW });
    expect(summary).toEqual({
      id: "u1",
      email: "a@example.com",
      role: "admin",
      status: "disabled",
      createdAt: NOW,
      updatedAt: NOW,
      lastLoginAt: null,
      runsOwned: 0,
      workspacesOwned: 0,
    });
    expect(Object.keys(summary)).not.toContain("issuer");
    expect(Object.keys(summary)).not.toContain("subject");
  });

  it("refuses a self role change (409 SELF_ROLE_CHANGE)", () => {
    const plan = planAccountChange({
      actorId: "admin-1",
      target: { id: "admin-1", role: "admin", status: "active" },
      activeAdminCount: 3,
      patch: { role: "user" },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("SELF_ROLE_CHANGE");
      expect(plan.status).toBe(409);
      expect(plan.message).toContain("自己的角色");
    }
  });

  it("allows a role change of another admin when more than one active admin exists", () => {
    const plan = planAccountChange({
      actorId: "admin-1",
      target: { id: "admin-2", role: "admin", status: "active" },
      activeAdminCount: 2,
      patch: { role: "user" },
    });
    expect(plan).toMatchObject({ ok: true, roleChanged: true, statusChanged: false });
  });

  it("refuses to demote or disable the last active admin (409 LAST_ADMIN)", () => {
    for (const patch of [{ role: "user" as const }, { status: "disabled" as const }]) {
      const plan = planAccountChange({
        actorId: "admin-2",
        target: { id: "admin-1", role: "admin", status: "active" },
        activeAdminCount: 1,
        patch,
      });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.code).toBe("LAST_ADMIN");
        expect(plan.status).toBe(409);
      }
    }
  });

  it("may disable a non-admin even when only one active admin exists", () => {
    const plan = planAccountChange({
      actorId: "admin-1",
      target: { id: "user-1", role: "user", status: "active" },
      activeAdminCount: 1,
      patch: { status: "disabled" },
    });
    expect(plan).toMatchObject({ ok: true });
  });

  it("reports NO_CHANGES when the patch is a no-op", () => {
    const plan = planAccountChange({
      actorId: "admin-1",
      target: { id: "user-1", role: "user", status: "active" },
      activeAdminCount: 1,
      patch: { role: "user" },
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("NO_CHANGES");
  });

  it("shapes an audit event with actor, target and before/after", () => {
    const event = buildAuditEvent({ id: "audit_1", actorId: "admin-1", targetUserId: "user-1", field: "role", before: "user", after: "admin", at: NOW });
    expect(event).toEqual({
      id: "audit_1",
      actorId: "admin-1",
      targetUserId: "user-1",
      action: "account.role_changed",
      field: "role",
      before: "user",
      after: "admin",
      createdAt: NOW,
    });
    expect(buildAuditEvent({ id: "audit_2", actorId: "a", targetUserId: "t", field: "status", before: "active", after: "disabled", at: NOW }).action)
      .toBe("account.status_changed");
  });

  it("gates the whole section: admin allowed, user 403 ADMIN_REQUIRED", () => {
    expect(accountAdminGate(true)).toEqual({ allowed: true });
    const denied = accountAdminGate(false);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.status).toBe(403);
      expect(denied.code).toBe("ADMIN_REQUIRED");
    }
  });
});

describe("AccountService", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("lists users with last login and owned-run/workspace counts (legacy owner included)", async () => {
    await seedUser(db, { id: "admin-1", email: "admin@example.com", role: "admin" });
    await seedUser(db, { id: "user-1", email: "user@example.com", legacyOwnerId: "legacy-1" });
    await db.query("INSERT INTO user_identities (id, user_id, issuer, subject, identity_provider, last_login_at, created_at) VALUES ($1, $2, 'dev', 's', 'development', $3, $3)", ["i1", "user-1", "2026-01-05T00:00:00.000Z"]);
    await seedRun(db, "run-1", "user-1");
    await seedRun(db, "run-2", "legacy-1");
    await seedWorkspace(db, "ws-owned", "legacy-1");
    await seedWorkspace(db, "ws-unregistered", "user-1", "unregistered");

    const accounts = await new AccountService(db).list();
    const user = accounts.find((item) => item.id === "user-1")!;
    expect(user.runsOwned).toBe(2);
    expect(user.workspacesOwned).toBe(1);
    expect(user.lastLoginAt).toBe("2026-01-05T00:00:00.000Z");
    // Projection exposes exactly the documented fields — nothing sensitive.
    expect(Object.keys(user).sort()).toEqual(["createdAt", "email", "id", "lastLoginAt", "role", "runsOwned", "status", "updatedAt", "workspacesOwned"]);
  });

  it("returns one account with its workspace grants (name + permission)", async () => {
    await seedUser(db, { id: "user-1", email: "user@example.com" });
    await seedUser(db, { id: "admin-1", email: "admin@example.com", role: "admin" });
    await seedWorkspace(db, "ws-1", "admin-1");
    await db.query("INSERT INTO workspace_grants (workspace_id, user_id, granted_by, created_at, permission) VALUES ('ws-1', 'user-1', 'admin-1', $1, 'write')", [NOW]);

    const detail = await new AccountService(db).get("user-1");
    expect(detail?.grants).toEqual([{ workspaceId: "ws-1", workspaceName: "ws-ws-1", permission: "write", grantedBy: "admin-1", createdAt: NOW }]);
    expect(await new AccountService(db).get("missing")).toBeUndefined();
  });

  it("applies a role change and appends an audit row with actor + before/after", async () => {
    await seedUser(db, { id: "admin-1", email: "admin@example.com", role: "admin" });
    await seedUser(db, { id: "user-1", email: "user@example.com" });
    const service = new AccountService(db);

    const updated = await service.update("user-1", { role: "admin" }, "admin-1");
    expect(updated.role).toBe("admin");
    const audit = (await db.query("SELECT * FROM user_audit")).rows as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: "admin-1", target_user_id: "user-1", action: "account.role_changed", field: "role", before_value: "user", after_value: "admin" });
  });

  it("enforces LAST_ADMIN against the live database state", async () => {
    await seedUser(db, { id: "admin-1", email: "admin@example.com", role: "admin" });
    const service = new AccountService(db);
    await expect(service.update("admin-1", { status: "disabled" }, "admin-1")).rejects.toMatchObject({ code: "LAST_ADMIN", status: 409 });
    await expect(service.update("admin-1", { role: "user" }, "admin-1")).rejects.toMatchObject({ code: "SELF_ROLE_CHANGE", status: 409 });
    expect(((await db.query("SELECT COUNT(*)::int AS count FROM user_audit")).rows[0] as { count: number }).count).toBe(0);
  });

  it("records both fields when role and status change together", async () => {
    await seedUser(db, { id: "admin-1", email: "admin@example.com", role: "admin" });
    await seedUser(db, { id: "admin-2", email: "admin2@example.com", role: "admin" });
    const updated = await new AccountService(db).update("admin-2", { role: "user", status: "disabled" }, "admin-1");
    expect(updated).toMatchObject({ role: "user", status: "disabled" });
    const actions = ((await db.query("SELECT action FROM user_audit ORDER BY action")).rows as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toEqual(["account.role_changed", "account.status_changed"]);
  });

  it("throws ACCOUNT_NOT_FOUND for an unknown target", async () => {
    await expect(new AccountService(db).update("missing", { role: "admin" }, "admin-1")).rejects.toBeInstanceOf(AccountError);
  });

  it("upserts and removes a workspace grant", async () => {
    await seedUser(db, { id: "user-1", email: "user@example.com" });
    await seedWorkspace(db, "ws-1", "admin-1");
    const service = new AccountService(db);

    let detail = await service.setGrant("user-1", { workspaceId: "ws-1", permission: "read" }, "admin-1");
    expect(detail.grants[0]).toMatchObject({ workspaceId: "ws-1", permission: "read", grantedBy: "admin-1" });

    detail = await service.setGrant("user-1", { workspaceId: "ws-1", permission: "write" }, "admin-2");
    expect(detail.grants).toHaveLength(1);
    expect(detail.grants[0]).toMatchObject({ permission: "write", grantedBy: "admin-2" });

    detail = await service.removeGrant("user-1", "ws-1");
    expect(detail.grants).toEqual([]);
  });

  it("refuses a grant on an unknown or unregistered workspace", async () => {
    await seedUser(db, { id: "user-1", email: "user@example.com" });
    await seedWorkspace(db, "ws-gone", "admin-1", "unregistered");
    const service = new AccountService(db);
    await expect(service.setGrant("user-1", { workspaceId: "missing", permission: "read" }, "admin-1")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND", status: 404 });
    await expect(service.setGrant("user-1", { workspaceId: "ws-gone", permission: "read" }, "admin-1")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("lists registerable workspaces for the grants editor", async () => {
    await seedWorkspace(db, "ws-1", "admin-1");
    await seedWorkspace(db, "ws-gone", "admin-1", "unregistered");
    const options = await new AccountService(db).listWorkspaces();
    expect(options).toEqual([{ id: "ws-1", name: "ws-ws-1", ownerId: "admin-1", status: "active" }]);
  });
});
