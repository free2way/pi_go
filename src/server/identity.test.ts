import { describe, expect, it } from "vitest";
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
});
