import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacePathError, resolveInsideRoot, sanitizeRelativePath, sanitizeWorkspaceName, validateCloneUrl } from "./workspace-paths.js";

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
