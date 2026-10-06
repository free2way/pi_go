import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelRole } from "./types";
import {
  catalogEntriesForRole,
  isModelSelectableForRole,
  modelSelectionDecision,
  MODEL_ROLES,
  roleCovered,
  selectableModelsForRole,
} from "./model-select";

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

describe("model selection predicate (AUD-09)", () => {
  it("accepts an available model that carries the role", () => {
    const decision = modelSelectionDecision(model(), "reviewer");
    expect(decision).toEqual({ selectable: true, code: null, reasonKey: null });
    expect(isModelSelectableForRole(model(), "reviewer")).toBe(true);
  });

  it("rejects a pair absent from the allow-list with MODEL_NOT_FOUND", () => {
    // /api/models never returns it; the dialog asks about an unknown id.
    expect(modelSelectionDecision(undefined, "reviewer")).toEqual({
      selectable: false,
      code: "MODEL_NOT_FOUND",
      reasonKey: "createRun.modelUnavailable.catalog",
    });
    expect(isModelSelectableForRole(null, "developer")).toBe(false);
  });

  it("rejects a known model whose role capability is missing with MODEL_NOT_ALLOWED", () => {
    const entry = model({ roles: ["developer"] });
    expect(modelSelectionDecision(entry, "reviewer")).toEqual({
      selectable: false,
      code: "MODEL_NOT_ALLOWED",
      reasonKey: "createRun.modelUnavailable.role",
    });
    expect(isModelSelectableForRole(entry, "developer")).toBe(true);
  });

  it("rejects a provider with no configured credential with MODEL_UNAVAILABLE", () => {
    const entry = model({ available: false, unavailableReason: "credential_missing" });
    expect(modelSelectionDecision(entry, "reviewer")).toEqual({
      selectable: false,
      code: "MODEL_UNAVAILABLE",
      reasonKey: "createRun.missingCredentialSuffix",
    });
  });

  it("rejects an unverified credential with MODEL_NOT_AVAILABLE", () => {
    const entry = model({ available: false, unavailableReason: "credential_unverified" });
    expect(modelSelectionDecision(entry, "reviewer")).toEqual({
      selectable: false,
      code: "MODEL_NOT_AVAILABLE",
      reasonKey: "createRun.modelUnavailable.unverified",
    });
  });

  it("rejects a model the provider probe did not enumerate with MODEL_NOT_AVAILABLE", () => {
    const entry = model({ available: false, unavailableReason: "model_unverified" });
    expect(modelSelectionDecision(entry, "developer")).toEqual({
      selectable: false,
      code: "MODEL_NOT_AVAILABLE",
      reasonKey: "createRun.modelUnavailable.model",
    });
  });

  it("maps an empty-role entry to MODEL_NOT_ALLOWED", () => {
    const entry = model({ roles: [], available: false, unavailableReason: "role_restricted" });
    expect(modelSelectionDecision(entry, "reviewer").code).toBe("MODEL_NOT_ALLOWED");
    expect(modelSelectionDecision(entry, "reviewer").reasonKey).toBe("createRun.modelUnavailable.role");
  });

  it("stays conservative for unknown availability states and legacy payloads", () => {
    // A state the predicate does not understand must never become an enabled
    // option: the run preflight is the one that decides.
    expect(modelSelectionDecision(model({ available: false, unavailableReason: null }), "reviewer")).toEqual({
      selectable: false,
      code: "MODEL_NOT_AVAILABLE",
      reasonKey: "createRun.modelUnavailable.unknown",
    });
    expect(isModelSelectableForRole({ roles: ["reviewer"], available: undefined as never, unavailableReason: null }, "reviewer")).toBe(false);
  });

  it("filters the catalogue per role: absent for unlisted, disabled for unusable", () => {
    const entries: ModelInfo[] = [
      model({ id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat" }),
      model({ id: "deepseek/gpt-5.6-sol", provider: "deepseek", model: "gpt-5.6-sol", roles: ["reviewer"], available: false, unavailableReason: "model_unverified" }),
      model({ id: "openai-proxy/gpt-5.6-sol", provider: "openai-proxy", model: "gpt-5.6-sol", roles: ["reviewer"] }),
      model({ id: "deepseek/deepseek-flash", provider: "deepseek", model: "deepseek-flash", roles: ["developer"] }),
    ];
    expect(catalogEntriesForRole(entries, "reviewer").map((entry) => entry.id)).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/gpt-5.6-sol",
      "openai-proxy/gpt-5.6-sol",
    ]);
    expect(selectableModelsForRole(entries, "reviewer").map((entry) => entry.id)).toEqual([
      "deepseek/deepseek-chat",
      "openai-proxy/gpt-5.6-sol",
    ]);
    expect(roleCovered(entries, "reviewer")).toBe(true);
    // A role only covered by unusable models is not "covered" in the sense the
    // dialog needs: it shows the configuration notice instead.
    const uncovered: ModelInfo[] = [model({ roles: ["reviewer"], available: false, unavailableReason: "credential_missing" })];
    expect(roleCovered(uncovered, "reviewer")).toBe(false);
    expect(roleCovered([], "developer")).toBe(false);
    expect(MODEL_ROLES).toEqual(["developer", "reviewer"]);
  });

  it("keeps every role in MODEL_ROLES", () => {
    const roles: ModelRole[] = ["developer", "reviewer"];
    expect([...MODEL_ROLES]).toEqual(roles);
  });
});
