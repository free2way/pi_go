import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitExec } from "./review-snapshot.js";

/**
 * NEW-03 / AUD-04 / AT-REVIEW-004,012 / AT-GIT-005 / AT-REL-002,003: a stable,
 * content-addressed identity for the run directory.
 *
 * The previous implementation combined `HEAD`, `git stash create` and
 * `status --porcelain`. That is neither complete nor stable: an intent-to-add
 * file's content change did not alter the hash, while identical dirty content
 * produced a different `stash` commit on every run (timestamps), so resumed
 * checks/reviews were reused for the wrong content or needlessly re-run.
 *
 * A scratch `GIT_INDEX_FILE` is populated with the tracked + untracked
 * (non-ignored) content and written as a tree object, exactly like the reviewer
 * snapshot does. The resulting tree OID depends only on file paths, modes and
 * contents.
 */
export async function captureSnapshotHash(exec: GitExec, worktree: string, signal?: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pigo-snapshot-hash-"));
  const indexFile = path.join(scratch, `index-${randomBytes(8).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const head = await exec(worktree, ["rev-parse", "HEAD"], { signal }).then((value) => value.trim()).catch(() => "");
    if (head) await exec(worktree, ["read-tree", head], { signal, env });
    else await exec(worktree, ["read-tree", "--empty"], { signal, env });
    await exec(worktree, ["add", "-A", "--", "."], { signal, env });
    return (await exec(worktree, ["write-tree"], { signal, env })).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
