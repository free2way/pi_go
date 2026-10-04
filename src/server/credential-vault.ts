import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CredentialStatus,
  CredentialVerificationState,
  ProviderAvailability,
  ProviderModelCapability,
} from "../shared/types.js";

/** Credentials the worker receives for a single job (resolved from the run's pinned models). */
export type ModelCredentials = {
  developer: string;
  reviewer: string;
};

type EncryptedValue = {
  iv: string;
  ciphertext: string;
  tag: string;
};

type ProviderRecord = {
  apiKey: EncryptedValue;
  updatedAt: string;
  verifiedAt: string | null;
  /** AUD-08 / AT-MODEL-001: provider-reported model ids from the last probe. */
  verifiedModels: string[] | null;
  /**
   * AUD-08: how this credential was accepted. Optional for backward
   * compatibility; derived from `verifiedAt` when absent (`live` if set,
   * otherwise `unchecked`). `operator_asserted` is only written when probing is
   * disabled — it never fabricates `verifiedAt`.
   */
  verification?: CredentialVerificationState;
  /** AUD-08 / AT-MODEL-001: provider-reported per-model capabilities, by model. */
  capabilities?: Record<string, ProviderModelCapability> | null;
};

type UserRecord = {
  providers: Record<string, ProviderRecord>;
  updatedAt: string;
};

type VaultFile = {
  version: 2;
  users: Record<string, UserRecord>;
};

/** Pre-MODEL layout: one slot per role, AAD bound to the role. Migrated on first load. */
type LegacyUserRecord = {
  developer?: EncryptedValue;
  reviewer?: EncryptedValue;
  updatedAt: string;
};

type LegacyVaultFile = {
  version: 1;
  users: Record<string, LegacyUserRecord>;
};

function mask(apiKey: string) {
  const tail = apiKey.slice(-4);
  return `••••••${tail}`;
}

/** Derives the verification state, tolerating records written before it existed. */
function verificationState(record: Pick<ProviderRecord, "verifiedAt" | "verification">): CredentialVerificationState {
  if (record.verification === "operator_asserted") return "operator_asserted";
  if (record.verification === "live" || record.verifiedAt !== null) return "live";
  return "unchecked";
}

/** Human-readable label; asserted credentials must never read as verified. */
export function verificationLabel(state: CredentialVerificationState): string {
  if (state === "live") return "已验证";
  if (state === "operator_asserted") return "未校验（操作者断言）";
  return "未校验";
}

export class CredentialVault {
  private readonly key: Buffer;
  private data: VaultFile = { version: 2, users: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    secret: string,
    /** Providers used by the legacy role-based vault, for one-time migration. */
    private readonly legacyProviders: { developer: string; reviewer: string } = { developer: "deepseek", reviewer: "openai-proxy" },
  ) {
    this.key = Buffer.from(secret, "base64");
    if (this.key.length !== 32) throw new Error("PI_VAULT_SECRET must be a base64-encoded 32-byte key");
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as VaultFile | LegacyVaultFile;
      if (parsed.version === 1 && parsed.users) {
        this.data = this.migrateLegacy(parsed);
        await this.persist();
      } else if (parsed.version === 2 && parsed.users) {
        this.data = parsed;
      } else {
        throw new Error("Unsupported credential vault format");
      }
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  configuredProviders(userId: string): string[] {
    return Object.keys(this.data.users[userId]?.providers ?? {});
  }

  /**
   * AUD-08 / AT-MODEL-004: configured vs. verified state per provider, without
   * decrypting the key. `verifiedAt === null` means the credential has not been
   * live-verified and must not be treated as available.
   */
  providerAvailability(userId: string): ProviderAvailability[] {
    const record = this.data.users[userId];
    if (!record) return [];
    return Object.entries(record.providers).map(([provider, value]) => {
      const verification = verificationState(value);
      return {
        provider,
        configured: true,
        verifiedAt: value.verifiedAt ?? null,
        verifiedModels: value.verifiedModels ?? null,
        verification,
        asserted: verification === "operator_asserted",
        verified: verification === "live",
        capabilities: value.capabilities ?? null,
      };
    });
  }

  status(userId: string): CredentialStatus {
    const record = this.data.users[userId];
    const providers = Object.entries(record?.providers ?? {}).map(([provider, value]) => {
      const verification = verificationState(value);
      return {
        provider,
        configured: true,
        masked: mask(this.decrypt(userId, provider, value.apiKey)),
        updatedAt: value.updatedAt,
        verifiedAt: value.verifiedAt ?? null,
        verifiedModels: value.verifiedModels ?? null,
        verification,
        asserted: verification === "operator_asserted",
        verificationLabel: verificationLabel(verification),
        capabilities: value.capabilities ?? null,
      };
    });
    const configured = new Set(providers.map((item) => item.provider));
    return {
      developerConfigured: configured.has(this.legacyProviders.developer),
      reviewerConfigured: configured.has(this.legacyProviders.reviewer),
      updatedAt: record?.updatedAt ?? null,
      providers,
    };
  }

  get(userId: string, provider: string): string | undefined {
    const record = this.data.users[userId]?.providers?.[provider];
    if (!record) return undefined;
    return this.decrypt(userId, provider, record.apiKey);
  }

  async set(userId: string, input: { provider: string; apiKey: string }) {
    const now = new Date().toISOString();
    const current = this.data.users[userId] ?? { providers: {}, updatedAt: now };
    current.providers[input.provider] = {
      apiKey: this.encrypt(userId, input.provider, input.apiKey),
      updatedAt: now,
      verifiedAt: null,
      verifiedModels: null,
      verification: "unchecked",
      capabilities: null,
    };
    current.updatedAt = now;
    this.data.users[userId] = current;
    await this.persist();
    return this.status(userId);
  }

  /**
   * AUD-08 / AT-MODEL-004: records a successful live probe. `models` is the
   * provider-reported model id list; `null` (or an empty list) means "the
   * credential is valid but no per-model restriction applies", so every model on
   * the provider may be used. `capabilities` are provider-reported per-model
   * capabilities, stored alongside the model ids. Only this path sets
   * `verifiedAt` and `verification: "live"`.
   */
  async markVerified(
    userId: string,
    provider: string,
    models: string[] | null,
    capabilities?: Record<string, ProviderModelCapability> | null,
  ) {
    const record = this.data.users[userId]?.providers?.[provider];
    if (!record) return this.status(userId);
    const now = new Date().toISOString();
    record.verifiedAt = now;
    record.verifiedModels = models === null ? null : models.slice(0, 500);
    record.verification = "live";
    record.capabilities = capabilities && Object.keys(capabilities).length > 0 ? capabilities : null;
    this.data.users[userId].updatedAt = now;
    await this.persist();
    return this.status(userId);
  }

  /**
   * AUD-08: records an operator assertion made when probing is disabled
   * (`PI_MODEL_PROBE_MODE=off`). The credential becomes usable but is NOT
   * live-verified: `verifiedAt` is never fabricated and `verifiedModels` stays
   * `null` (no per-model restriction was observed).
   */
  async markOperatorAsserted(userId: string, provider: string) {
    const record = this.data.users[userId]?.providers?.[provider];
    if (!record) return this.status(userId);
    const now = new Date().toISOString();
    record.verifiedAt = null;
    record.verifiedModels = null;
    record.verification = "operator_asserted";
    record.capabilities = null;
    this.data.users[userId].updatedAt = now;
    await this.persist();
    return this.status(userId);
  }

  /**
   * AUD-08 cutover safety: every stored provider credential that has never been
   * resolved (`unchecked`). Operator-asserted and live-verified credentials are
   * not returned. Used by the bounded startup pass so keys written before live
   * verification existed do not block every real run. Only ids/providers are
   * returned; key material stays inside the vault.
   */
  pendingVerifications(): Array<{ userId: string; provider: string }> {
    const pending: Array<{ userId: string; provider: string }> = [];
    for (const [userId, record] of Object.entries(this.data.users)) {
      for (const [provider, value] of Object.entries(record.providers ?? {})) {
        if (verificationState(value) === "unchecked") pending.push({ userId, provider });
      }
    }
    return pending;
  }

  /** Records a failed/incomplete probe so the credential is shown as unchecked. */
  async markUnverified(userId: string, provider: string) {
    const record = this.data.users[userId]?.providers?.[provider];
    if (!record) return this.status(userId);
    if (verificationState(record) === "unchecked") return this.status(userId);
    record.verifiedAt = null;
    record.verifiedModels = null;
    record.verification = "unchecked";
    record.capabilities = null;
    await this.persist();
    return this.status(userId);
  }

  async delete(userId: string, provider?: string) {
    if (!provider) {
      delete this.data.users[userId];
    } else if (this.data.users[userId]) {
      delete this.data.users[userId].providers[provider];
      this.data.users[userId].updatedAt = new Date().toISOString();
    }
    await this.persist();
  }

  private migrateLegacy(parsed: LegacyVaultFile): VaultFile {
    const users: Record<string, UserRecord> = {};
    for (const [userId, record] of Object.entries(parsed.users)) {
      const providers: Record<string, ProviderRecord> = {};
      const slots: Array<["developer" | "reviewer", EncryptedValue | undefined, string]> = [
        ["developer", record.developer, this.legacyProviders.developer],
        ["reviewer", record.reviewer, this.legacyProviders.reviewer],
      ];
      for (const [role, value, provider] of slots) {
        if (!value) continue;
        const apiKey = this.decryptLegacy(userId, role, value);
        providers[provider] = {
          apiKey: this.encrypt(userId, provider, apiKey),
          updatedAt: record.updatedAt,
          verifiedAt: null,
          verifiedModels: null,
          verification: "unchecked",
          capabilities: null,
        };
      }
      users[userId] = { providers, updatedAt: record.updatedAt };
    }
    return { version: 2, users };
  }

  private encrypt(userId: string, provider: string, value: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`pigo:v2:${userId}:provider:${provider}`));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  private decrypt(userId: string, provider: string, value: EncryptedValue) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(`pigo:v2:${userId}:provider:${provider}`));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private decryptLegacy(userId: string, role: "developer" | "reviewer", value: EncryptedValue) {
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
