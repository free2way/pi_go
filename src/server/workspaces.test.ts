import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceVerifyResult } from "../shared/types.js";
import { DEFAULT_SCM_WORKER_TIMEOUT_MS, scmWorkerTimeoutMs, WorkspaceError, WorkspaceService, redactGitUrl, type WorkerCall } from "./workspaces.js";
import { createTestDb } from "./test-db.js";
import { ScmSettingsStore } from "./scm-settings.js";

async function createService(callWorker: (pathName: string, init?: RequestInit) => Promise<WorkspaceVerifyResult>) {
  const db = await createTestDb();
  const service = new WorkspaceService(db, callWorker as unknown as WorkerCall);
  return { db, service };
}

const verifyOk = (overrides: Partial<WorkspaceVerifyResult> = {}): WorkspaceVerifyResult => ({
  ok: true,
  relativePath: "pi_go",
  canonicalPath: "/workspace/projects/pi_go",
  name: "pi_go",
  branch: "main",
  head: "abc1234",
  dirty: false,
  dirtyFiles: [],
  ...overrides,
});

describe("workspace service", () => {
  it("uses a bounded SCM worker timeout instead of the 15-second control-plane default", () => {
    expect(scmWorkerTimeoutMs()).toBe(DEFAULT_SCM_WORKER_TIMEOUT_MS);
    expect(scmWorkerTimeoutMs("120000")).toBe(120_000);
    expect(scmWorkerTimeoutMs("1")).toBe(30_000);
    expect(scmWorkerTimeoutMs("9999999")).toBe(900_000);
    expect(scmWorkerTimeoutMs("invalid")).toBe(DEFAULT_SCM_WORKER_TIMEOUT_MS);
  });

  it("registers a workspace through the worker and lists it per owner", async () => {
    const { service } = await createService(async () => verifyOk());
    const workspace = await service.register("owner-a", "pi_go");

    expect(workspace.name).toBe("pi_go");
    expect(workspace.git).toEqual({ branch: "main", head: "abc1234", dirty: false, dirtyFiles: [] });
    expect(workspace.status).toBe("active");
    expect(await service.list(["owner-a"])).toHaveLength(1);
    expect(await service.list(["owner-b"])).toHaveLength(0);
    await expect(service.get(["owner-b"], workspace.id)).rejects.toThrow(WorkspaceError);
  });

  it("rejects invalid paths and surfaces worker error codes", async () => {
    const { service } = await createService(async () => ({ ok: false, code: "WORKSPACE_OUTSIDE_ROOT", error: "outside" }));
    const error = await service.register("owner-a", "../etc").catch((cause: WorkspaceError) => cause);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("WORKSPACE_OUTSIDE_ROOT");
    expect((error as WorkspaceError).status).toBe(422);
  });

  it("updates an existing workspace instead of duplicating a name", async () => {
    const { service } = await createService(async () => verifyOk());
    const first = await service.register("owner-a", "pi_go");
    const second = await service.register("owner-a", "pi_go");
    expect(second.id).toBe(first.id);
    expect(await service.list(["owner-a"])).toHaveLength(1);
  });

  it("refreshes git metadata and marks invalid workspaces", async () => {
    let mode: "ok" | "missing" = "ok";
    const { service } = await createService(async () => mode === "ok"
      ? verifyOk({ head: "def5678", dirty: true, dirtyFiles: [" M src/server/index.ts", "?? notes.md"] })
      : { ok: false, code: "WORKSPACE_INVALID", error: "Workspace path does not exist" });

    const workspace = await service.register("owner-a", "pi_go");
    const refreshed = await service.refresh(["owner-a"], workspace.id);
    expect(refreshed.git).toEqual({ branch: "main", head: "def5678", dirty: true, dirtyFiles: [" M src/server/index.ts", "?? notes.md"] });

    mode = "missing";
    await expect(service.refresh(["owner-a"], workspace.id)).rejects.toThrow(WorkspaceError);
    expect((await service.get(["owner-a"], workspace.id)).status).toBe("invalid");
  });

  it("patches defaults and unregisters without deleting runs", async () => {
    const { service } = await createService(async () => verifyOk());
    const workspace = await service.register("owner-a", "pi_go");

    const patched = await service.patch(["owner-a"], workspace.id, { defaultChecks: ["npm test"], defaultBranch: "develop" });
    expect(patched.defaultChecks).toEqual(["npm test"]);
    expect(patched.defaultBranch).toBe("develop");

    await service.unregister(["owner-a"], workspace.id);
    expect(await service.list(["owner-a"])).toHaveLength(0);
  });

  it("validates clone names before calling the worker", async () => {
    let called = 0;
    const { service } = await createService(async () => {
      called += 1;
      return verifyOk();
    });
    await expect(service.clone("owner-a", "https://example.com/repo.git", "../evil")).rejects.toThrow(WorkspaceError);
    expect(called).toBe(0);
  });

  it("validates create names before calling the worker", async () => {
    let called = 0;
    const { service } = await createService(async () => {
      called += 1;
      return verifyOk();
    });
    await expect(service.create("owner-a", "../evil")).rejects.toMatchObject({ code: "WORKSPACE_INVALID", status: 422 });
    expect(called).toBe(0);
  });

  it("creates the directory on the worker and registers it for the caller", async () => {
    const calls: Array<{ pathName: string; body: unknown }> = [];
    const { service } = await createService(async (pathName, init) => {
      calls.push({ pathName, body: JSON.parse(String(init?.body)) });
      return verifyOk({ name: "new-repo", relativePath: "new-repo", canonicalPath: "/workspace/projects/new-repo" });
    });

    const workspace = await service.create("owner-a", "new-repo");

    expect(calls).toEqual([{ pathName: "/workspaces/create", body: { name: "new-repo" } }]);
    expect(workspace).toMatchObject({ name: "new-repo", status: "active", rootPath: "new-repo" });
    expect((await service.list(["owner-a"])).map((item) => item.name)).toEqual(["new-repo"]);
  });

  it("surfaces a clear error when the worker refuses an existing directory", async () => {
    const { service } = await createService(async () => ({
      ok: false,
      code: "WORKSPACE_EXISTS",
      error: "Workspace directory already exists with different content: taken",
    }));

    await expect(service.create("owner-a", "taken")).rejects.toMatchObject({ code: "WORKSPACE_EXISTS", status: 409 });
  });

  it("redacts credentials embedded in git urls", () => {
    expect(redactGitUrl("https://user:token@example.com/repo.git")).toBe("https://***@example.com/repo.git");
    expect(redactGitUrl("https://example.com/repo.git")).toBe("https://example.com/repo.git");
  });

  it("rejects a second owner for the same physical repository (AUD-02)", async () => {
    const db = await createTestDb();
    const service = new WorkspaceService(db, (async () => ({ ok: true, name: "private-project", relativePath: "private-project", canonicalPath: "/srv/projects/private-project", branch: "main", head: "abc", dirty: false, dirtyFiles: [] })) as unknown as ConstructorParameters<typeof WorkspaceService>[1]);
    const first = await service.register("owner-a", "private-project");
    expect(first.id).toBeTruthy();

    await expect(service.register("owner-b", "private-project")).rejects.toMatchObject({ code: "WORKSPACE_PATH_TAKEN", status: 409 });

    // Re-registering by the same owner stays idempotent.
    const again = await service.register("owner-a", "private-project");
    expect(again.id).toBe(first.id);

    // An explicit write grant shares the owner's workspace record instead of cloning it.
    await db.query("INSERT INTO workspace_grants (workspace_id, user_id, permission, granted_by, created_at) VALUES ($1, $2, 'write', $3, $4)", [first.id, "owner-b", "admin", new Date().toISOString()]);
    const shared = await service.register("owner-b", "private-project");
    expect(shared.id).toBe(first.id);
    expect((await service.list(["owner-b"])).map((item) => item.id)).toEqual([first.id]);
    expect(await service.refresh(["owner-b"], first.id)).toMatchObject({ id: first.id, permission: "write" });
  });

  describe("workspace grant permissions (B4)", () => {
    async function sharedWorkspace(grant: "read" | "write" | null) {
      const { db, service } = await createService(async () => verifyOk());
      const workspace = await service.register("owner-a", "pi_go");
      if (grant) {
        await db.query("INSERT INTO workspace_grants (workspace_id, user_id, permission, granted_by, created_at) VALUES ($1, $2, $3, $4, $5)", [workspace.id, "member", grant, "owner-a", new Date().toISOString()]);
      }
      return { db, service, workspace };
    }

    it("defaults a pre-B4 grant row to read-only", async () => {
      const { db, service } = await createService(async () => verifyOk());
      const workspace = await service.register("owner-a", "pi_go");
      // Insert without `permission` to exercise the migration default.
      await db.query("INSERT INTO workspace_grants (workspace_id, user_id, granted_by, created_at) VALUES ($1, $2, $3, $4)", [workspace.id, "member", "owner-a", new Date().toISOString()]);

      const listed = await service.list(["member"]);
      expect(listed).toHaveLength(1);
      expect(listed[0].permission).toBe("read");
      const row = (await db.query("SELECT permission FROM workspace_grants WHERE workspace_id = $1 AND user_id = $2", [workspace.id, "member"])).rows[0] as { permission: string };
      expect(row.permission).toBe("read");
    });

    it("a read grant may view and start runs but cannot change checks or unregister", async () => {
      const { service, workspace } = await sharedWorkspace("read");
      expect((await service.get(["member"], workspace.id)).permission).toBe("read");
      // Run-start preflight allows read access.
      await expect(service.refresh(["member"], workspace.id, { allowRead: true })).resolves.toMatchObject({ id: workspace.id });
      // Mutating actions are refused with a clear 403.
      await expect(service.patch(["member"], workspace.id, { defaultChecks: ["rm -rf /"] })).rejects.toMatchObject({ code: "WORKSPACE_READ_ONLY", status: 403 });
      await expect(service.refresh(["member"], workspace.id)).rejects.toMatchObject({ code: "WORKSPACE_READ_ONLY", status: 403 });
      await expect(service.unregister(["member"], workspace.id)).rejects.toMatchObject({ code: "WORKSPACE_READ_ONLY", status: 403 });
      // The owner's checks are untouched and the workspace is still listed.
      expect((await service.get(["owner-a"], workspace.id)).defaultChecks).toEqual([]);
      expect((await service.list(["member"]))[0].status).toBe("active");
    });

    it("a write grant may change checks, refresh and unregister", async () => {
      const { service, workspace } = await sharedWorkspace("write");
      expect((await service.list(["member"]))[0].permission).toBe("write");
      expect((await service.patch(["member"], workspace.id, { defaultChecks: ["npm test"] })).defaultChecks).toEqual(["npm test"]);
      await expect(service.refresh(["member"], workspace.id)).resolves.toMatchObject({ id: workspace.id });
      await service.unregister(["member"], workspace.id);
      expect(await service.list(["owner-a"])).toHaveLength(0);
    });

    it("leaves the owner and admins unaffected", async () => {
      const { service, workspace } = await sharedWorkspace(null);
      expect((await service.get(["owner-a"], workspace.id)).permission).toBe("write");
      expect((await service.patch(["owner-a"], workspace.id, { defaultChecks: ["npm run lint"] })).defaultChecks).toEqual(["npm run lint"]);
      // An admin who does not own or hold a grant may still mutate and sees write.
      expect((await service.get(["admin-x"], workspace.id, { isAdmin: true })).permission).toBe("write");
      expect((await service.patch(["admin-x"], workspace.id, { defaultChecks: ["npm test"] }, { isAdmin: true })).defaultChecks).toEqual(["npm test"]);
      await service.unregister(["admin-x"], workspace.id, { isAdmin: true });
      expect(await service.list(["owner-a"])).toHaveLength(0);
    });

    it("echoes the grant's permission when a member re-registers the shared path", async () => {
      const { service, workspace } = await sharedWorkspace("read");
      expect(await service.register("member", "pi_go")).toMatchObject({ id: workspace.id, permission: "read" });
    });

    it("returns 404 (not read-only) for a user with no access at all", async () => {
      const { service, workspace } = await sharedWorkspace("read");
      await expect(service.patch(["stranger"], workspace.id, { defaultChecks: ["x"] })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND", status: 404 });
    });
  });

  it("checks, pushes and audits a workspace remote without exposing its token", async () => {
    const db = await createTestDb();
    const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-scm-workspaces-"));
    const settings = new ScmSettingsStore(path.join(directory, "scm.json"), Buffer.alloc(32, 3).toString("base64"));
    await settings.init();
    let pushed = false;
    let receivedToken = "";
    const callWorker = (async (pathName: string, init?: RequestInit) => {
      if (pathName === "/workspaces/verify") return verifyOk();
      const body = JSON.parse(String(init?.body ?? "{}")) as { credential?: { token?: string } };
      receivedToken = body.credential?.token ?? "";
      if (pathName === "/workspaces/remote-status") return {
        provider: "github", remote: "https://github.com/org/repo.git", branch: "main",
        localHead: "abc", remoteHead: "def", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now",
      };
      if (pathName === "/workspaces/push-guarded") {
        pushed = true;
        return {
          pushed: true,
          before: { provider: "github", remote: "https://github.com/org/repo.git", branch: "main", localHead: "abc", remoteHead: "def", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now" },
          after: { provider: "github", remote: "https://github.com/org/repo.git", branch: "main", localHead: "abc", remoteHead: "abc", relation: "synchronized", ahead: 0, behind: 0, checkedAt: "later" },
        };
      }
      throw new Error(`unexpected ${pathName}`);
    }) as WorkerCall;
    const service = new WorkspaceService(db, callWorker, settings);
    const workspace = await service.register("owner", "pi_go");
    await service.saveScmSettings(["owner"], workspace.id, { provider: "github", authMode: "https_token", token: "github-secret" });
    expect(await service.remoteStatus(["owner"], workspace.id)).toMatchObject({ relation: "ahead" });
    expect(receivedToken).toBe("github-secret");
    expect(await service.push(["owner"], workspace.id, "owner")).toMatchObject({ pushed: true });
    expect(pushed).toBe(true);
    const overview = await service.scmOverview(["owner"], workspace.id);
    expect(overview.settings).toMatchObject({ provider: "github", tokenConfigured: true });
    expect(overview.attempts[0]).toMatchObject({ status: "succeeded", localHead: "abc", remoteHead: "abc" });
    expect(JSON.stringify(overview)).not.toContain("github-secret");
  });

  it.each(["check", "push"])("redacts legacy Worker %s failures before exposing or auditing them", async (operation) => {
    const db = await createTestDb();
    const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-scm-diagnostics-"));
    try {
      const saved = "DUMMY_SCM_" + 'opaque" value';
      const marker = "DUMMY_BEARER_" + "private-value";
      const settings = new ScmSettingsStore(path.join(directory, "scm.json"), Buffer.alloc(32, 3).toString("base64"));
      await settings.init();
      let received = "";
      const service = new WorkspaceService(db, (async (route: string, init?: RequestInit) => {
        if (route === "/workspaces/verify") return verifyOk({ relativePath: "fixture" });
        received = JSON.parse(String(init?.body)).credential.token;
        throw Object.assign(new Error(`controlled SCM failure: Bearer ${marker} ${saved} ${encodeURIComponent(saved)}`), { code: "SCM_REMOTE_UNREACHABLE", status: 409 });
      }) as WorkerCall, settings);
      const workspace = await service.register("owner", "pi_go");
      await service.saveScmSettings(["owner"], workspace.id, { provider: "generic", authMode: "https_token", token: saved });
      const action = operation === "push" ? service.push(["owner"], workspace.id, "owner") : service.remoteStatus(["owner"], workspace.id);
      const failure = await action.catch((e: WorkspaceError) => e) as WorkspaceError;
      expect(failure).toMatchObject({ code: "SCM_REMOTE_UNREACHABLE", status: 409 });
      expect(failure.message).toContain("controlled SCM failure");
      expect(received).toBe(saved);
      const overview = await service.scmOverview(["owner"], workspace.id);
      const persisted = await db.query("SELECT detail FROM workspace_scm_sync_attempts WHERE workspace_id=$1", [workspace.id]);
      for (const text of [failure.message, JSON.stringify(overview), JSON.stringify(persisted.rows)]) {
        for (const value of [saved, encodeURIComponent(saved), marker]) expect(text).not.toContain(value);
      }
      if (operation === "push") expect(overview.attempts[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("[redacted]") });
      else expect(overview.attempts).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["plain", "encoded", "truncated"])("redacts configured private paths before SCM audit persistence: %s", async (variant) => {
    const privateFile = "/private/synthetic/scm-diagnostics/store.json";
    vi.stubEnv("PI_DATA_FILE", privateFile);
    const raw = new Error(`SCM unavailable ${variant === "truncated" ? "x".repeat(775) : ""}${variant === "encoded" ? encodeURIComponent(privateFile) : privateFile}`);
    const db = await createTestDb();
    try {
      const service = new WorkspaceService(db, (async (route: string) => {
        if (route === "/workspaces/verify") return verifyOk({ relativePath: "fixture" });
        throw raw;
      }) as WorkerCall);
      const workspace = await service.register("owner", "pi_go");
      const failure = await service.push(["owner"], workspace.id, "owner").catch((error: WorkspaceError) => error) as WorkspaceError;
      expect(failure).toMatchObject({ code: "SCM_PUSH_FAILED", status: 503 });
      const persisted = await db.query("SELECT detail FROM workspace_scm_sync_attempts WHERE workspace_id=$1", [workspace.id]);
      expect(persisted.rows).toHaveLength(1);
      const overview = await service.scmOverview(["owner"], workspace.id);
      expect(overview.attempts[0]).toMatchObject({ status: "failed" });
      // Assert the durable audit and its read projection before checking the
      // thrown diagnostic, so HTTP-only redaction cannot mask a stored leak.
      for (const output of [String(persisted.rows[0].detail), overview.attempts[0].detail!, failure.message]) {
        expect(output).not.toContain("/private/");
        expect(output).not.toContain("%2Fprivate%2F");
        expect(output).toContain("[redact");
        expect(output).toContain("SCM unavailable");
      }
      expect(raw.message).toContain(variant === "encoded" ? encodeURIComponent(privateFile) : privateFile);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["plain", "encoded", "truncated"])("safely projects historical SCM audit paths without rewriting evidence: %s", async (variant) => {
    const privateFile = "/private/synthetic/scm-history/store.json";
    const db = await createTestDb();
    vi.stubEnv("PI_DATA_FILE", privateFile);
    try {
      const service = new WorkspaceService(db, (async (route: string) => {
        if (route === "/workspaces/verify") return verifyOk({ relativePath: "fixture" });
        throw new Error("controlled SCM failure");
      }) as WorkerCall);
      const workspace = await service.register("owner", "pi_go");
      await service.push(["owner"], workspace.id, "owner").catch(() => undefined);
      const legacy = `SCM historical failure ${variant === "truncated" ? "x".repeat(775) : ""}${variant === "encoded" ? encodeURIComponent(privateFile) : privateFile}`;
      await db.query("UPDATE workspace_scm_sync_attempts SET detail=$1 WHERE workspace_id=$2", [legacy, workspace.id]);
      const detail = (await service.scmOverview(["owner"], workspace.id)).attempts[0].detail!;
      expect(detail).not.toContain("/private/");
      expect(detail).not.toContain("%2Fprivate%2F");
      expect(detail).toContain("[redact");
      expect(detail).toContain("SCM historical failure");
      const persisted = await db.query("SELECT detail FROM workspace_scm_sync_attempts WHERE workspace_id=$1", [workspace.id]);
      expect(persisted.rows[0].detail).toBe(legacy);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["plain", "url", "json"])("hides the current SCM credential in historical %s diagnostics for every reader", async (variant) => {
    const db = await createTestDb();
    const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-scm-history-context-"));
    try {
      const saved = ["DUMMY", 'opaque-scm/+" value'].join("_");
      const settings = new ScmSettingsStore(path.join(directory, "scm.json"), Buffer.alloc(32, 7).toString("base64"));
      await settings.init();
      const service = new WorkspaceService(db, (async (route: string) => {
        if (route === "/workspaces/verify") return verifyOk({ relativePath: "fixture" });
        throw new Error("controlled SCM failure");
      }) as WorkerCall, settings);
      const workspace = await service.register("owner", "pi_go");
      await service.saveScmSettings(["owner"], workspace.id, { provider: "generic", authMode: "https_token", token: saved });
      await service.push(["owner"], workspace.id, "owner").catch(() => undefined);
      const forms = [saved, encodeURIComponent(saved), JSON.stringify(saved).slice(1, -1)];
      const legacy = `historical SCM failure ${forms[["plain", "url", "json"].indexOf(variant)]} exit=128`;
      await db.query("UPDATE workspace_scm_sync_attempts SET detail=$1 WHERE workspace_id=$2", [legacy, workspace.id]);
      await db.query("INSERT INTO workspace_grants (workspace_id, user_id, permission, granted_by, created_at) VALUES ($1, $2, 'read', $3, $4)", [workspace.id, "reader", "owner", new Date().toISOString()]);
      // Start with the read-only member: access to history never grants the
      // right to recover a saved credential from a legacy diagnostic.
      for (const [reader, options] of [["reader", {}], ["owner", {}], ["admin", { isAdmin: true }]] as const) {
        const overview = await service.scmOverview([reader], workspace.id, options);
        const detail = overview.attempts[0].detail!;
        for (const form of forms) expect(detail).not.toContain(form);
        expect(detail).toContain("historical SCM failure");
        expect(detail).toContain("[redacted]");
        expect(overview.settings.tokenConfigured).toBe(true);
      }
      const persisted = await db.query("SELECT detail FROM workspace_scm_sync_attempts WHERE workspace_id=$1", [workspace.id]);
      expect(persisted.rows[0].detail).toBe(legacy);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("redacts credential query parameters in persisted repository display URLs", () => {
    const marker = "DUMMY_QUERY_" + "private-value";
    expect(redactGitUrl(`https://repo.example.invalid/repo?token=${marker}`)).not.toContain(marker);
  });

  it("defaults an HTTPS GitHub workspace to token authentication", async () => {
    const db = await createTestDb();
    const service = new WorkspaceService(db, (async (pathName: string) => {
      if (pathName === "/workspaces/clone") return verifyOk({ relativePath: "repo", name: "repo" });
      throw new Error(`unexpected ${pathName}`);
    }) as WorkerCall);
    const workspace = await service.clone("owner", "https://github.com/org/repo.git", "repo");
    await expect(service.scmOverview(["owner"], workspace.id)).resolves.toMatchObject({
      settings: { provider: "github", authMode: "https_token", tokenConfigured: false },
    });
  });

  it("returns an actionable SCM timeout and records the failed attempt", async () => {
    const db = await createTestDb();
    const service = new WorkspaceService(db, (async (pathName: string) => {
      if (pathName === "/workspaces/verify") return verifyOk();
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as WorkerCall);
    const workspace = await service.register("owner", "pi_go");
    await expect(service.push(["owner"], workspace.id, "owner")).rejects.toMatchObject({
      code: "SCM_OPERATION_TIMEOUT",
      status: 504,
    });
    const overview = await service.scmOverview(["owner"], workspace.id);
    expect(overview.attempts[0]).toMatchObject({ status: "failed" });
    expect(overview.attempts[0]?.detail).toContain("configured server timeout");
  });

});


describe("model credential source export context", () => {
  async function fixture(read: (actor: string) => Promise<string[]>, legacyWorker = false) {
    const db = await createTestDb();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const worker = (async (route: string, init?: RequestInit) => {
      if (route === "/workspaces/verify") return verifyOk({ relativePath: "fixture" });
      calls.push({ path: route, body: JSON.parse(String(init?.body ?? "{}")) });
      if (legacyWorker && route === "/workspaces/push-guarded") throw Object.assign(new Error("Unsupported route"), { status: 404 });
      const remote = { provider: "generic", remote: "fixture", branch: "main", localHead: "a", remoteHead: "a", relation: "synchronized", ahead: 0, behind: 0, checkedAt: "now" };
      return { pushed: false, before: remote, after: remote };
    }) as WorkerCall;
    const service = new WorkspaceService(db, worker, undefined, read);
    const workspace = await service.register("owner", "fixture");
    return { db, calls, service, workspace };
  }
  it("resolves only the acting user and uses a guarded Worker route", async () => {
    const read = vi.fn(async () => ["DUMMY_model_context"]);
    const f = await fixture(read);
    await f.service.push(["owner"], f.workspace.id, "actor", { isAdmin: true });
    expect(read).toHaveBeenCalledExactlyOnceWith("actor");
    expect(f.calls).toEqual([{ path: "/workspaces/push-guarded", body: { relativePath: "fixture", branch: "main", exportCredentials: ["DUMMY_model_context"] } }]);
  });
  it("fails closed before Worker I/O if credential lookup fails", async () => {
    const f = await fixture(async () => { throw new Error("DUMMY_private_lookup"); });
    await expect(f.service.push(["owner"], f.workspace.id, "actor")).rejects.toMatchObject({ code: "SCM_EXPORT_POLICY_FAILED", status: 503 });
    expect(f.calls).toHaveLength(0);
    const rows = await f.db.query("SELECT detail FROM workspace_scm_sync_attempts WHERE workspace_id=$1", [f.workspace.id]);
    expect(JSON.stringify(rows.rows)).not.toContain("DUMMY_private_lookup");
  });
  it("does not fall back to an unguarded push on an older Worker", async () => {
    const f = await fixture(async () => [], true);
    await expect(f.service.push(["owner"], f.workspace.id, "actor")).rejects.toMatchObject({ status: 404 });
    expect(f.calls.map(c => c.path)).toEqual(["/workspaces/push-guarded"]);
  });
  it("checks workspace access before resolving model credentials", async () => {
    const read = vi.fn(async () => ["DUMMY_private"]);
    const f = await fixture(read);
    await expect(f.service.push(["outsider"], f.workspace.id, "outsider")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect(read).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
});
