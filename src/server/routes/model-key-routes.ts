import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CurrentUser } from "../../shared/types.js";
import type { CredentialVault } from "../credential-vault.js";
import type { ProviderProbe } from "../provider-probe.js";
import type { RateLimiter } from "../rate-limit.js";

const credentialSchema = z.object({
  provider: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().trim().min(12).max(512).optional(),
  developerApiKey: z.string().trim().min(12).max(512).optional(),
  reviewerApiKey: z.string().trim().min(12).max(512).optional(),
}).refine((value) => (value.provider && value.apiKey) || value.developerApiKey || value.reviewerApiKey, "At least one credential is required")
  .refine((value) => !value.provider || Boolean(value.apiKey), "apiKey is required when provider is set");

type CredentialRoutesVault = Pick<CredentialVault,
  "status" | "set" | "markOperatorAsserted" | "markVerified" | "markUnverified" | "delete"
>;

export interface CredentialRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  vaultKeyFor: (request: FastifyRequest) => string;
  vault: CredentialRoutesVault;
  credentialWrites: Pick<RateLimiter, "check">;
  modelDefaults: { developer: { provider: string }; reviewer: { provider: string } };
  providerProbe: ProviderProbe;
  providerProbeDisabled: () => boolean;
  resetDecisionCircuitBreakers: () => void;
}

function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
}

export function registerCredentialRoutes(app: FastifyInstance, deps: CredentialRouteDependencies) {
  const { credentialWrites, modelDefaults, providerProbe, vault } = deps;

  app.get("/api/credentials/status", async (request) => vault.status(deps.vaultKeyFor(request)));

  app.put("/api/credentials", async (request, reply) => {
    const user = deps.currentUser(request);
    const credentialLimit = credentialWrites.check(user.id);
    if (!credentialLimit.allowed) return tooManyRequests(reply, credentialLimit.retryAfterMs);
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid credential request" });
    const userId = deps.vaultKeyFor(request);
    const writes: Array<{ provider: string; apiKey: string }> = [];
    if (parsed.data.provider && parsed.data.apiKey) {
      writes.push({ provider: parsed.data.provider, apiKey: parsed.data.apiKey });
    } else {
      // Legacy role-based payloads map onto the configured role providers.
      if (parsed.data.developerApiKey) writes.push({ provider: modelDefaults.developer.provider, apiKey: parsed.data.developerApiKey });
      if (parsed.data.reviewerApiKey) writes.push({ provider: modelDefaults.reviewer.provider, apiKey: parsed.data.reviewerApiKey });
    }
    let status = vault.status(userId);
    for (const write of writes) {
      status = await vault.set(userId, write);
      // Probe-disabled mode is an explicit operator assertion, never a live verification.
      if (deps.providerProbeDisabled()) {
        status = await vault.markOperatorAsserted(userId, write.provider);
        continue;
      }
      const probe = await providerProbe(write).catch(() => undefined);
      if (probe?.ok) {
        status = await vault.markVerified(userId, write.provider, probe.models, probe.capabilities ?? null);
      } else {
        status = await vault.markUnverified(userId, write.provider);
      }
    }
    // Replacing a key must allow the decision plane to retry an auth-latched provider.
    if (writes.length > 0) deps.resetDecisionCircuitBreakers();
    return status;
  });

  app.delete<{ Querystring: { provider?: string } }>("/api/credentials", async (request, reply) => {
    const user = deps.currentUser(request);
    const credentialLimit = credentialWrites.check(user.id);
    if (!credentialLimit.allowed) return tooManyRequests(reply, credentialLimit.retryAfterMs);
    await vault.delete(deps.vaultKeyFor(request), request.query?.provider || undefined);
    return reply.code(204).send();
  });
}
