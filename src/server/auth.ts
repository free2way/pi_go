import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser } from "../shared/types.js";

type AuthenticatedRequest = FastifyRequest & { user?: CurrentUser };

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
      const user = this.mode === "cloudflare"
        ? await this.fromCloudflare(request)
        : this.fromDevelopment(request);
      (request as AuthenticatedRequest).user = user;
    } catch {
      return reply.code(401).send({ error: "Authentication required" });
    }
  }

  user(request: FastifyRequest) {
    const user = (request as AuthenticatedRequest).user;
    if (!user) throw new Error("Authenticated user context is missing");
    return user;
  }

  private async fromCloudflare(request: FastifyRequest): Promise<CurrentUser> {
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
      id: createHash("sha256").update(`${this.issuer}|${payload.sub}`).digest("hex"),
      email: payload.email.toLowerCase(),
    };
  }

  private fromDevelopment(request: FastifyRequest): CurrentUser {
    const emailHeader = request.headers["x-pigo-dev-email"];
    const email = typeof emailHeader === "string" ? emailHeader : "developer@localhost";
    return {
      id: createHash("sha256").update(`development|${email.toLowerCase()}`).digest("hex"),
      email: email.toLowerCase(),
    };
  }
}
