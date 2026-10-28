import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export class PiRetryPolicyError extends Error {
  constructor() {
    super("Pi settings schema could not be prepared (PI_RETRY_POLICY_INVALID).");
    this.name = "PiRetryPolicyError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Worker retry/budget accounting owns retries; Pi must not multiply attempts. */
export function managedPiSettings(value: unknown): Record<string, unknown> {
  if (!object(value) || (value.retry !== undefined && !object(value.retry))) throw new PiRetryPolicyError();
  const retry = (value.retry ?? {}) as Record<string, unknown>;
  if (retry.provider !== undefined && !object(retry.provider)) throw new PiRetryPolicyError();
  return { ...value, retry: { ...retry, enabled: false, provider: { ...(retry.provider as Record<string, unknown> | undefined), maxRetries: 0 } } };
}

/** Atomic replacement keeps concurrent readers away from partially-written JSON. */
export async function writeManagedPiJson(file: string, value: unknown): Promise<void> {
  let temporary: string | undefined;
  try {
    const parent = await lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new PiRetryPolicyError();
    const text = `${JSON.stringify(value)}\n`;
    let existing: Awaited<ReturnType<typeof open>> | undefined;
    try {
      existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await existing.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new PiRetryPolicyError();
      if (await existing.readFile("utf8") === text) {
        await existing.chmod(0o600);
        return;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { await existing?.close(); }
    temporary = path.join(path.dirname(file), `.pigo-settings-${randomUUID()}.tmp`);
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch { throw new PiRetryPolicyError(); }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
}

/** Only Worker-owned per-run state is passed here, never the operator's home. */
export async function preparePiRetryPolicy(agentDirectory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(agentDirectory, { recursive: true });
    const directory = await lstat(agentDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new PiRetryPolicyError();
    const file = path.join(agentDirectory, "settings.json");
    let settings: unknown = { npmCommand: ["pnpm"] };
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 128 * 1024) throw new PiRetryPolicyError();
      settings = JSON.parse(await handle.readFile("utf8"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeManagedPiJson(file, managedPiSettings(settings));
  } catch { throw new PiRetryPolicyError(); }
  finally { await handle?.close(); }
}
