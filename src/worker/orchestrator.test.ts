import { describe, expect, it } from "vitest";
import { executionWaves, parseDevelopmentPlan } from "./orchestrator.js";

describe("development orchestrator", () => {
  it("caps and normalizes planner tasks", () => {
    const plan = parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      rationale: "Several independent components",
      tasks: [
        { id: "API layer", title: "API", description: "Build API", files: ["src/api.ts"] },
        { id: "tests", title: "Tests", description: "Add tests", dependsOn: ["api-layer"] },
        { id: "extra", title: "Extra", description: "Extra work" },
      ],
    }), 2);
    expect(plan.tasks.map((task) => task.id)).toEqual(["api-layer", "tests"]);
    expect(plan.tasks[1].dependsOn).toEqual(["api-layer"]);
  });

  it("creates dependency-safe execution waves", () => {
    const plan = parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      tasks: [
        { id: "api", title: "API" },
        { id: "ui", title: "UI" },
        { id: "integration", title: "Integration", dependsOn: ["api", "ui"] },
      ],
    }), 4);
    expect(executionWaves(plan.tasks).map((wave) => wave.map((task) => task.id))).toEqual([["api", "ui"], ["integration"]]);
  });
});
