import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo, WorkspaceVerifyResult } from "../shared/types.js";
import { runHardenedGit } from "./git-hardening.js";
import {
  prepareWorkspaceDirectory,
  resolveInsideRoot,
  sanitizeWorkspaceName,
  validateCloneUrl,
  WorkspacePathError,
} from "./workspace-paths.js";
import {
  inspectWorkspaceRemote,
  pushWorkspaceBranch,
  WorkspaceScmError,
  type WorkspaceScmCredentialInput,
} from "./workspace-scm.js";

type Git = (
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  options?: { maxOutput?: number; env?: Record<string, string> },
) => Promise<string>;

type SerializeMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface WorkspaceServiceDependencies {
  projectsRoot: string;
  git: Git;
  serializeMutation: SerializeMutation;
  diagnosticMessage: (error: unknown, credentials?: readonly string[], limit?: number) => string;
}

export interface WorkspaceRemoteStatusInput {
  relativePath: string;
  branch: string;
  requiredCommit?: string;
  credential?: WorkspaceScmCredentialInput;
}

export interface PushWorkspaceInput {
  relativePath: string;
  branch: string;
  credential?: WorkspaceScmCredentialInput;
  exportCredentials?: readonly string[];
}

function redactCredentials(value: string) {
  return value.replace(/\/\/[^@/\s]*@/g, "//***@");
}

export function createWorkspaceService(dependencies: WorkspaceServiceDependencies) {
  const { projectsRoot, git, serializeMutation, diagnosticMessage } = dependencies;

  async function resolveProject(relative: string) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid project path");
    }
    const root = await realpath(projectsRoot);
    const candidate = await realpath(path.join(root, relative));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("Project is outside allowed root");
    if ((await git(candidate, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("Project is not a Git repository");
    return candidate;
  }

  async function listProjects(): Promise<ProjectInfo[]> {
    const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    const projects: ProjectInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(projectsRoot, entry.name);
      try {
        await stat(path.join(directory, ".git"));
        projects.push({
          id: entry.name,
          name: entry.name,
          relativePath: entry.name,
          branch: await git(directory, ["branch", "--show-current"]),
          dirty: Boolean(await git(directory, ["status", "--porcelain"])),
        });
      } catch {
        // Ignore non-Git directories.
      }
    }
    return projects;
  }

  async function verifyWorkspace(relativePath: string): Promise<WorkspaceVerifyResult> {
    const candidate = await resolveInsideRoot(projectsRoot, relativePath);
    const isGit = await git(candidate, ["rev-parse", "--is-inside-work-tree"]).then((value) => value === "true").catch(() => false);
    if (!isGit) return { ok: false, code: "WORKSPACE_INVALID", error: "Not a Git repository" };
    const branch = await git(candidate, ["branch", "--show-current"]).catch(() => "");
    const head = await git(candidate, ["rev-parse", "HEAD"]).catch(() => "");
    const status = await git(candidate, ["status", "--porcelain"]).catch(() => "");
    const dirty = Boolean(status);
    const dirtyFiles = status
      ? status.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20).map((line) => line.slice(0, 200))
      : [];
    return {
      ok: true,
      relativePath,
      canonicalPath: candidate,
      name: path.basename(candidate),
      branch: branch || undefined,
      head: head || undefined,
      dirty,
      dirtyFiles,
    };
  }

  async function workspaceScmGit(relativePath: string) {
    const directory = await resolveInsideRoot(projectsRoot, relativePath);
    const isGit = await git(directory, ["rev-parse", "--is-inside-work-tree"]).then((value) => value === "true").catch(() => false);
    if (!isGit) throw new WorkspaceScmError("WORKSPACE_INVALID", "Not a Git repository");
    return {
      directory,
      exec: (args: string[], env?: Record<string, string>) => runHardenedGit({
        cwd: directory,
        args,
        env,
        timeoutMs: 120_000,
        maxOutput: 4 * 1024 * 1024,
        failOnOutputLimit: true,
      }),
    };
  }

  async function workspaceRemoteStatus(input: WorkspaceRemoteStatusInput) {
    const target = await workspaceScmGit(input.relativePath);
    return inspectWorkspaceRemote({
      branch: input.branch,
      requiredCommit: input.requiredCommit,
      credential: input.credential,
      git: target.exec,
    });
  }

  async function pushWorkspace(input: PushWorkspaceInput) {
    const target = await workspaceScmGit(input.relativePath);
    return serializeMutation(async () => {
      const dirty = await git(target.directory, ["status", "--porcelain"]);
      if (dirty) throw new WorkspaceScmError("WORKSPACE_DIRTY", "Workspace has uncommitted changes; push is blocked");
      return pushWorkspaceBranch({
        branch: input.branch,
        credential: input.credential,
        exportCredentials: input.exportCredentials,
        git: target.exec,
      });
    });
  }

  async function cloneWorkspace(url: string, name: string): Promise<WorkspaceVerifyResult> {
    const urlError = validateCloneUrl(url);
    if (urlError) return { ok: false, code: "WORKSPACE_INVALID", error: urlError };
    const cleanName = sanitizeWorkspaceName(name);
    if (!cleanName) return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace name" };
    const root = await realpath(projectsRoot).catch(() => projectsRoot);
    const target = path.join(root, cleanName);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace target" };
    }
    const exists = await stat(target).then(() => true).catch(() => false);
    if (exists) return { ok: false, code: "WORKSPACE_EXISTS", error: `Directory already exists: ${cleanName}` };
    const result = await runHardenedGit({ cwd: root, args: ["clone", "--quiet", url, target], timeoutMs: 600_000 });
    if (result.code !== 0) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      const reason = diagnosticMessage(redactCredentials(`${result.stderr}\n${result.stdout}`.trim()), [], 500);
      return { ok: false, code: "CLONE_FAILED", error: reason || "git clone failed" };
    }
    return verifyWorkspace(cleanName);
  }

  async function createWorkspace(name: string): Promise<WorkspaceVerifyResult> {
    const cleanName = sanitizeWorkspaceName(name);
    if (!cleanName) return { ok: false, code: "WORKSPACE_INVALID", error: "Invalid workspace name" };
    let prepared;
    try {
      prepared = await prepareWorkspaceDirectory(projectsRoot, cleanName);
    } catch (error) {
      if (error instanceof WorkspacePathError) return { ok: false, code: error.code, error: error.message };
      throw error;
    }
    try {
      const isGit = await git(prepared.canonicalPath, ["rev-parse", "--is-inside-work-tree"]).then((value) => value === "true").catch(() => false);
      if (!isGit) await git(prepared.canonicalPath, ["init", "--quiet"]);
    } catch (error) {
      if (prepared.created) await rm(prepared.canonicalPath, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, code: "WORKSPACE_INVALID", error: `Failed to initialize workspace repository: ${diagnosticMessage(error)}` };
    }
    return verifyWorkspace(prepared.relativePath);
  }

  return {
    cloneWorkspace,
    createWorkspace,
    listProjects,
    pushWorkspace,
    resolveProject,
    verifyWorkspace,
    workspaceRemoteStatus,
  };
}
