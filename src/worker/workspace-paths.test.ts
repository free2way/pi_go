import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacePathError, prepareWorkspaceDirectory, resolveInsideRoot, sanitizeRelativePath, sanitizeWorkspaceName, validateCloneUrl } from "./workspace-paths.js";

describe("workspace paths", () => {
  it("sanitizes workspace names", () => {
    expect(sanitizeWorkspaceName("my-repo_1.0")).toBe("my-repo_1.0");
    expect(sanitizeWorkspaceName("..")).toBeUndefined();
    expect(sanitizeWorkspaceName("a/b")).toBeUndefined();
    expect(sanitizeWorkspaceName("bad name")).toBeUndefined();
    expect(sanitizeWorkspaceName("x".repeat(81))).toBeUndefined();
  });

  it("validates clone URLs", () => {
    expect(validateCloneUrl("https://github.com/example/repo.git")).toBeUndefined();
    expect(validateCloneUrl("git@github.com:example/repo.git")).toBeUndefined();
    expect(validateCloneUrl("ssh://git@github.com/example/repo.git")).toBeUndefined();
    expect(validateCloneUrl("file:///etc/passwd")).toBeTruthy();
    expect(validateCloneUrl("ftp://example.com/repo")).toBeTruthy();
    expect(validateCloneUrl("")).toBeTruthy();
  });

  it("sanitizes relative paths and rejects escapes", () => {
    expect(sanitizeRelativePath("pi_go")).toBe("pi_go");
    expect(sanitizeRelativePath("group/repo")).toBe("group/repo");
    expect(sanitizeRelativePath("../etc")).toBeUndefined();
    expect(sanitizeRelativePath("a/../b")).toBeUndefined();
    expect(sanitizeRelativePath("/abs/path")).toBeUndefined();
    expect(sanitizeRelativePath("a//b")).toBeUndefined();
  });

  it("resolves paths inside the allowed root and blocks symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pigo-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "pigo-outside-"));
    await mkdir(path.join(root, "repo"));
    await writeFile(path.join(outside, "secret.txt"), "nope");

    await expect(resolveInsideRoot(root, "repo")).resolves.toBe(await resolveInsideRoot(root, "repo"));
    await expect(resolveInsideRoot(root, "missing")).rejects.toThrow(WorkspacePathError);

    await symlink(outside, path.join(root, "escape"));
    const error = await resolveInsideRoot(root, "escape").catch((cause: WorkspacePathError) => cause);
    expect(error).toBeInstanceOf(WorkspacePathError);
    expect((error as WorkspacePathError).code).toBe("WORKSPACE_OUTSIDE_ROOT");
  });
});

describe("prepareWorkspaceDirectory", () => {
  const freshRoot = () => mkdtemp(path.join(tmpdir(), "pigo-create-"));

  it("creates a missing workspace directory inside the root", async () => {
    const root = await freshRoot();
    const result = await prepareWorkspaceDirectory(root, "new-repo");

    expect(result.created).toBe(true);
    expect(result.relativePath).toBe("new-repo");
    expect((await stat(result.canonicalPath)).isDirectory()).toBe(true);
  });

  it("creates the projects root when the volume is empty and stays idempotent", async () => {
    const base = await freshRoot();
    const root = path.join(base, "projects"); // does not exist yet

    const first = await prepareWorkspaceDirectory(root, "repo");
    expect(first.created).toBe(true);

    const second = await prepareWorkspaceDirectory(root, "repo");
    expect(second.created).toBe(false);
    expect(second.canonicalPath).toBe(first.canonicalPath);
  });

  it("rejects invalid names and path escapes before touching the filesystem", async () => {
    const root = await freshRoot();

    await expect(prepareWorkspaceDirectory(root, "../evil")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await expect(prepareWorkspaceDirectory(root, "..")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await expect(prepareWorkspaceDirectory(root, "a/b")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await expect(prepareWorkspaceDirectory(root, "bad name")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
  });

  it("refuses to claim an existing directory that already contains other content", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, "taken"));
    await writeFile(path.join(root, "taken", "README.md"), "existing project");

    await expect(prepareWorkspaceDirectory(root, "taken")).rejects.toMatchObject({ code: "WORKSPACE_EXISTS" });
  });

  it("reuses an already-initialized empty git workspace", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, "bare"));
    await mkdir(path.join(root, "bare", ".git"));

    const result = await prepareWorkspaceDirectory(root, "bare");
    expect(result.created).toBe(false);
  });

  it("refuses a symlink entry pointing outside the root", async () => {
    const root = await freshRoot();
    const outside = await freshRoot();
    await symlink(outside, path.join(root, "link"));

    await expect(prepareWorkspaceDirectory(root, "link")).rejects.toMatchObject({ code: "WORKSPACE_EXISTS" });
  });
});
