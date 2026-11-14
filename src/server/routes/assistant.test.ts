import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AssistantRouteDependencies } from "./assistant.js";
import { registerAssistantRoutes } from "./assistant.js";

const testKey = `DUMMY_${"assistant_key".repeat(3)}`;
const model = {
  id: "provider-1/model-1",
  provider: "provider-1",
  model: "model-1",
  label: "Model 1",
  toolCalling: true,
  reasoning: false,
  roles: ["developer" as const],
  status: "available" as const,
};

function routeApp(overrides: Partial<AssistantRouteDependencies> = {}) {
  const workerRequest = vi.fn(async (pathName: string) => pathName === "/requirements/refine"
    ? { spec: { title: "Refined" }, task: "Task" }
    : { answer: "Answer", category: "explain", suggestedQuestions: [] });
  const deps: AssistantRouteDependencies = {
    currentUser: () => ({ id: "user-1", email: ["operator", "example.com"].join("@") }),
    requestLocale: () => "en",
    vaultKeyFor: () => "legacy-owner-1",
    providerAvailability: () => [{
      provider: "provider-1",
      configured: true,
      verifiedAt: "2026-11-14T00:00:00.000Z",
      verifiedModels: ["model-1"],
      verified: true,
      verification: "live",
    }],
    getCredential: () => testKey,
    modelCatalog: [model],
    defaultDeveloper: { provider: "provider-1", model: "model-1" },
    requirementRefinements: { check: () => ({ allowed: true, remaining: 11, retryAfterMs: 0 }) },
    piAssistantQuestions: { check: () => ({ allowed: true, remaining: 19, retryAfterMs: 0 }) },
    workerRequest: workerRequest as unknown as AssistantRouteDependencies["workerRequest"],
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerAssistantRoutes(app, deps);
  return { app, deps, workerRequest: deps.workerRequest as unknown as ReturnType<typeof vi.fn> };
}

describe("assistant routes", () => {
  it("rejects invalid requirement input before selecting a model", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({ method: "POST", url: "/api/requirements/refine", payload: { draft: "short" } });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("REQUIREMENT_INPUT_INVALID");
    expect(fixture.workerRequest).not.toHaveBeenCalled();
  });

  it("preserves requirement selection, locale, legacy vault scoping and timeout", async () => {
    const vaultKeyFor = vi.fn(() => "legacy-owner-1");
    const providerAvailability = vi.fn(() => fixtureAvailability());
    const getCredential = vi.fn(() => testKey);
    const fixture = routeApp({ vaultKeyFor, providerAvailability, getCredential });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/requirements/refine",
      payload: { draft: "Create a structured requirement for this workflow." },
    });

    expect(response.statusCode).toBe(200);
    expect(vaultKeyFor).toHaveBeenCalledOnce();
    expect(providerAvailability).toHaveBeenCalledWith("legacy-owner-1");
    expect(getCredential).toHaveBeenCalledWith("legacy-owner-1", "provider-1");
    expect(fixture.workerRequest).toHaveBeenCalledOnce();
    const [pathName, init, timeoutMs] = fixture.workerRequest.mock.calls[0] as [string, RequestInit, number];
    expect(pathName).toBe("/requirements/refine");
    expect(timeoutMs).toBe(30_000);
    expect(JSON.parse(String(init.body))).toMatchObject({
      draft: "Create a structured requirement for this workflow.",
      locale: "en",
      provider: "provider-1",
      model: "model-1",
      apiKey: testKey,
    });
  });

  it("preserves the requirement rate-limit response", async () => {
    const fixture = routeApp({
      requirementRefinements: { check: () => ({ allowed: false, remaining: 0, retryAfterMs: 1_001 }) },
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/requirements/refine",
      payload: { draft: "Create a structured requirement for this workflow." },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
    expect(fixture.workerRequest).not.toHaveBeenCalled();
  });

  it("forwards only the validated Pi assistant projection", async () => {
    const fixture = routeApp();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/assistant/ask",
      payload: {
        message: "What should I do next?",
        context: { page: "system" },
        history: [{ role: "user", content: "The workflow finished." }],
      },
    });

    expect(response.statusCode).toBe(200);
    const [pathName, init, timeoutMs] = fixture.workerRequest.mock.calls[0] as [string, RequestInit, number];
    expect(pathName).toBe("/assistant/ask");
    expect(timeoutMs).toBe(35_000);
    expect(JSON.parse(String(init.body))).toEqual({
      message: "What should I do next?",
      context: { page: "system" },
      history: [{ role: "user", content: "The workflow finished." }],
      locale: "en",
      provider: "provider-1",
      model: "model-1",
      apiKey: testKey,
    });
  });

  it("keeps the assistant busy response distinct from upstream failures", async () => {
    const workerRequest = vi.fn(async () => {
      const error = new Error("busy") as Error & { code?: string };
      error.code = "PI_ASSISTANT_BUSY";
      throw error;
    });
    const fixture = routeApp({ workerRequest: workerRequest as unknown as AssistantRouteDependencies["workerRequest"] });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/assistant/ask",
      payload: { message: "Help", context: { page: "run" } },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "Pi Assistant 当前繁忙，请稍后重试", code: "PI_ASSISTANT_BUSY" });
  });

  it("rejects unavailable models without reading credentials", async () => {
    const getCredential = vi.fn(() => testKey);
    const fixture = routeApp({ providerAvailability: () => [], getCredential });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/assistant/ask",
      payload: { message: "Help", context: { page: "run" } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "MODEL_UNAVAILABLE", role: "assistant" });
    expect(getCredential).not.toHaveBeenCalled();
    expect(fixture.workerRequest).not.toHaveBeenCalled();
  });
});

function fixtureAvailability() {
  return [{
    provider: "provider-1",
    configured: true,
    verifiedAt: "2026-11-14T00:00:00.000Z",
    verifiedModels: ["model-1"],
    verified: true,
    verification: "live" as const,
  }];
}
