import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ModelRouteDependencies } from "./models.js";
import { registerModelRoutes } from "./models.js";

const developer = { provider: "provider-dev", model: "model-dev" };
const reviewer = { provider: "provider-review", model: "model-review" };
const catalog: ModelRouteDependencies["modelCatalog"] = [
  { id: "provider-dev/model-dev", ...developer, label: "Developer", toolCalling: true, reasoning: false, roles: ["developer"], status: "available" },
  { id: "provider-review/model-review", ...reviewer, label: "Reviewer", toolCalling: true, reasoning: true, roles: ["reviewer"], status: "available" },
];

function routeApp(overrides: Partial<ModelRouteDependencies> = {}) {
  const deps: ModelRouteDependencies = {
    vaultKeyFor: () => "legacy-owner-1",
    providerAvailability: () => [{
      provider: developer.provider,
      configured: true,
      verifiedAt: "2026-11-14T00:00:00.000Z",
      verifiedModels: [developer.model],
      verified: true,
      verification: "live",
      capabilities: { [developer.model]: { toolCalling: true, reasoning: false } },
    }],
    credentialStatus: () => ({
      developerConfigured: true,
      reviewerConfigured: true,
      updatedAt: "2026-11-14T00:00:00.000Z",
      providers: [
        { provider: developer.provider, configured: true, masked: null, updatedAt: null, verification: "live" },
        { provider: reviewer.provider, configured: true, masked: null, updatedAt: null, verification: "operator_asserted" },
      ],
    }),
    modelCatalog: catalog,
    modelDefaults: { developer, reviewer },
    demoMode: true,
    piVersion: "1.2.3",
    realRunsEnabled: true,
    internalTokenConfigured: true,
    mergeRequestConfigured: true,
    releaseConfigured: () => true,
    decisionEngineStatus: async () => ({ engine: "jev", mode: "enforce", configured: true, keySource: "vault", policyVersion: "policy-1" }),
    ...overrides,
  };
  const app = Fastify();
  registerModelRoutes(app, deps);
  return { app, deps };
}

describe("model routes", () => {
  it("projects the model catalogue with live provider evidence", async () => {
    const providerAvailability = vi.fn(routeApp().deps.providerAvailability);
    const fixture = routeApp({ providerAvailability });
    const response = await fixture.app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(200);
    expect(providerAvailability).toHaveBeenCalledWith("legacy-owner-1");
    expect(response.json()).toMatchObject({
      defaultDeveloper: developer,
      defaultReviewer: reviewer,
      models: [
        { provider: developer.provider, model: developer.model, available: true, verified: true, selectableRoles: ["developer"] },
        { provider: reviewer.provider, model: reviewer.model, available: false, unavailableReason: "credential_missing" },
      ],
      verifiedProviders: [{
        provider: developer.provider,
        verification: "live",
        verificationLabel: "已验证",
        capabilities: { [developer.model]: { toolCalling: true, reasoning: false } },
      }],
    });
  });

  it("keeps configured, verified and asserted providers distinct", async () => {
    const decisionEngineStatus = vi.fn(routeApp().deps.decisionEngineStatus);
    const releaseConfigured = vi.fn(() => true);
    const fixture = routeApp({ decisionEngineStatus, releaseConfigured });
    const response = await fixture.app.inject({ method: "GET", url: "/api/config/status" });

    expect(response.statusCode).toBe(200);
    expect(decisionEngineStatus).toHaveBeenCalledWith("legacy-owner-1");
    expect(releaseConfigured).toHaveBeenCalledOnce();
    expect(response.json()).toEqual({
      demoMode: true,
      piVersion: "1.2.3",
      developer: { ...developer, credentialConfigured: true },
      reviewer: { ...reviewer, credentialConfigured: true },
      realRunsAvailable: true,
      configuredProviders: [developer.provider, reviewer.provider],
      verifiedProviders: [developer.provider],
      assertedProviders: [reviewer.provider],
      mergeRequestConfigured: true,
      releaseConfigured: true,
      decisionEngine: { engine: "jev", mode: "enforce", configured: true, keySource: "vault", policyVersion: "policy-1" },
    });
  });

  it("keeps real runs unavailable without an internal token", async () => {
    const fixture = routeApp({ internalTokenConfigured: false });
    const response = await fixture.app.inject({ method: "GET", url: "/api/config/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json().realRunsAvailable).toBe(false);
  });

  it("does not treat configured but unchecked providers as verified", async () => {
    const fixture = routeApp({
      credentialStatus: () => ({
        developerConfigured: true,
        reviewerConfigured: false,
        updatedAt: null,
        providers: [{ provider: developer.provider, configured: true, masked: null, updatedAt: null, verification: "unchecked" }],
      }),
    });
    const response = await fixture.app.inject({ method: "GET", url: "/api/config/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configuredProviders: [developer.provider], verifiedProviders: [], assertedProviders: [] });
  });
});
