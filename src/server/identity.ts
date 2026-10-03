import { randomBytes } from "node:crypto";
import { newId, type Database } from "./db.js";

export type IdentityInput = {
  issuer: string;
  subject: string;
  email: string;
  identityProvider: string;
  legacyOwnerId: string;
};

export type UserRecord = {
  id: string;
  email: string;
  role: "user" | "admin";
  status: string;
  legacyOwnerId: string | null;
  createdAt: string;
  updatedAt: string;
};

type UserRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  legacy_owner_id: string | null;
  created_at: string;
  updated_at: string;
};

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    status: row.status,
    legacyOwnerId: row.legacy_owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps external identities (Cloudflare Access subject, development header, ...)
 * onto stable internal user ids. Existing runs and credentials created before
 * this mapping existed are keyed by `legacy_owner_id`, so both keys must be
 * used when reading user-scoped resources during the transition (see ownerKeys).
 */
export class IdentityService {
  constructor(private readonly db: Database) {}

  resolve(input: IdentityInput): UserRecord {
    const now = new Date().toISOString();
    const email = input.email.trim().toLowerCase();

    const known = this.db
      .prepare("SELECT user_id FROM user_identities WHERE issuer = ? AND subject = ?")
      .get(input.issuer, input.subject) as { user_id: string } | undefined;
    if (known) {
      this.db
        .prepare("UPDATE user_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?")
        .run(now, input.issuer, input.subject);
      this.db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?").run(email, now, known.user_id);
      return this.getUser(known.user_id)!;
    }

    this.db.exec("BEGIN");
    try {
      const byEmail = email
        ? this.db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(email) as UserRow | undefined
        : undefined;
      const byLegacy = !byEmail && input.legacyOwnerId
        ? this.db.prepare("SELECT * FROM users WHERE legacy_owner_id = ?").get(input.legacyOwnerId) as UserRow | undefined
        : undefined;
      const existing = byEmail ?? byLegacy;

      let userId: string;
      if (existing) {
        userId = existing.id;
        const adoptLegacy = input.legacyOwnerId
          && !existing.legacy_owner_id
          && !this.db.prepare("SELECT id FROM users WHERE legacy_owner_id = ?").get(input.legacyOwnerId);
        this.db
          .prepare("UPDATE users SET email = ?, legacy_owner_id = ?, updated_at = ? WHERE id = ?")
          .run(email || existing.email, adoptLegacy ? input.legacyOwnerId : existing.legacy_owner_id, now, userId);
      } else {
        userId = randomBytes(32).toString("hex");
        this.db
          .prepare("INSERT INTO users (id, email, role, status, legacy_owner_id, created_at, updated_at) VALUES (?, ?, 'user', 'active', ?, ?, ?)")
          .run(userId, email, input.legacyOwnerId || null, now, now);
      }

      this.db
        .prepare("INSERT INTO user_identities (id, user_id, issuer, subject, identity_provider, last_login_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(newId("ident"), userId, input.issuer, input.subject, input.identityProvider, now, now);
      this.db.exec("COMMIT");
      return this.getUser(userId)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  userCount() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return Number(row.count);
  }
}

/** Resource owner keys for a user: internal id first, legacy id (pre-migration data) second. */
export function ownerKeys(user: UserRecord): string[] {
  return user.legacyOwnerId ? [user.id, user.legacyOwnerId] : [user.id];
}
