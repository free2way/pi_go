import { describe, expect, it } from "vitest";
import type { WorkspaceVerifyResult } from "../shared/types.js";
import { WorkspaceError, WorkspaceService, redactGitUrl, type WorkerCall } from "./workspaces.js";
import { createTestDb } from "./test-db.js";

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

    // An explicit grant shares the owner's workspace record instead of cloning it.
    await db.query("INSERT INTO workspace_grants (workspace_id, user_id, granted_by, created_at) VALUES ($1, $2, $3, $4)", [first.id, "owner-b", "admin", new Date().toISOString()]);
    const shared = await service.register("owner-b", "private-project");
    expect(shared.id).toBe(first.id);
    expect((await service.list(["owner-b"])).map((item) => item.id)).toEqual([first.id]);
    expect(await service.refresh(["owner-b"], first.id)).toMatchObject({ id: first.id });
  });

});
