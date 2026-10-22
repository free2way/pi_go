import { lstat, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { sandboxStateDirectory } from "./sandbox.js";

export function subAgentStateRoot(worktree: string): string {
  return `${path.resolve(worktree)}.subagent-state`;
}

export function subAgentStateDirectory(worktree: string, taskId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(taskId)) throw new Error("Invalid sub-agent state id");
  return path.join(subAgentStateRoot(worktree), taskId);
}

async function info(file: string) {
  try { return await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertPrivateTree(directory: string): Promise<void> {
  const pending = [directory];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const metadata = await lstat(current);
    if (++entries > 10_000 || metadata.isSymbolicLink()
      || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) {
      throw new Error("Legacy sub-agent state needs manual review; no state was moved");
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(path.join(current, entry));
    }
  }
}

/** Called under the run's workspace lock, before any agent state is mounted. */
export async function migrateLegacySubAgentState(worktree: string): Promise<boolean> {
  const developer = sandboxStateDirectory(worktree);
  const target = subAgentStateRoot(worktree);
  const developerInfo = await info(developer);
  const targetInfo = await info(target);
  for (const metadata of [developerInfo, targetInfo]) {
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
      throw new Error("Agent state root must be a real directory; state is unchanged");
    }
  }
  if (!developerInfo) return false;
  const legacy = path.join(developer, "subagents");
  const legacyInfo = await info(legacy);
  if (!legacyInfo) return false;
  if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink() || targetInfo) {
    throw new Error("Conflicting or unsafe sub-agent state; preserve both trees for manual review");
  }
  await assertPrivateTree(legacy);
  // Preserve session identities and files; never merge or overwrite two trees.
  await rename(legacy, target);
  return true;
}
