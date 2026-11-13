import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../shared/types.js";
import { INTERNAL_RUN_ROUTE_CONTRACT, registerInternalRunRoutes } from "./internal-run-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function runFixture(): Run {
  return {
    id: "run-1",
    ownerId: "owner-1",
    title: "Fixture",
    task: "fixture",
    repository: "fixture",
    branch: "codex/fixture",
    mode: "real",
    state: "reviewing",
    round: 1,
    maxRounds: 2,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    developer: { provider: "fixture", model: "fixture" },
    reviewer: { provider: "fixture", model: "fixture" },
    checks: [],
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    diff: "",
    summary: "reviewing",
    durationMs: 0,
    lastSeq: 0,
  };
}

function fixture(authorized: boolean) {
  const app = Fastify();
  apps.push(app);
  let run = runFixture();
  const store = {
    getRun: vi.fn(() => run),
    updateRun: vi.fn(async (_id: string, patch: Partial<Run>) => (run = { ...run, ...patch })),
    appendEvent: vi.fn(async (event: unknown) => event),
    saveArtifact: vi.fn(async () => ({ artifactId: "artifact-1" })),
  };
  const jobQueue = { applyDelivery: vi.fn() };
  const parseUpdate = vi.fn((input: unknown) => ({ success: true as const, data: input as { patch?: Partial<Run>; event?: never } }));
  const parseArtifact = vi.fn(() => ({ success: false as const, error: { issues: [] } }));
  const persistTerminalDiffArtifact = vi.fn(async () => undefined);
  const reconcileStoryForRun = vi.fn(async () => undefined);
  const readArtifactCredentials = vi.fn(async () => []);
  registerInternalRunRoutes(app, {
    authorized: () => authorized,
    store: store as never,
    jobQueue: jobQueue as never,
    parseUpdate,
    parseArtifact,
    persistTerminalDiffArtifact,
    reconcileStoryForRun,
    readArtifactCredentials,
  });
  return { app, store, jobQueue, parseUpdate, parseArtifact, persistTerminalDiffArtifact, reconcileStoryForRun };
}

describe("internal run route contract", () => {
  it("registers the exact URL and body-limit snapshot", async () => {
    const app = Fastify();
    apps.push(app);
    const observed: Array<{ method: string; url: string; bodyLimit: number; auth: "internal" }> = [];
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/internal/runs/:id/update" || route.url === "/api/internal/runs/:id/artifacts") {
        observed.push({ method: String(route.method), url: route.url, bodyLimit: route.bodyLimit!, auth: "internal" });
      }
    });
    registerInternalRunRoutes(app, {
      authorized: () => false,
      store: { getRun: vi.fn(), updateRun: vi.fn(), appendEvent: vi.fn(), saveArtifact: vi.fn() } as never,
      parseUpdate: vi.fn(),
      parseArtifact: vi.fn(),
      persistTerminalDiffArtifact: vi.fn(),
      reconcileStoryForRun: vi.fn(),
      readArtifactCredentials: vi.fn(),
    });
    await app.ready();
    expect(observed).toEqual(INTERNAL_RUN_ROUTE_CONTRACT);
  });

  it("rejects both routes before parser, store or queue handlers execute", async () => {
    const { app, store, jobQueue, parseUpdate, parseArtifact } = fixture(false);
    for (const url of ["/api/internal/runs/run-1/update", "/api/internal/runs/run-1/artifacts"]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      expect(response.statusCode).toBe(401);
    }
    expect(parseUpdate).not.toHaveBeenCalled();
    expect(parseArtifact).not.toHaveBeenCalled();
    expect(store.getRun).not.toHaveBeenCalled();
    expect(jobQueue.applyDelivery).not.toHaveBeenCalled();
  });

  it("preserves the non-delivery update, event and reconciliation path", async () => {
    const { app, store, persistTerminalDiffArtifact, reconcileStoryForRun } = fixture(true);
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/runs/run-1/update",
      headers: { authorization: "Bearer fixture" },
      payload: {
        patch: { summary: "review complete" },
        event: { round: 1, source: "reviewer", type: "review.completed", message: "approved" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, applied: true });
    expect(store.updateRun).toHaveBeenCalledWith("run-1", { summary: "review complete" });
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", type: "review.completed" }));
    expect(persistTerminalDiffArtifact).toHaveBeenCalledOnce();
    expect(reconcileStoryForRun).toHaveBeenCalledWith("run-1");
  });
});
