import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { prepareSandboxStateDirectory, sandboxStateDirectory } from "./sandbox.js";
import { PiRetryPolicyError, writeManagedPiJson } from "./pi-retry-policy.js";

/** Keep process-mode policy/session writes in the same per-run state as Docker. */
export async function prepareProcessPiState(input: {
  worktree: string;
  statePath?: string;
  provider: string;
  apiKeyEnvironmentName: string;
  modelsFile: string;
}): Promise<string> {
  try {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(input.apiKeyEnvironmentName)) throw new PiRetryPolicyError();
    const state = sandboxStateDirectory(input.worktree, input.statePath);
    const agentDirectory = path.join(state, "agent");
    const destination = path.join(agentDirectory, "models.json");
    if (path.resolve(input.modelsFile) === destination) throw new PiRetryPolicyError();
    const source = await realpath(input.modelsFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return path.resolve(input.modelsFile);
    });
    const resolvedDestination = await realpath(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return destination;
    });
    if (source === resolvedDestination) throw new PiRetryPolicyError();
    await prepareSandboxStateDirectory(state);
    let selected: Record<string, unknown> | undefined;
    try {
      if ((await stat(input.modelsFile)).size > 2 * 1024 * 1024) throw new PiRetryPolicyError();
      const raw: unknown = JSON.parse(await readFile(input.modelsFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("providers" in raw)
        || !raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) throw new PiRetryPolicyError();
      const candidate = (raw.providers as Record<string, unknown>)[input.provider];
      if (candidate !== undefined) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new PiRetryPolicyError();
        selected = { ...candidate, apiKey: `\${${input.apiKeyEnvironmentName}}` };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeManagedPiJson(destination, { providers: selected ? { [input.provider]: selected } : {} });
    return agentDirectory;
  } catch { throw new PiRetryPolicyError(); }
}
