import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { createRunAdmission } from "./run-admission.js";
import type { WebServices } from "./web-services.js";
import type { WebJobQueue } from "./web-job-queue.js";
import type { WorkspaceAgileRoutes } from "./workspace-agile-routes.js";

describe("Team-backed run admission", () => {
  it("rejects a missing planner credential before persistence or queue dispatch", async () => {
    const dispatchJob = vi.fn();
    const createRun = vi.fn();
    const services = {
      PIPELINE_VERSION: "test",
      agentTeams: {
        getTeam: vi.fn(async () => ({
          id: "team_1", ownerId: "owner", name: "Delivery", createdAt: "now", updatedAt: "now",
          profiles: [
            { id: "planner", ownerId: "owner", name: "Planner", role: "planner", provider: "gemini", model: "gemini-pro", createdAt: "now", updatedAt: "now" },
            { id: "developer", ownerId: "owner", name: "Developer", role: "developer", provider: "deepseek", model: "deepseek-chat", createdAt: "now", updatedAt: "now" },
            { id: "reviewer", ownerId: "owner", name: "Reviewer", role: "reviewer", provider: "openai-proxy", model: "gpt-review", createdAt: "now", updatedAt: "now" },
          ],
        })),
      },
      alerts: { raise: vi.fn(), clear: vi.fn() }, app: { post: vi.fn(), delete: vi.fn() },
      auth: { user: () => ({ id: "owner", email: "" }) },
      credentialFingerprint: vi.fn(() => "fingerprint"), demoMode: false,
      identities: { isAdmin: vi.fn(async () => false) }, internalToken: "internal",
      modelCatalog: [
        { id: "gemini/gemini-pro", provider: "gemini", model: "gemini-pro", label: "Gemini", toolCalling: true, reasoning: true, roles: ["planner"], status: "available" },
        { id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat", label: "DeepSeek", toolCalling: true, reasoning: false, roles: ["developer"], status: "available" },
        { id: "openai-proxy/gpt-review", provider: "openai-proxy", model: "gpt-review", label: "Reviewer", toolCalling: true, reasoning: true, roles: ["reviewer"], status: "available" },
      ],
      modelDefaults: { developer: { provider: "deepseek", model: "deepseek-chat" }, reviewer: { provider: "openai-proxy", model: "gpt-review" } },
      ownerKeysFor: () => ["owner"], readRunBudget: () => undefined, realRunsEnabled: true,
      requestLocale: () => "en", runActions: { check: () => ({ allowed: true }) },
      runCreations: { check: () => ({ allowed: true }) }, store: { createRun },
      tooManyRequests: vi.fn(), vault: {
        providerAvailability: () => [
          { provider: "gemini", configured: false, verifiedAt: null, verifiedModels: null },
          { provider: "deepseek", configured: true, verified: true, verifiedAt: "now", verifiedModels: ["deepseek-chat"] },
          { provider: "openai-proxy", configured: true, verified: true, verifiedAt: "now", verifiedModels: ["gpt-review"] },
        ],
        get: (_owner: string, provider: string) => provider === "deepseek" ? "dev-key" : provider === "openai-proxy" ? "review-key" : undefined,
      },
      vaultKeyFor: () => "owner", workerRequest: vi.fn(async () => ({ state: "healthy", freeBytes: 1_000_000_000 })),
      workspaces: { refresh: vi.fn(async () => ({ id: "workspace", ownerId: "owner", name: "Repo", rootPath: "/workspace/projects/repo", relativePath: "projects/repo", createdAt: "now", updatedAt: "now", git: { head: "a".repeat(40), dirty: false, dirtyFiles: [] } })) },
    } as unknown as WebServices;
    const admission = createRunAdmission(
      services,
      { dispatchJob } as unknown as Pick<WebJobQueue, "dispatchJob">,
      { reconcileStoryForRun: vi.fn() } as unknown as Pick<WorkspaceAgileRoutes, "reconcileStoryForRun">,
    );
    const result = await admission.startRealRun({} as FastifyRequest, {
      title: "Team task", task: "Implement the requested Team-scoped change", repository: "ignored",
      workspaceId: "workspace", teamId: "team_1", mode: "real", checks: ["npm test"],
    });
    expect(result).toMatchObject({ ok: false, status: 422, body: { code: "MODEL_UNAVAILABLE", role: "planner" } });
    expect(createRun).not.toHaveBeenCalled();
    expect(dispatchJob).not.toHaveBeenCalled();
  });
});
