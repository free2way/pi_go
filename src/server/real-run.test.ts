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
      mode: "real",
      checks: ["npm test", "npm run typecheck"],
    });

    expect(run.mode).toBe("real");
    expect(run.developer).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(run.reviewer).toEqual({ provider: "openai-proxy", model: "gpt-5.6-sol" });
    expect(run.maxRounds).toBe(3);
    expect(run.branch).toMatch(/^pigo\/[a-f0-9]{16}$/);
    expect(run.checks.map((check) => check.command)).toEqual(["npm test", "npm run typecheck"]);
  });
});
