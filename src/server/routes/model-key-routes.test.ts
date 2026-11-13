import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CredentialRouteDependencies } from "./model-key-routes.js";
import { registerCredentialRoutes } from "./model-key-routes.js";

const emptyStatus = {
  developerConfigured: false,
  reviewerConfigured: false,
  updatedAt: null,
  providers: [],
};

function routeApp(overrides: Partial<CredentialRouteDependencies> = {}) {
  const vault = {
    status: vi.fn(() => emptyStatus),
    set: vi.fn(async () => emptyStatus),
    markOperatorAsserted: vi.fn(async () => emptyStatus),
    markVerified: vi.fn(async () => emptyStatus),
    markUnverified: vi.fn(async () => emptyStatus),
    delete: vi.fn(async () => undefined),
  } as unknown as CredentialRouteDependencies["vault"];
  const deps: CredentialRouteDependencies = {
    currentUser: () => ({ id: "user-1", email: ["operator", "example.com"].join("@") }),
    vaultKeyFor: () => "legacy-owner-1",
    vault,
    credentialWrites: { check: () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) },
    modelDefaults: { developer: { provider: "developer-provider" }, reviewer: { provider: "review-provider" } },
    providerProbe: vi.fn(async () => ({ ok: true as const, models: ["model-1"] })),
    providerProbeDisabled: () => false,
    resetDecisionCircuitBreakers: vi.fn(),
    ...overrides,
  };
  const app = Fastify();
  registerCredentialRoutes(app, deps);
  return { app, deps };
}

function fakeKey(label: string) {
  return `DUMMY_${label}_credential_value`;
}

describe("credential routes", () => {
  it("reads status through the legacy-aware vault key", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({ method: "GET", url: "/api/credentials/status" });

    expect(response.statusCode).toBe(200);
    expect(fixture.deps.vault.status).toHaveBeenCalledWith("legacy-owner-1");
  });

  it("rejects an invalid write before touching the vault", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({ method: "PUT", url: "/api/credentials", payload: { provider: "provider-only" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid credential request" });
    expect(fixture.deps.vault.set).not.toHaveBeenCalled();
  });

  it("maps the legacy role payload and records explicit operator assertions", async () => {
    const providerProbe = vi.fn(async () => ({ ok: false as const, code: "PROBE_ERROR" as const, message: "unused" }));
    const resetDecisionCircuitBreakers = vi.fn();
    const fixture = routeApp({ providerProbe, providerProbeDisabled: () => true, resetDecisionCircuitBreakers });
    const response = await fixture.app.inject({
      method: "PUT",
      url: "/api/credentials",
      payload: { developerApiKey: fakeKey("developer"), reviewerApiKey: fakeKey("reviewer") },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.deps.vault.set).toHaveBeenNthCalledWith(1, "legacy-owner-1", { provider: "developer-provider", apiKey: fakeKey("developer") });
    expect(fixture.deps.vault.set).toHaveBeenNthCalledWith(2, "legacy-owner-1", { provider: "review-provider", apiKey: fakeKey("reviewer") });
    expect(fixture.deps.vault.markOperatorAsserted).toHaveBeenCalledTimes(2);
    expect(providerProbe).not.toHaveBeenCalled();
    expect(resetDecisionCircuitBreakers).toHaveBeenCalledOnce();
  });

  it("stores live probe evidence for a provider credential", async () => {
    const providerProbe = vi.fn(async () => ({
      ok: true as const,
      models: ["model-1"],
      capabilities: { "model-1": { toolCalling: true } },
    }));
    const fixture = routeApp({ providerProbe });
    const response = await fixture.app.inject({
      method: "PUT",
      url: "/api/credentials",
      payload: { provider: "provider-1", apiKey: fakeKey("live") },
    });

    expect(response.statusCode).toBe(200);
    expect(providerProbe).toHaveBeenCalledWith({ provider: "provider-1", apiKey: fakeKey("live") });
    expect(fixture.deps.vault.markVerified).toHaveBeenCalledWith(
      "legacy-owner-1",
      "provider-1",
      ["model-1"],
      { "model-1": { toolCalling: true } },
    );
    expect(fixture.deps.vault.markUnverified).not.toHaveBeenCalled();
  });

  it("preserves delete scoping and the rate-limit response", async () => {
    const allowed = routeApp();
    const deleted = await allowed.app.inject({ method: "DELETE", url: "/api/credentials?provider=provider-1" });
    expect(deleted.statusCode).toBe(204);
    expect(allowed.deps.vault.delete).toHaveBeenCalledWith("legacy-owner-1", "provider-1");

    const limited = routeApp({
      credentialWrites: { check: () => ({ allowed: false, remaining: 0, retryAfterMs: 1_001 }) },
    });
    const response = await limited.app.inject({ method: "DELETE", url: "/api/credentials" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(limited.deps.vault.delete).not.toHaveBeenCalled();
  });
});
