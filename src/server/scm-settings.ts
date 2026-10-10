import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScmAuthMode, ScmProvider, WorkspaceScmSettingsStatus } from "../shared/types.js";

export interface WorkspaceScmCredential {
  provider: ScmProvider;
  authMode: ScmAuthMode;
  username: string | null;
  token: string | null;
  updatedAt: string;
}

type EncryptedValue = { iv: string; ciphertext: string; tag: string };
type ScmSettingsFile = { version: 1; workspaces: Record<string, EncryptedValue> };

const aadFor = (workspaceId: string) => Buffer.from(`pigo:scm-settings:v1:${workspaceId}`);

export function defaultScmUsername(provider: ScmProvider): string {
  if (provider === "github") return "x-access-token";
  if (provider === "gitlab") return "oauth2";
  return "git";
}

export function scmSettingsStatus(value?: WorkspaceScmCredential): WorkspaceScmSettingsStatus {
  return {
    provider: value?.provider ?? "generic",
    authMode: value?.authMode ?? "server_ssh",
    username: value?.username ?? null,
    tokenConfigured: Boolean(value?.token),
    updatedAt: value?.updatedAt ?? null,
  };
}

/** Workspace-scoped SCM secrets, encrypted independently with workspace-bound AAD. */
export class ScmSettingsStore {
  private readonly key: Buffer;
  private data: ScmSettingsFile = { version: 1, workspaces: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, secret: string) {
    this.key = Buffer.from(secret, "base64");
    if (this.key.length !== 32) throw new Error("PI_VAULT_SECRET must be a base64-encoded 32-byte key");
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ScmSettingsFile;
      if (parsed.version !== 1 || !parsed.workspaces) throw new Error("Unsupported SCM settings format");
      this.data = parsed;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(workspaceId: string): WorkspaceScmCredential | undefined {
    const encrypted = this.data.workspaces[workspaceId];
    return encrypted ? this.decrypt(workspaceId, encrypted) : undefined;
  }

  async set(workspaceId: string, input: {
    provider: ScmProvider;
    authMode: ScmAuthMode;
    username?: string | null;
    token?: string | null;
  }): Promise<WorkspaceScmCredential> {
    const existing = this.get(workspaceId);
    const token = input.token?.trim() || existing?.token || null;
    if (input.authMode === "https_token" && !token) throw new Error("Token is required for HTTPS authentication");
    const value: WorkspaceScmCredential = {
      provider: input.provider,
      authMode: input.authMode,
      username: input.authMode === "https_token"
        ? (input.username?.trim() || existing?.username || defaultScmUsername(input.provider))
        : null,
      token: input.authMode === "https_token" ? token : null,
      updatedAt: new Date().toISOString(),
    };
    this.data.workspaces[workspaceId] = this.encrypt(workspaceId, value);
    await this.persist();
    return value;
  }

  async delete(workspaceId: string) {
    delete this.data.workspaces[workspaceId];
    if (Object.keys(this.data.workspaces).length === 0) {
      this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
        await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      });
      await this.writeQueue;
      return;
    }
    await this.persist();
  }

  private encrypt(workspaceId: string, value: WorkspaceScmCredential): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aadFor(workspaceId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(workspaceId: string, value: EncryptedValue): WorkspaceScmCredential {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(aadFor(workspaceId));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8")) as WorkspaceScmCredential;
  }

  private async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    await this.writeQueue;
  }
}
