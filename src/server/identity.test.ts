import { describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { IdentityService, ownerKeys } from "./identity.js";
import { createTestDb } from "./test-db.js";

async function service() {
  return new IdentityService(await createTestDb());
}

const cloudflare = (subject: string, email: string, legacyOwnerId = `legacy-${subject}`) => ({
  issuer: "https://team.cloudflareaccess.com",
  subject,
  email,
  identityProvider: "cloudflare-access",
  legacyOwnerId,
});

describe("identity service", () => {
  it("creates a stable internal user and reuses it for the same identity", async () => {
    const identities = await service();
    const first = await identities.resolve(cloudflare("sub-1", "A@Example.com"));
    const second = await identities.resolve(cloudflare("sub-1", "a@example.com"));

    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(first.email).toBe("a@example.com");
    expect(await identities.userCount()).toBe(1);
  });

  it("links a new subject to the existing user by email (IdP switch)", async () => {
    const identities = await service();
    const original = await identities.resolve(cloudflare("sub-1", "user@example.com"));
    const afterSwitch = await identities.resolve({
      issuer: "https://team.cloudflareaccess.com",
      subject: "sub-2-otp",
      email: "user@example.com",
      identityProvider: "cloudflare-access",
      legacyOwnerId: "legacy-sub-2",
    });

    expect(afterSwitch.id).toBe(original.id);
    expect(await identities.userCount()).toBe(1);
  });

  it("adopts the legacy owner key so pre-migration runs stay visible", async () => {
    const identities = await service();
    const user = await identities.resolve(cloudflare("sub-9", "late@example.com", "abc123legacy"));
    expect(user.legacyOwnerId).toBe("abc123legacy");
    expect(ownerKeys(user)).toEqual([user.id, "abc123legacy"]);
  });

  it("keeps owners isolated when emails differ", async () => {
    const identities = await service();
    const a = await identities.resolve(cloudflare("sub-a", "a@example.com"));
    const b = await identities.resolve(cloudflare("sub-b", "b@example.com"));
    expect(a.id).not.toBe(b.id);
    expect(ownerKeys(a)).not.toContain(b.id);
  });

  it("retries when a concurrent first login already created the user (23505)", async () => {
    const db = await createTestDb();
    const identities = new IdentityService(db);
    const racedId = "r".repeat(64);
    const legacy = "abc123legacy";
    const now = new Date().toISOString();

    let fired = false;
    const shimmed: Db = {
      query: (text, params) => db.query(text, params),
      withTransaction: (fn) =>
        db.withTransaction((tx) =>
          fn({
            query: async (text, params) => {
              if (!fired && text.startsWith("INSERT INTO users")) {
                fired = true;
                // simulate the competing request committing its user row first
                await db.query(
                  "INSERT INTO users (id, email, role, status, legacy_owner_id, created_at, updated_at) VALUES ($1, $2, 'user', 'active', $3, $4, $5)",
                  [racedId, "other@example.com", legacy, now, now],
                );
                const error = new Error('duplicate key value violates unique constraint "users_legacy_owner_id_key"') as Error & { code?: string };
                error.code = "23505";
                throw error;
              }
              return tx.query(text, params);
            },
            withTransaction: (nested) => nested(tx),
          }),
        ),
    };

    const user = await new IdentityService(shimmed).resolve({
      issuer: "https://team.cloudflareaccess.com",
      subject: "sub-race",
      email: "racer@example.com",
      identityProvider: "cloudflare-access",
      legacyOwnerId: legacy,
    });

    expect(user.id).toBe(racedId);
    expect(user.email).toBe("racer@example.com");
    expect(await identities.userCount()).toBe(1);
  });
});
