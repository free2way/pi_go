import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialVault } from "./credential-vault.js";

describe("CredentialVault", () => {
  it("encrypts keys at rest and separates users", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-vault-"));
    const file = path.join(directory, "credentials.json");
    const vault = new CredentialVault(file, Buffer.alloc(32, 7).toString("base64"));
    await vault.init();
    await vault.set("owner-a", { developer: "dev-secret-value", reviewer: "review-secret-value" });

    expect(vault.get("owner-a")).toEqual({ developer: "dev-secret-value", reviewer: "review-secret-value" });
    expect(vault.get("owner-b")).toBeUndefined();
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain("dev-secret-value");
    expect(stored).not.toContain("review-secret-value");
  });

  it("does not decrypt ciphertext under another user identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-vault-"));
    const file = path.join(directory, "credentials.json");
    const secret = Buffer.alloc(32, 9).toString("base64");
    const vault = new CredentialVault(file, secret);
    await vault.init();
    await vault.set("owner-a", { developer: "dev-secret-value", reviewer: "review-secret-value" });
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.users["owner-b"] = raw.users["owner-a"];
    await writeFileForTest(file, raw);
    const reloaded = new CredentialVault(file, secret);
    await reloaded.init();
    expect(() => reloaded.get("owner-b")).toThrow();
  });

  it("keeps persisting after a transient write failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-vault-"));
    const file = path.join(directory, "credentials.json");
    const vault = new CredentialVault(file, Buffer.alloc(32, 3).toString("base64"));
    await vault.init();
    await vault.set("owner-a", { developer: "first-dev-secret", reviewer: "first-review-secret" });

    await chmod(directory, 0o555);
    try {
      await expect(vault.set("owner-a", { developer: "second-dev-secret" })).rejects.toThrow();
    } finally {
      await chmod(directory, 0o755);
    }

    await vault.set("owner-a", { reviewer: "second-review-secret" });
    expect(vault.get("owner-a")).toEqual({ developer: "second-dev-secret", reviewer: "second-review-secret" });
    const persisted = JSON.parse(await readFile(file, "utf8")) as { users: Record<string, unknown> };
    expect(persisted.users["owner-a"]).toBeDefined();
  });
});

async function writeFileForTest(file: string, data: unknown) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, JSON.stringify(data), "utf8");
}
