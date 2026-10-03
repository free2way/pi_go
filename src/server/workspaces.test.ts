import { describe, expect, it } from "vitest";
import type { WorkspaceVerifyResult } from "../shared/types.js";
import { openDatabase } from "./db.js";
import { WorkspaceError, WorkspaceService, redactGitUrl } from "./workspaces.js";

function createService(callWorker: (pathName: string, init?: RequestInit) => Promise<WorkspaceVerifyResult>) {
  const db = openDatabase(":memory:");
  const service = new WorkspaceService(db, callWorker as never);
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
  ...overrides,
});

describe("workspace service", () => {
  it("registers a workspace through the worker and lists it per owner", async () => {
    const { service } = createService(async () => verifyOk());
    const workspace = await service.register("owner-a", "pi_go");

    expect(workspace.name).toBe("pi_go");
    expect(workspace.git).toEqual({ branch: "main", head: "abc1234", dirty: false });
    expect(workspace.status).toBe("active");
    expect(service.list(["owner-a"])).toHaveLength(1);
    expect(service.list(["owner-b"])).toHaveLength(0);
    expect(() => service.get(["owner-b"], workspace.id)).toThrow(WorkspaceError);
  });

  it("rejects invalid paths and surfaces worker error codes", async () => {
    const { service } = createService(async () => ({ ok: false, code: "WORKSPACE_OUTSIDE_ROOT", error: "outside" }));
    const error = await service.register("owner-a", "../etc").catch((cause: WorkspaceError) => cause);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("WORKSPACE_OUTSIDE_ROOT");
    expect((error as WorkspaceError).status).toBe(422);
  });

  it("updates an existing workspace instead of duplicating a name", async () => {
    const { service } = createService(async () => verifyOk());
    const first = await service.register("owner-a", "pi_go");
    const second = await service.register("owner-a", "pi_go");
    expect(second.id).toBe(first.id);
    expect(service.list(["owner-a"])).toHaveLength(1);
  });

  it("refreshes git metadata and marks invalid workspaces", async () => {
    let mode: "ok" | "missing" = "ok";
    const { service } = createService(async () => mode === "ok"
      ? verifyOk({ head: "def5678", dirty: true })
      : { ok: false, code: "WORKSPACE_INVALID", error: "Workspace path does not exist" });

    const workspace = await service.register("owner-a", "pi_go");
    const refreshed = await service.refresh(["owner-a"], workspace.id);
    expect(refreshed.git).toEqual({ branch: "main", head: "def5678", dirty: true });

    mode = "missing";
    await expect(service.refresh(["owner-a"], workspace.id)).rejects.toThrow(WorkspaceError);
    expect(service.get(["owner-a"], workspace.id).status).toBe("invalid");
  });

  it("patches defaults and unregisters without deleting runs", async () => {
    const { service } = createService(async () => verifyOk());
    const workspace = await service.register("owner-a", "pi_go");

    const patched = service.patch(["owner-a"], workspace.id, { defaultChecks: ["npm test"], defaultBranch: "develop" });
    expect(patched.defaultChecks).toEqual(["npm test"]);
    expect(patched.defaultBranch).toBe("develop");

    service.unregister(["owner-a"], workspace.id);
    expect(service.list(["owner-a"])).toHaveLength(0);
  });

  it("validates clone names before calling the worker", async () => {
    let called = 0;
    const { service } = createService(async () => {
      called += 1;
      return verifyOk();
    });
    await expect(service.clone("owner-a", "https://example.com/repo.git", "../evil")).rejects.toThrow(WorkspaceError);
    expect(called).toBe(0);
  });

  it("redacts credentials embedded in git urls", () => {
    expect(redactGitUrl("https://user:token@example.com/repo.git")).toBe("https://***@example.com/repo.git");
    expect(redactGitUrl("https://example.com/repo.git")).toBe("https://example.com/repo.git");
  });
});
