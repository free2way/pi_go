import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ReleaseWebhookSettings {
  webhookUrl: string;
  webhookToken: string;
  publicOrigin: string;
  updatedAt: string;
}

export interface ReleaseWebhookSettingsStatus {
  source: "web" | "environment" | "none";
  configured: boolean;
  webhookUrl: string | null;
  tokenConfigured: boolean;
  publicOrigin: string | null;
  updatedAt: string | null;
}

type EncryptedValue = { iv: string; ciphertext: string; tag: string };
type ReleaseSettingsFile = { version: 1; value: EncryptedValue; updatedAt: string };

const AAD = Buffer.from("pigo:release-settings:v1");

/** Global release configuration. The complete payload is encrypted at rest. */
export class ReleaseSettingsStore {
  private readonly key: Buffer;
  private value: ReleaseWebhookSettings | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, secret: string) {
    this.key = Buffer.from(secret, "base64");
    if (this.key.length !== 32) throw new Error("PI_VAULT_SECRET must be a base64-encoded 32-byte key");
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ReleaseSettingsFile;
      if (parsed.version !== 1 || !parsed.value) throw new Error("Unsupported release settings format");
      this.value = this.decrypt(parsed.value);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ReleaseWebhookSettings | undefined {
    return this.value ? { ...this.value } : undefined;
  }

  async set(input: { webhookUrl: string; webhookToken?: string; publicOrigin: string }) {
    const existing = this.value;
    const webhookToken = input.webhookToken?.trim() || existing?.webhookToken;
    if (!webhookToken) throw new Error("Webhook token is required for the first configuration");
    this.value = {
      webhookUrl: input.webhookUrl.trim(),
      webhookToken,
      publicOrigin: input.publicOrigin.trim().replace(/\/$/, ""),
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return this.get()!;
  }

  async delete() {
    this.value = undefined;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
    await this.writeQueue;
  }

  private encrypt(value: ReleaseWebhookSettings): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(value: EncryptedValue): ReleaseWebhookSettings {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8")) as ReleaseWebhookSettings;
  }

  private async persist() {
    const snapshot = this.value;
    if (!snapshot) return;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const file: ReleaseSettingsFile = { version: 1, value: this.encrypt(snapshot), updatedAt: snapshot.updatedAt };
      const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    await this.writeQueue;
  }
}

export function releaseSettingsStatus(input: {
  saved?: ReleaseWebhookSettings;
  environment: { webhookUrl?: string; webhookToken?: string; publicOrigin?: string };
}): ReleaseWebhookSettingsStatus {
  const selected = input.saved ?? (input.environment.webhookUrl
    ? {
        webhookUrl: input.environment.webhookUrl,
        webhookToken: input.environment.webhookToken ?? "",
        publicOrigin: input.environment.publicOrigin ?? "",
        updatedAt: null,
      }
    : undefined);
  if (!selected) return { source: "none", configured: false, webhookUrl: null, tokenConfigured: false, publicOrigin: null, updatedAt: null };
  return {
    source: input.saved ? "web" : "environment",
    configured: Boolean(selected.webhookUrl && selected.webhookToken && selected.publicOrigin),
    webhookUrl: selected.webhookUrl || null,
    tokenConfigured: Boolean(selected.webhookToken),
    publicOrigin: selected.publicOrigin || null,
    updatedAt: selected.updatedAt,
  };
}
