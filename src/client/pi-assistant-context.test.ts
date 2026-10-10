import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { buildPiAssistantContext } from "./pi-assistant-context";

describe("buildPiAssistantContext", () => {
  it("does not expose task, diff, paths, outputs or release detail", () => {
    const run = {
      id: "run-1",
      title: "Fix checkout",
      state: "failed",
      round: 2,
      maxRounds: 3,
      repository: "demo/shop",
      summary: "A check failed",
      developer: { provider: "deepseek", model: "chat" },
      reviewer: { provider: "openai", model: "review" },
      checks: [{ id: "c1", name: "test", command: "secret command", status: "failed", output: "secret output", exitCode: 1 }],
      findings: [{ id: "f1", severity: "high", file: "/secret/path", line: 4, title: "Race", evidence: "raw evidence", requiredChange: "fix", resolved: false }],
      diff: "secret diff",
      task: "private task",
      release: { status: "failed", environment: "staging", detail: "secret release detail" },
    } as unknown as Run;
    const context = buildPiAssistantContext("run", run);
    expect(context.run?.checks[0]).toEqual({ name: "test", status: "failed", exitCode: 1 });
    expect(context.run?.findings[0]).toEqual({ severity: "high", title: "Race", resolved: false });
    expect(JSON.stringify(context)).not.toContain("secret");
  });

  it("sends page identity only outside the run page", () => {
    expect(buildPiAssistantContext("system", {} as Run)).toEqual({ page: "system" });
  });
});
