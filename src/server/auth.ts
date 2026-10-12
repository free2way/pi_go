import { createHash } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser } from "../shared/types.js";

type AuthenticatedRequest = FastifyRequest & { user?: CurrentUser; identity?: RequestIdentity };

export type RequestIdentity = {
  email: string;
  issuer: string;
  subject: string;
  identityProvider: string;
  /** sha256(`${issuer}|${subject}`) — the owner key used before internal user ids existed. */
  legacyOwnerId: string;
};

export type AuthMode = "development" | "cloudflare" | "clerk";

export type PublicAuthConfig =
  | { mode: "development" | "cloudflare"; clerk: null }
  | { mode: "clerk"; clerk: { publishableKey: string; proxyUrl: string } };

type ClerkAuthState = {
  isAuthenticated: boolean;
  userId?: string | null;
  sessionClaims?: Record<string, unknown> | null;
};

type ClerkUserProfile = {
  primaryEmailAddressId?: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string | null } | null;
  }>;
};

export type AuthenticatorOptions = {
  clerkAuth?: (request: FastifyRequest) => ClerkAuthState;
  clerkUser?: (userId: string) => Promise<ClerkUserProfile>;
  now?: () => number;
  clerkEmailCacheMaxEntries?: number;
};

const CLERK_EMAIL_CACHE_MS = 5 * 60_000;
const DEFAULT_CLERK_EMAIL_CACHE_MAX_ENTRIES = 1_000;

function legacyOwnerIdFor(issuer: string, subject: string) {
  return createHash("sha256").update(`${issuer}|${subject}`).digest("hex");
}

function normalizeTeamDomain(value: string) {
  const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
  if (url.protocol !== "https:") throw new Error("PI_CF_ACCESS_TEAM_DOMAIN must use HTTPS");
  return url.origin;
}

export function normalizePublicOrigin(value: string, options: { production: boolean }) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PI_PUBLIC_ORIGIN must be a valid URL origin");
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(!options.production && localhost && url.protocol === "http:")) {
    throw new Error("PI_PUBLIC_ORIGIN must use HTTPS outside local development");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("PI_PUBLIC_ORIGIN must contain only scheme and host");
  }
  return url.origin;
}

export class Authenticator {
  private readonly mode: AuthMode;
  private readonly issuer?: string;
  private readonly audience?: string;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly clerkPublishableKey?: string;
  private readonly clerkAuth: (request: FastifyRequest) => ClerkAuthState;
  private readonly clerkUser: (userId: string) => Promise<ClerkUserProfile>;
  private readonly now: () => number;
  private readonly clerkEmailCacheMaxEntries: number;
  private readonly clerkEmails = new Map<string, { email: string; expiresAt: number }>();
  private readonly clerkEmailRequests = new Map<string, Promise<string>>();

  constructor(options: AuthenticatorOptions = {}) {
    const configuredMode = process.env.PI_AUTH_MODE || "development";
    if (!["development", "cloudflare", "clerk"].includes(configuredMode)) {
      throw new Error(`Unsupported PI_AUTH_MODE: ${configuredMode}`);
    }
    this.mode = configuredMode as AuthMode;
    this.clerkAuth = options.clerkAuth ?? ((request) => getAuth(request) as ClerkAuthState);
    this.clerkUser = options.clerkUser ?? ((userId) => clerkClient.users.getUser(userId));
    this.now = options.now ?? Date.now;
    const cacheMaxEntries = options.clerkEmailCacheMaxEntries ?? DEFAULT_CLERK_EMAIL_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(cacheMaxEntries) || cacheMaxEntries < 1) throw new Error("clerkEmailCacheMaxEntries must be a positive integer");
    this.clerkEmailCacheMaxEntries = cacheMaxEntries;
    if (this.mode === "development" && process.env.NODE_ENV === "production") {
      throw new Error("PI_AUTH_MODE=development is not allowed when NODE_ENV=production");
    }
    if (this.mode === "cloudflare") {
      const teamDomain = process.env.PI_CF_ACCESS_TEAM_DOMAIN;
      this.audience = process.env.PI_CF_ACCESS_AUDIENCE;
      if (!teamDomain || !this.audience) {
        throw new Error("Cloudflare authentication requires team domain and audience");
      }
      this.issuer = normalizeTeamDomain(teamDomain);
      this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`));
    } else if (this.mode === "clerk") {
      this.clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
      if (!this.clerkPublishableKey || !process.env.CLERK_SECRET_KEY?.trim()) {
        throw new Error("Clerk authentication requires CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY");
      }
    }
  }

  get authMode(): AuthMode {
    return this.mode;
  }

  publicConfig(): PublicAuthConfig {
    if (this.mode !== "clerk") return { mode: this.mode, clerk: null };
    return {
      mode: "clerk",
      clerk: { publishableKey: this.clerkPublishableKey!, proxyUrl: "/__clerk" },
    };
  }

  async authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      const identity = this.mode === "cloudflare"
        ? await this.fromCloudflare(request)
        : this.mode === "clerk"
          ? await this.fromClerk(request)
          : this.fromDevelopment(request);
      (request as AuthenticatedRequest).identity = identity;
    } catch {
      return reply.code(401).send({ error: "Authentication required" });
    }
  }

  identity(request: FastifyRequest) {
    const identity = (request as AuthenticatedRequest).identity;
    if (!identity) throw new Error("Authenticated identity context is missing");
    return identity;
  }

  user(request: FastifyRequest) {
    const user = (request as AuthenticatedRequest).user;
    if (!user) throw new Error("Authenticated user context is missing");
    return user;
  }

  setUser(request: FastifyRequest, user: CurrentUser) {
    (request as AuthenticatedRequest).user = user;
  }

  private async fromCloudflare(request: FastifyRequest): Promise<RequestIdentity> {
    const token = request.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || !this.jwks || !this.issuer || !this.audience) {
      throw new Error("Missing Cloudflare Access token");
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
    });
    if (payload.type !== "app" || typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw new Error("Invalid Cloudflare Access identity");
    }
    return {
      email: payload.email.toLowerCase(),
      issuer: this.issuer,
      subject: payload.sub,
      identityProvider: "cloudflare-access",
      legacyOwnerId: legacyOwnerIdFor(this.issuer, payload.sub),
    };
  }

  private async fromClerk(request: FastifyRequest): Promise<RequestIdentity> {
    const state = this.clerkAuth(request);
    if (!state.isAuthenticated || typeof state.userId !== "string" || !state.userId) {
      throw new Error("Missing Clerk session");
    }
    const issuer = typeof state.sessionClaims?.iss === "string" && state.sessionClaims.iss
      ? state.sessionClaims.iss
      : `clerk:${this.clerkPublishableKey}`;
    const email = await this.clerkEmail(state.userId);
    return {
      email,
      issuer,
      subject: state.userId,
      identityProvider: "clerk",
      legacyOwnerId: legacyOwnerIdFor(issuer, state.userId),
    };
  }

  /**
   * Clerk's default session token intentionally omits email. Resolve the primary
   * address once, require Clerk to report it as verified, and cache it briefly so
   * normal API fan-out does not add a Backend API round trip to every request.
   */
  private async clerkEmail(userId: string): Promise<string> {
    const cached = this.clerkEmails.get(userId);
    if (cached && cached.expiresAt > this.now()) {
      this.clerkEmails.delete(userId);
      this.clerkEmails.set(userId, cached);
      return cached.email;
    }
    const pending = this.clerkEmailRequests.get(userId);
    if (pending) return pending;
    const lookup = this.clerkUser(userId).then((user) => {
      const primary = user.emailAddresses.find((item) => item.id === user.primaryEmailAddressId);
      if (!primary || primary.verification?.status !== "verified") {
        throw new Error("Clerk user does not have a verified primary email address");
      }
      const email = primary.emailAddress.trim().toLowerCase();
      if (!email) throw new Error("Clerk user email is empty");
      for (const [cachedUserId, entry] of this.clerkEmails) {
        if (entry.expiresAt <= this.now()) this.clerkEmails.delete(cachedUserId);
      }
      // Map preserves insertion order. Refreshing an existing entry and evicting
      // the oldest one gives us a compact LRU-like bound without a second index.
      this.clerkEmails.delete(userId);
      while (this.clerkEmails.size >= this.clerkEmailCacheMaxEntries) {
        const oldest = this.clerkEmails.keys().next().value as string | undefined;
        if (!oldest) break;
        this.clerkEmails.delete(oldest);
      }
      this.clerkEmails.set(userId, { email, expiresAt: this.now() + CLERK_EMAIL_CACHE_MS });
      return email;
    }).finally(() => this.clerkEmailRequests.delete(userId));
    this.clerkEmailRequests.set(userId, lookup);
    return lookup;
  }

  private fromDevelopment(request: FastifyRequest): RequestIdentity {
    const emailHeader = request.headers["x-pigo-dev-email"];
    // 缺省身份：development 模式专用。demo 部署把浏览器会话固定成管理员身份
    // （例如 PIGO_DEMO_DEV_EMAIL=admin@example.com），否则在浏览器里打开控制台永远是
    // developer@localhost 这个非管理员身份，管理员操作（额度录入、合并、发布）没有入口。
    // 该分支只在 PI_AUTH_MODE=development 时可达，而 production + development 会被
    // 构造函数直接拒绝，所以它不可能影响生产。
    const fallback = String(process.env.PI_DEV_DEFAULT_EMAIL ?? "").trim() || "developer@localhost";
    const email = (typeof emailHeader === "string" ? emailHeader : fallback).toLowerCase();
    return {
      email,
      issuer: "development",
      subject: email,
      identityProvider: "development",
      legacyOwnerId: legacyOwnerIdFor("development", email),
    };
  }
}
