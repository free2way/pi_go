import { describe, expect, it } from "vitest";
import { conflictFreeBatches, executionWaves, filesOverlap, parseDevelopmentPlan } from "./orchestrator.js";

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
    expect(plan.rationale).toContain("截取");
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

  it("rejects unknown and self dependencies instead of silently dropping them", () => {
    expect(() => parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      tasks: [
        { id: "api", title: "API", dependsOn: ["ghost-task"] },
        { id: "ui", title: "UI" },
      ],
    }), 4)).toThrow(/invalid dependencies/i);

    expect(() => parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      tasks: [{ id: "api", title: "API", dependsOn: ["api"] }],
    }), 4)).toThrow(/invalid dependencies/i);
  });

  it("rejects cyclic plans so the caller can fall back to a single agent", () => {
    expect(() => parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      tasks: [
        { id: "a", title: "A", dependsOn: ["b"] },
        { id: "b", title: "B", dependsOn: ["a"] },
      ],
    }), 4)).toThrow(/cyclic/i);
  });

  it("detects overlapping declared files including directory prefixes", () => {
    expect(filesOverlap(["src/api"], ["src/api/routes.ts"])).toBe(true);
    expect(filesOverlap(["src/api"], ["src/ui"])).toBe(false);
    expect(filesOverlap(["./src/api.ts"], ["src/api.ts"])).toBe(true);
  });

  it("serializes overlapping tasks into separate batches", () => {
    const plan = parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      tasks: [
        { id: "api", title: "API", files: ["src/api"] },
        { id: "ui", title: "UI", files: ["src/ui"] },
        { id: "api-tests", title: "API tests", files: ["src/api/tests"] },
      ],
    }), 4);
    const batches = conflictFreeBatches(plan.tasks);
    expect(batches.map((batch) => batch.map((task) => task.id))).toEqual([["api", "ui"], ["api-tests"]]);
  });

  it("resolves duplicate long task ids without looping (AUD-13)", () => {
    const long = "x".repeat(32);
    const plan = parseDevelopmentPlan(JSON.stringify({
      complexity: "medium",
      rationale: "duplicate ids",
      tasks: [
        { id: long, title: "A", description: "a", files: [], dependsOn: [] },
        { id: long, title: "B", description: "b", files: [], dependsOn: [] },
        { id: `${long}y`, title: "C", description: "c", files: [], dependsOn: [] },
      ],
    }), 4);
    const ids = plan.tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(32);
  });

  it("keeps deduped ids within the length budget for many collisions", () => {
    const plan = parseDevelopmentPlan(JSON.stringify({
      complexity: "large",
      rationale: "many collisions",
      tasks: Array.from({ length: 12 }, () => ({ id: "y".repeat(32), title: "t", description: "d", files: [], dependsOn: [] })),
    }), 12);
    const ids = plan.tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(32);
  });

});
