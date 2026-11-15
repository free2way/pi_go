import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceService } from "./workspace-service.js";

async function fixture() {
  const projectsRoot = await mkdtemp(path.join(tmpdir(), "pigo-workspace-service-"));
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const git = vi.fn(async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "branch") return "main";
    if (args[0] === "status") return "";
    if (args[0] === "init") return "";
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  });
  const service = createWorkspaceService({
    projectsRoot,
    git,
    serializeMutation: async (operation) => operation(),
    diagnosticMessage: (error) => error instanceof Error ? error.message : String(error),
  });
  return { calls, git, projectsRoot, service };
}

describe("workspace service", () => {
  it("resolves only Git repositories inside the projects root", async () => {
    const { projectsRoot, service } = await fixture();
    await mkdir(path.join(projectsRoot, "repo"));

    await expect(service.resolveProject("repo")).resolves.toBe(await realpath(path.join(projectsRoot, "repo")));
    await expect(service.resolveProject("../outside")).rejects.toThrow("Invalid project path");
    await expect(service.resolveProject("/absolute")).rejects.toThrow("Invalid project path");
  });

  it("lists Git directories and omits ordinary or hidden directories", async () => {
    const { projectsRoot, service } = await fixture();
    await mkdir(path.join(projectsRoot, "repo", ".git"), { recursive: true });
    await mkdir(path.join(projectsRoot, "ordinary"));
    await mkdir(path.join(projectsRoot, ".hidden", ".git"), { recursive: true });

    await expect(service.listProjects()).resolves.toEqual([{
      id: "repo",
      name: "repo",
      relativePath: "repo",
      branch: "main",
      dirty: false,
    }]);
  });

  it("returns canonical workspace status without leaking entries beyond the dirty-file cap", async () => {
    const { git, projectsRoot, service } = await fixture();
    await mkdir(path.join(projectsRoot, "repo"));
    git.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "b".repeat(40);
      if (args[0] === "branch") return "feature/test";
      if (args[0] === "status") return Array.from({ length: 25 }, (_, index) => ` M file-${index}.ts`).join("\n");
      throw new Error("Unexpected git call");
    });

    const result = await service.verifyWorkspace("repo");
    expect(result).toMatchObject({ ok: true, relativePath: "repo", branch: "feature/test", dirty: true });
    if (!result.ok) throw new Error("expected valid workspace");
    expect(result.dirtyFiles).toHaveLength(20);
    expect(result.canonicalPath).toBe(await realpath(path.join(projectsRoot, "repo")));
  });

  it("creates and initializes an empty workspace through the injected hardened Git facade", async () => {
    const { calls, git, projectsRoot, service } = await fixture();
    let initialized = false;
    git.mockImplementation(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return initialized ? "true" : Promise.reject(new Error("not a repo"));
      if (args[0] === "init") { initialized = true; return ""; }
      if (args[0] === "branch") return "main";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "";
      if (args[0] === "status") return "";
      throw new Error("Unexpected git call");
    });

    const result = await service.createWorkspace("new-repo");
    expect(result).toMatchObject({
      ok: true,
      relativePath: "new-repo",
      canonicalPath: await realpath(path.join(projectsRoot, "new-repo")),
    });
    expect(calls.some(({ args }) => args[0] === "init")).toBe(true);
  });

  it("does not claim or overwrite an existing non-empty directory", async () => {
    const { projectsRoot, service } = await fixture();
    await mkdir(path.join(projectsRoot, "taken"));
    await writeFile(path.join(projectsRoot, "taken", "README.md"), "existing");

    await expect(service.createWorkspace("taken")).resolves.toMatchObject({
      ok: false,
      code: "WORKSPACE_EXISTS",
    });
  });
});
