import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialVault } from "./credential-vault.js";

const secretFor = (byte: number) => Buffer.alloc(32, byte).toString("base64");

async function vaultFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "pigo-vault-"));
  return path.join(directory, "credentials.json");
}

describe("CredentialVault", () => {
  it("encrypts per-provider keys at rest, masks them, and separates users", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault(file, secretFor(7));
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });
    await vault.set("owner-a", { provider: "openai-proxy", apiKey: "review-secret-value" });

    expect(vault.get("owner-a", "deepseek")).toBe("dev-secret-value");
    expect(vault.get("owner-a", "openai-proxy")).toBe("review-secret-value");
    expect(vault.get("owner-b", "deepseek")).toBeUndefined();

    const status = vault.status("owner-a");
    expect(status.developerConfigured).toBe(true);
    expect(status.reviewerConfigured).toBe(true);
    expect(status.providers.map((item) => item.provider).sort()).toEqual(["deepseek", "openai-proxy"]);
    expect(status.providers.find((item) => item.provider === "deepseek")?.masked).toBe("••••••alue");

    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain("dev-secret-value");
    expect(stored).not.toContain("review-secret-value");
  });

  it("does not decrypt ciphertext under another user identity", async () => {
    const file = await vaultFile();
    const secret = secretFor(9);
    const vault = new CredentialVault(file, secret);
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });

    const raw = JSON.parse(await readFile(file, "utf8")) as { users: Record<string, unknown> };
    raw.users["owner-b"] = raw.users["owner-a"];
    await writeFile(file, JSON.stringify(raw), "utf8");

    const reloaded = new CredentialVault(file, secret);
    await reloaded.init();
    expect(() => reloaded.get("owner-b", "deepseek")).toThrow();
  });

  it("uses a random IV and an authentication tag per write (AT-SEC-002)", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault(file, secretFor(13));
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });
    type Stored = { users: Record<string, { providers: Record<string, { apiKey: { iv: string; tag: string; ciphertext: string } }> }> };
    const first = JSON.parse(await readFile(file, "utf8")) as Stored;
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });
    const second = JSON.parse(await readFile(file, "utf8")) as Stored;

    const before = first.users["owner-a"].providers.deepseek.apiKey;
    const after = second.users["owner-a"].providers.deepseek.apiKey;
    expect(before.iv).not.toBe(after.iv);
    expect(before.ciphertext).not.toBe(after.ciphertext);
    expect(Buffer.from(after.iv, "base64").length).toBe(12);
    expect(Buffer.from(after.tag, "base64").length).toBe(16);
    expect(vault.get("owner-a", "deepseek")).toBe("dev-secret-value");
  });

  it("rejects tampered ciphertext (GCM authentication)", async () => {
    const file = await vaultFile();
    const secret = secretFor(17);
    const vault = new CredentialVault(file, secret);
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });

    const raw = JSON.parse(await readFile(file, "utf8")) as { users: Record<string, { providers: Record<string, { apiKey: { ciphertext: string } }> }> };
    const record = raw.users["owner-a"].providers.deepseek.apiKey;
    const bytes = Buffer.from(record.ciphertext, "base64");
    bytes[0] ^= 0xff;
    record.ciphertext = bytes.toString("base64");
    await writeFile(file, JSON.stringify(raw), "utf8");

    const reloaded = new CredentialVault(file, secret);
    await reloaded.init();
    expect(() => reloaded.get("owner-a", "deepseek")).toThrow();
  });

  it("migrates the legacy role-based vault to per-provider records", async () => {
    const file = await vaultFile();
    const secret = secretFor(11);
    const key = Buffer.from(secret, "base64");
    const encryptLegacy = (userId: string, role: "developer" | "reviewer", value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`pigo:v1:${userId}:${role}`));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    };
    const legacy = {
      version: 1,
      users: {
        "owner-a": {
          developer: encryptLegacy("owner-a", "developer", "legacy-dev-key"),
          reviewer: encryptLegacy("owner-a", "reviewer", "legacy-rev-key"),
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    await writeFile(file, JSON.stringify(legacy), "utf8");

    const vault = new CredentialVault(file, secret, { developer: "deepseek", reviewer: "openai-proxy" });
    await vault.init();
    expect(vault.get("owner-a", "deepseek")).toBe("legacy-dev-key");
    expect(vault.get("owner-a", "openai-proxy")).toBe("legacy-rev-key");

    const migrated = JSON.parse(await readFile(file, "utf8")) as { version: number; users: Record<string, { providers: Record<string, unknown> }> };
    expect(migrated.version).toBe(2);
    expect(Object.keys(migrated.users["owner-a"].providers).sort()).toEqual(["deepseek", "openai-proxy"]);
    expect(JSON.stringify(migrated)).not.toContain("legacy-dev-key");
  });

  it("tracks configured vs verified credentials (AT-MODEL-004)", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault(file, secretFor(21));
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });

    const before = vault.providerAvailability("owner-a");
    expect(before).toEqual([{ provider: "deepseek", configured: true, verifiedAt: null, verifiedModels: null }]);
    expect(vault.status("owner-a").providers[0].verifiedAt).toBeNull();

    await vault.markVerified("owner-a", "deepseek", ["deepseek-chat"]);
    const after = vault.providerAvailability("owner-a");
    expect(after[0].verifiedAt).not.toBeNull();
    expect(after[0].verifiedModels).toEqual(["deepseek-chat"]);
    expect(vault.status("owner-a").providers[0].verifiedModels).toEqual(["deepseek-chat"]);

    // Rotating the key resets verification until the new key is probed again.
    await vault.set("owner-a", { provider: "deepseek", apiKey: "rotated-secret-value" });
    expect(vault.providerAvailability("owner-a")[0].verifiedAt).toBeNull();
  });

  it("keeps persisting after a transient write failure", async () => {
    const file = await vaultFile();
    const directory = path.dirname(file);
    const vault = new CredentialVault(file, secretFor(3));
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "first-dev-secret" });

    await chmod(directory, 0o555);
    try {
      await expect(vault.set("owner-a", { provider: "deepseek", apiKey: "second-dev-secret" })).rejects.toThrow();
    } finally {
      await chmod(directory, 0o755);
    }

    await vault.set("owner-a", { provider: "openai-proxy", apiKey: "review-secret" });
    expect(vault.get("owner-a", "deepseek")).toBe("second-dev-secret");
    expect(vault.get("owner-a", "openai-proxy")).toBe("review-secret");
  });

  it("lists only unverified credentials for the startup pass, across users (AUD-08 cutover)", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault(file, secretFor(31));
    await vault.init();
    await vault.set("owner-a", { provider: "deepseek", apiKey: "dev-secret-value" });
    await vault.set("owner-a", { provider: "openai-proxy", apiKey: "review-secret-value" });
    await vault.set("owner-b", { provider: "anthropic", apiKey: "claude-secret-value" });
    await vault.markVerified("owner-a", "deepseek", ["deepseek-chat"]);

    const pending = vault.pendingVerifications();
    expect(pending.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
      { userId: "owner-b", provider: "anthropic" },
      { userId: "owner-a", provider: "openai-proxy" },
    ]);
    // The listing never carries key material.
    expect(JSON.stringify(pending)).not.toContain("secret-value");
  });

  it("marks a credential verified for all models when the probe is disabled (AUD-08 cutover)", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault(file, secretFor(37));
    await vault.init();
    await vault.set("owner-a", { provider: "openai-proxy", apiKey: "review-secret-value" });

    await vault.markVerified("owner-a", "openai-proxy", null);
    const availability = vault.providerAvailability("owner-a")[0];
    expect(availability.verifiedAt).not.toBeNull();
    // null = "no per-model restriction" for the operator-asserted path.
    expect(availability.verifiedModels).toBeNull();
    expect(vault.pendingVerifications()).toEqual([]);
  });
});
