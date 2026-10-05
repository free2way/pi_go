import { describe, expect, it } from "vitest";
import {
  projectCreateSchema,
  projectPatchSchema,
  releaseCreateSchema,
  sprintCreateSchema,
  sprintPatchSchema,
  storyCreateSchema,
  storyPatchSchema,
  storySubmitSchema,
  templateCreateSchema,
} from "./agile-schemas.js";

describe("agile schemas — projects", () => {
  it("accepts a minimal project and normalizes trim", () => {
    const parsed = projectCreateSchema.safeParse({ name: "  认证服务  ", key: "auth" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ name: "认证服务", key: "auth" });
  });

  it("rejects an invalid key and unknown fields", () => {
    expect(projectCreateSchema.safeParse({ name: "x", key: "1A" }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ name: "x", key: "AUTH", ownerId: "someone-else" }).success).toBe(false);
    expect(projectPatchSchema.safeParse({ key: "NEW" }).success).toBe(false);
  });
});

describe("agile schemas — stories", () => {
  it("accepts the documented story shape", () => {
    const parsed = storyCreateSchema.safeParse({
      projectId: "proj_1",
      title: "实现登录限流",
      description: "描述",
      acceptanceCriteria: ["返回 429"],
      priority: "must",
      estimate: 5,
      definitionOfDone: ["测试通过"],
      developerModel: { provider: "deepseek", model: "flash" },
      maxParallel: 2,
      status: "ready",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown priority, a non-Fibonacci estimate and a bad status", () => {
    expect(storyCreateSchema.safeParse({ projectId: "p", title: "t", priority: "P0" }).success).toBe(false);
    expect(storyCreateSchema.safeParse({ projectId: "p", title: "t", estimate: 7 }).success).toBe(false);
    expect(storyCreateSchema.safeParse({ projectId: "p", title: "t", status: "in_analysis" }).success).toBe(false);
  });

  it("allows clearing an estimate/model/budget with null on patch", () => {
    expect(storyPatchSchema.safeParse({ estimate: null, developerModel: null, budget: null, sprintId: null }).success).toBe(true);
    expect(storyPatchSchema.safeParse({ projectId: "proj_2" }).success).toBe(false);
    expect(storyPatchSchema.safeParse({ budget: { maxTokens: 1 } }).success).toBe(false);
  });
});

describe("agile schemas — sprints and releases", () => {
  it("accepts planned sprints and rejects bad statuses", () => {
    expect(sprintCreateSchema.safeParse({ projectId: "p", name: "Sprint 1", status: "active" }).success).toBe(true);
    expect(sprintCreateSchema.safeParse({ projectId: "p", name: "Sprint 1", status: "running" }).success).toBe(false);
    expect(sprintPatchSchema.safeParse({ status: "closed" }).success).toBe(true);
  });

  it("accepts releases with story ids and rejects a missing version", () => {
    expect(releaseCreateSchema.safeParse({ projectId: "p", name: "v1", version: "1.0.0", storyIds: ["s1"] }).success).toBe(true);
    expect(releaseCreateSchema.safeParse({ projectId: "p", name: "v1" }).success).toBe(false);
  });
});

describe("agile schemas — story submission", () => {
  it("defaults to a real run and accepts overrides", () => {
    const parsed = storySubmitSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mode).toBe("real");
    expect(storySubmitSchema.safeParse({ mode: "demo", checks: ["npm test"] }).success).toBe(true);
  });

  it("rejects an unknown mode and a too-short idempotency key", () => {
    expect(storySubmitSchema.safeParse({ mode: "production" }).success).toBe(false);
    expect(storySubmitSchema.safeParse({ idempotencyKey: "short" }).success).toBe(false);
  });
});

describe("agile schemas — model templates", () => {
  const models = { developerModel: { provider: "deepseek", model: "flash" }, reviewerModel: { provider: "openai-proxy", model: "gpt" } };

  it("accepts a minimal template and one with budget + parallel", () => {
    const minimal = templateCreateSchema.safeParse({ name: "  快速  ", ...models });
    expect(minimal.success).toBe(true);
    if (minimal.success) expect(minimal.data.name).toBe("快速");
    expect(templateCreateSchema.safeParse({
      name: "省钱",
      ...models,
      budget: { maxTokens: 1000, maxCostUsd: 1, maxModelCalls: 5, maxDurationSeconds: 60 },
      maxParallel: 2,
    }).success).toBe(true);
  });

  it("rejects a missing model, an out-of-range parallel and unknown fields", () => {
    expect(templateCreateSchema.safeParse({ name: "x", developerModel: models.developerModel }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "x", ...models, maxParallel: 0 }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "x", ...models, ownerId: "someone-else" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "", ...models }).success).toBe(false);
  });
});
