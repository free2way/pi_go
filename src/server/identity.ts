import { randomBytes } from "node:crypto";
import { newId, type Db } from "./db.js";

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
  constructor(private readonly db: Db) {}

  /** Resolves the pre-migration owner key for a user (used when re-reading credentials). */
  async legacyOwnerFor(userId: string): Promise<string | undefined> {
    const row = (await this.db.query("SELECT legacy_owner_id FROM users WHERE id = $1", [userId])).rows[0] as { legacy_owner_id: string | null } | undefined;
    return row?.legacy_owner_id ?? undefined;
  }

  async resolve(input: IdentityInput): Promise<UserRecord> {
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.resolveOnce(input);
      } catch (error) {
        // Concurrent first-login requests race between "read miss" and INSERT:
        // the loser hits a unique violation on users.legacy_owner_id or
        // user_identities(issuer, subject). Retrying sees the committed rows.
        const code = (error as { code?: string }).code;
        if (code !== "23505" || attempt >= maxAttempts) throw error;
      }
    }
  }

  private async resolveOnce(input: IdentityInput): Promise<UserRecord> {
    const now = new Date().toISOString();
    const email = input.email.trim().toLowerCase();

    const known = (await this.db.query(
      "SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2",
      [input.issuer, input.subject],
    )).rows[0] as { user_id: string } | undefined;
    if (known) {
      await this.db.query("UPDATE user_identities SET last_login_at = $1 WHERE issuer = $2 AND subject = $3", [now, input.issuer, input.subject]);
      await this.db.query("UPDATE users SET email = $1, updated_at = $2 WHERE id = $3", [email, now, known.user_id]);
      return (await this.getUser(known.user_id))!;
    }

    const userId = await this.db.withTransaction(async (tx) => {
      const byEmail = email
        ? (await tx.query("SELECT * FROM users WHERE email = $1 AND status = 'active'", [email])).rows[0] as UserRow | undefined
        : undefined;
      const byLegacy = !byEmail && input.legacyOwnerId
        ? (await tx.query("SELECT * FROM users WHERE legacy_owner_id = $1", [input.legacyOwnerId])).rows[0] as UserRow | undefined
        : undefined;
      const existing = byEmail ?? byLegacy;

      let id: string;
      if (existing) {
        id = existing.id;
        let legacy = existing.legacy_owner_id;
        if (input.legacyOwnerId && !legacy) {
          const taken = (await tx.query("SELECT id FROM users WHERE legacy_owner_id = $1", [input.legacyOwnerId])).rows.length > 0;
          if (!taken) legacy = input.legacyOwnerId;
        }
        await tx.query("UPDATE users SET email = $1, legacy_owner_id = $2, updated_at = $3 WHERE id = $4", [email || existing.email, legacy, now, id]);
      } else {
        id = randomBytes(32).toString("hex");
        await tx.query(
          "INSERT INTO users (id, email, role, status, legacy_owner_id, created_at, updated_at) VALUES ($1, $2, 'user', 'active', $3, $4, $5)",
          [id, email, input.legacyOwnerId || null, now, now],
        );
      }

      await tx.query(
        "INSERT INTO user_identities (id, user_id, issuer, subject, identity_provider, last_login_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [newId("ident"), id, input.issuer, input.subject, input.identityProvider, now, now],
      );
      return id;
    });

    return (await this.getUser(userId))!;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const row = (await this.db.query("SELECT * FROM users WHERE id = $1", [id])).rows[0] as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  async userCount(): Promise<number> {
    const row = (await this.db.query("SELECT COUNT(*)::int AS count FROM users")).rows[0] as { count: number };
    return Number(row.count);
  }
}

/** Resource owner keys for a user: internal id first, legacy id (pre-migration data) second. */
export function ownerKeys(user: UserRecord): string[] {
  return user.legacyOwnerId ? [user.id, user.legacyOwnerId] : [user.id];
}
