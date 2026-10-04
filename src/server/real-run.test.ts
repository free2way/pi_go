import { afterEach, describe, expect, it } from "vitest";
import { baseRealRun } from "./real-run.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("baseRealRun", () => {
  it("pins configured developer and reviewer models and initializes checks", () => {
    process.env.PI_DEVELOPER_PROVIDER = "deepseek";
    process.env.PI_DEVELOPER_MODEL = "deepseek-flash";
    process.env.PI_REVIEWER_PROVIDER = "openai-proxy";
    process.env.PI_REVIEWER_MODEL = "gpt-5.6-sol";
    process.env.PI_MAX_REVIEW_ROUNDS = "3";

    const run = baseRealRun({
      title: "Add a regression test",
      task: "Implement the requested change and add a regression test.",
      repository: "example-project",
      workspaceId: "ws_example",
      mode: "real",
      checks: ["npm test", "npm run typecheck"],
    }, "owner-a");

    expect(run.mode).toBe("real");
    expect(run.ownerId).toBe("owner-a");
    expect(run.workspaceId).toBe("ws_example");
    expect(run.developer).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(run.reviewer).toEqual({ provider: "openai-proxy", model: "gpt-5.6-sol" });
    expect(run.maxRounds).toBe(3);
    expect(run.branch).toMatch(/^pigo\/[a-f0-9]{16}$/);
    expect(run.checks.map((check) => check.command)).toEqual(["npm test", "npm run typecheck"]);
  });

  it("carries the idempotency key and acceptance criteria (GAP-01)", () => {
    const run = baseRealRun({
      title: "idempotent",
      task: "create runs idempotently and keep acceptance criteria with the run",
      repository: "/srv/ws",
      workspaceId: "ws_1",
      mode: "real",
      checks: ["npm test"],
      idempotencyKey: "audit-key-1234",
      acceptanceCriteria: "checks pass and reviewer approves",
    }, "owner");
    expect(run.idempotencyKey).toBe("audit-key-1234");
    expect(run.acceptanceCriteria).toContain("reviewer approves");
    expect(run.branch.startsWith("pigo/")).toBe(true);
  });

});
