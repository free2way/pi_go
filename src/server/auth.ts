import { createHash } from "node:crypto";
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

function legacyOwnerIdFor(issuer: string, subject: string) {
  return createHash("sha256").update(`${issuer}|${subject}`).digest("hex");
}

function normalizeTeamDomain(value: string) {
  const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
  if (url.protocol !== "https:") throw new Error("PI_CF_ACCESS_TEAM_DOMAIN must use HTTPS");
  return url.origin;
}

export class Authenticator {
  private readonly mode = process.env.PI_AUTH_MODE || "development";
  private readonly issuer?: string;
  private readonly audience?: string;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
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
    } else if (this.mode !== "development") {
      throw new Error(`Unsupported PI_AUTH_MODE: ${this.mode}`);
    }
  }

  async authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      const identity = this.mode === "cloudflare"
        ? await this.fromCloudflare(request)
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

  private fromDevelopment(request: FastifyRequest): RequestIdentity {
    const emailHeader = request.headers["x-pigo-dev-email"];
    // 缺省身份：development 模式专用。demo 部署把浏览器会话固定成管理员身份
    // （PIGO_DEMO_DEV_EMAIL=bobo.2000@gmail.com），否则在浏览器里打开控制台永远是
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
