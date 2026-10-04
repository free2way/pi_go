import { describe, expect, it } from "vitest";
import {
  availableModels,
  defaultSelections,
  findModel,
  loadModelCatalog,
  parseModelCatalogJson,
  validateModelSelection,
} from "./model-catalog.js";

describe("model catalog", () => {
  it("always includes the configured role defaults", () => {
    const env = {
      PI_MODEL_CATALOG_JSON: JSON.stringify([{ provider: "acme", model: "m1", roles: ["developer"], label: "M1" }]),
      PI_DEVELOPER_PROVIDER: "deepseek",
      PI_DEVELOPER_MODEL: "deepseek-flash",
      PI_REVIEWER_PROVIDER: "openai-proxy",
      PI_REVIEWER_MODEL: "gpt-5.6-sol",
    } as NodeJS.ProcessEnv;
    const entries = loadModelCatalog(env);
    expect(findModel(entries, "acme", "m1")).toBeDefined();
    expect(findModel(entries, "deepseek", "deepseek-flash")).toBeDefined();
    expect(findModel(entries, "openai-proxy", "gpt-5.6-sol")).toBeDefined();
  });

  it("rejects unknown, role-restricted and uncredentialed models", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const configured = new Set(["deepseek"]);
    expect(validateModelSelection(entries, "developer", { provider: "ghost", model: "x" }, configured))
      .toMatchObject({ ok: false, code: "MODEL_NOT_FOUND" });
    expect(validateModelSelection(entries, "developer", { provider: "openai-proxy", model: "gpt-5.6-sol" }, configured))
      .toMatchObject({ ok: false, code: "MODEL_NOT_ALLOWED" });
    expect(validateModelSelection(entries, "reviewer", { provider: "openai-proxy", model: "gpt-5.6-sol" }, configured))
      .toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(validateModelSelection(entries, "developer", { provider: "deepseek", model: "deepseek-flash" }, configured))
      .toMatchObject({ ok: true });
  });

  it("marks availability from configured providers and ignores broken catalog json", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const models = availableModels(entries, new Set(["deepseek"]));
    expect(models.find((entry) => entry.provider === "deepseek")?.available).toBe(true);
    expect(models.find((entry) => entry.provider === "openai-proxy")?.unavailableReason).toBe("credential_missing");
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(new Set(models.map((entry) => entry.provider)).size).toBeGreaterThanOrEqual(2);
    expect(parseModelCatalogJson("{not json")).toBeUndefined();
  });

  it("exposes the configured defaults", () => {
    const defaults = defaultSelections({
      PI_DEVELOPER_PROVIDER: "deepseek",
      PI_DEVELOPER_MODEL: "deepseek-chat",
      PI_REVIEWER_PROVIDER: "openai-proxy",
      PI_REVIEWER_MODEL: "gpt-5.6-luna",
    } as NodeJS.ProcessEnv);
    expect(defaults.developer).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(defaults.reviewer).toEqual({ provider: "openai-proxy", model: "gpt-5.6-luna" });
  });
});
