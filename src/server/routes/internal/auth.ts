import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

type InternalPolicy = "worker" | "release" | "metrics";
type Authorize = (authorization: string | undefined) => boolean;

declare module "fastify" {
  interface FastifyContextConfig {
    internalAuth?: InternalPolicy;
  }
}

export function safeSecretMatch(value: string | undefined, secret: string) {
  if (!value || !secret) return false;
  const actual = Buffer.from(value.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** New internal endpoints require the worker credential unless they declare a narrower policy. */
export function registerInternalAuthorization(app: FastifyInstance, policies: Record<InternalPolicy, Authorize>) {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/internal/")) return;
    const authorize = policies[request.routeOptions.config.internalAuth ?? "worker"];
    if (!authorize(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" });
  });
}
