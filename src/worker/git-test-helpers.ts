import { spawnSync } from "node:child_process";

/**
 * Real-git tests are skipped when the binary is unavailable (minimal CI images)
 * so the unit suite stays runnable everywhere; when git exists they exercise the
 * production materializer end to end.
 */
export const gitAvailable = (() => {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
})();
