import { describe, expect, it } from "vitest";
import type { ModelCredentials, Run } from "./types.js";
import {
  clearModelCredentials,
  credentialForRole,
  hasRequiredCredentials,
  requiredCredentialRoles,
  resolveRunCredentials,
  runModelForRole,
} from "./run-roles.js";

function run(): Run {
  return {
    id: "run_team", ownerId: "owner", title: "Team run", task: "Implement the requested change",
    repository: "fixture", branch: "pigo/team", mode: "real", state: "queued", round: 1,
    maxRounds: 3, createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z",
    developer: { provider: "deepseek", model: "deepseek-chat" },
    reviewer: { provider: "openai-proxy", model: "gpt-review" },
    checks: [], findings: [], diff: "", summary: "queued",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, durationMs: 0, lastSeq: 0,
  };
}

describe("Team run role projection", () => {
  it("preserves the legacy two-role credential contract", () => {
    const legacy = run();
    const keys = new Map([["deepseek", "dev-key"], ["openai-proxy", "review-key"]]);
    expect(requiredCredentialRoles(legacy)).toEqual(["developer", "reviewer"]);
    expect(resolveRunCredentials(legacy, (provider) => keys.get(provider))).toEqual({
      ok: true,
      credentials: { developer: "dev-key", reviewer: "review-key" },
    });
  });

  it("projects only each pinned Team role's provider key", () => {
    const current = run();
    current.teamId = "team_1";
    current.agents = {
      planner: { id: "p", name: "Planner", role: "planner", provider: "gemini", model: "gemini-pro" },
      developer: { id: "d", name: "Developer", role: "developer", provider: "deepseek", model: "deepseek-chat" },
      reviewer: { id: "r", name: "Reviewer", role: "reviewer", provider: "openai-proxy", model: "gpt-review" },
    };
    const keys = new Map([["gemini", "plan-key"], ["deepseek", "dev-key"], ["openai-proxy", "review-key"], ["unused", "must-not-project"]]);
    const result = resolveRunCredentials(current, (provider) => keys.get(provider));
    expect(result).toEqual({ ok: true, credentials: { planner: "plan-key", developer: "dev-key", reviewer: "review-key" } });
    if (!result.ok) throw new Error("fixture resolution failed");
    expect(hasRequiredCredentials(current, result.credentials)).toBe(true);
    expect(runModelForRole(current, "planner")).toEqual({ provider: "gemini", model: "gemini-pro" });
    expect(credentialForRole(current, result.credentials, "planner")).toBe("plan-key");
    expect(runModelForRole(current, "integrator")).toEqual(current.developer);
  });

  it("fails closed on the first missing Team role credential and clears every projected key", () => {
    const current = run();
    current.agents = {
      planner: { id: "p", name: "Planner", role: "planner", provider: "gemini", model: "gemini-pro" },
      developer: { id: "d", name: "Developer", role: "developer", provider: "deepseek", model: "deepseek-chat" },
      reviewer: { id: "r", name: "Reviewer", role: "reviewer", provider: "openai-proxy", model: "gpt-review" },
    };
    expect(resolveRunCredentials(current, (provider) => provider === "gemini" ? undefined : `${provider}-key`)).toEqual({
      ok: false, role: "planner", provider: "gemini",
    });
    expect(() => credentialForRole(current, { developer: "dev", reviewer: "review" }, "planner")).toThrow(/pinned role planner/);
    const credentials: ModelCredentials = { planner: "plan", developer: "dev", reviewer: "review" };
    clearModelCredentials(credentials);
    expect(credentials).toEqual({ planner: "", developer: "", reviewer: "" });
  });
});
