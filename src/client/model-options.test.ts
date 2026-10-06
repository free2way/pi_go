import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../shared/types";
import { buildRoleModelOptions, modelOptionText, preferredModelId, roleUncovered, selectableModelIds } from "./model-options";

const model = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "deepseek/deepseek-chat",
  provider: "deepseek",
  model: "deepseek-chat",
  label: "DeepSeek Chat",
  toolCalling: true,
  reasoning: false,
  roles: ["developer", "reviewer"],
  status: "available",
  available: true,
  unavailableReason: null,
  ...overrides,
});

const rejectedPairModel = model({
  id: "deepseek/gpt-5.6-sol",
  provider: "deepseek",
  model: "gpt-5.6-sol",
  label: "gpt-5.6-sol",
  roles: ["reviewer"],
  available: false,
  unavailableReason: "model_unverified",
});

const otherProviderSameModel = model({
  id: "openai-proxy/gpt-5.6-sol",
  provider: "openai-proxy",
  model: "gpt-5.6-sol",
  label: "GPT-5.6 Sol",
  roles: ["reviewer"],
});

const developerOnly = model({
  id: "deepseek/deepseek-flash",
  provider: "deepseek",
  model: "deepseek-flash",
  label: "DeepSeek Flash",
  roles: ["developer"],
});

describe("create-run model options (AUD-09)", () => {
  it("renders the provider next to the model so same-named pairs are distinguishable", () => {
    const [option] = buildRoleModelOptions([otherProviderSameModel], "reviewer");
    expect(modelOptionText(option)).toBe("GPT-5.6 Sol · openai-proxy/gpt-5.6-sol");
  });

  it("offers an unusable pair only as a disabled option with an explanation", () => {
    const options = buildRoleModelOptions([rejectedPairModel, otherProviderSameModel], "reviewer");
    expect(options).toHaveLength(2);
    const rejected = options.find((option) => option.pair === "deepseek/gpt-5.6-sol");
    expect(rejected?.selectable).toBe(false);
    expect(rejected?.code).toBe("MODEL_NOT_AVAILABLE");
    expect(rejected?.reason).toBe("（该 provider 未声明支持此模型）");
    expect(modelOptionText(rejected!)).toBe("gpt-5.6-sol · deepseek/gpt-5.6-sol（该 provider 未声明支持此模型）");
    expect(options.find((option) => option.pair === "openai-proxy/gpt-5.6-sol")?.selectable).toBe(true);
  });

  it("keeps entries the catalogue does not expose for the role absent", () => {
    const options = buildRoleModelOptions([developerOnly, otherProviderSameModel], "reviewer");
    expect(options.map((option) => option.id)).toEqual(["openai-proxy/gpt-5.6-sol"]);
  });

  it("never preselects a pair the preflight would reject", () => {
    const entries = [rejectedPairModel, otherProviderSameModel];
    expect(preferredModelId(entries, "reviewer", { provider: "deepseek", model: "gpt-5.6-sol" })).toBe("openai-proxy/gpt-5.6-sol");
    expect(preferredModelId([rejectedPairModel], "reviewer", { provider: "deepseek", model: "gpt-5.6-sol" })).toBe("");
    expect(preferredModelId(entries, "reviewer", { provider: "openai-proxy", model: "gpt-5.6-sol" })).toBe("openai-proxy/gpt-5.6-sol");
  });

  it("exposes only selectable ids for submit gating", () => {
    expect(selectableModelIds([rejectedPairModel, otherProviderSameModel], "reviewer")).toEqual(["openai-proxy/gpt-5.6-sol"]);
    expect(selectableModelIds([developerOnly], "reviewer")).toEqual([]);
  });

  it("flags an uncovered role so the dialog can explain MODEL_CONFIG_INVALID", () => {
    expect(roleUncovered([developerOnly], "reviewer")).toBe(true);
    expect(roleUncovered([otherProviderSameModel], "reviewer")).toBe(false);
    expect(roleUncovered(undefined, "developer")).toBe(true);
  });

  it("localizes the explanation", () => {
    const [option] = buildRoleModelOptions([rejectedPairModel], "reviewer", "en");
    expect(option.reason).toBe(" (this provider does not list the model)");
    expect(roleUncovered([rejectedPairModel], "reviewer")).toBe(true);
  });
});
