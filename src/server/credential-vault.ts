import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CredentialStatus } from "../shared/types.js";

export type ModelCredentials = {
  developer: string;
  reviewer: string;
};

type EncryptedValue = {
  iv: string;
  ciphertext: string;
  tag: string;
};

type UserCredentialRecord = {
  developer?: EncryptedValue;
  reviewer?: EncryptedValue;
  updatedAt: string;
};

type VaultFile = {
  version: 1;
  users: Record<string, UserCredentialRecord>;
};

const roles = ["developer", "reviewer"] as const;
type CredentialRole = (typeof roles)[number];

export class CredentialVault {
  private readonly key: Buffer;
  private data: VaultFile = { version: 1, users: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, secret: string) {
    this.key = Buffer.from(secret, "base64");
    if (this.key.length !== 32) throw new Error("PI_VAULT_SECRET must be a base64-encoded 32-byte key");
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as VaultFile;
      if (parsed.version !== 1 || !parsed.users) throw new Error("Unsupported credential vault format");
      this.data = parsed;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  status(userId: string): CredentialStatus {
    const record = this.data.users[userId];
    return {
      developerConfigured: Boolean(record?.developer),
      reviewerConfigured: Boolean(record?.reviewer),
      updatedAt: record?.updatedAt ?? null,
    };
  }

  get(userId: string): ModelCredentials | undefined {
    const record = this.data.users[userId];
    if (!record?.developer || !record.reviewer) return undefined;
    return {
      developer: this.decrypt(userId, "developer", record.developer),
      reviewer: this.decrypt(userId, "reviewer", record.reviewer),
    };
  }

  async set(userId: string, input: Partial<ModelCredentials>) {
    const current = this.data.users[userId] ?? { updatedAt: new Date().toISOString() };
    for (const role of roles) {
      const value = input[role];
      if (value) current[role] = this.encrypt(userId, role, value);
    }
    current.updatedAt = new Date().toISOString();
    this.data.users[userId] = current;
    await this.persist();
    return this.status(userId);
  }

  async delete(userId: string) {
    delete this.data.users[userId];
    await this.persist();
  }

  private encrypt(userId: string, role: CredentialRole, value: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`pigo:v1:${userId}:${role}`));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  private decrypt(userId: string, role: CredentialRole, value: EncryptedValue) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(`pigo:v1:${userId}:${role}`));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private persist() {
    const attempt = this.writeQueue
      .catch((error) => {
        console.error("[vault] previous persist failed; continuing with the next write", error);
      })
      .then(async () => {
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, JSON.stringify(this.data), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filePath);
        await chmod(this.filePath, 0o600);
      });
    this.writeQueue = attempt;
    return attempt;
  }
}
