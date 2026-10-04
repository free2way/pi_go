import { describe, expect, it } from "vitest";
import type { ProviderAvailability } from "../shared/types.js";
import {
  availableModels,
  defaultSelections,
  findModel,
  loadModelCatalog,
  parseModelCatalogJson,
  preflightRunModels,
  providerModelState,
  validateModelSelection,
} from "./model-catalog.js";

const verified = (provider: string, models: string[] | null = null): ProviderAvailability => ({
  provider,
  configured: true,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  verifiedModels: models,
});

describe("model catalog", () => {
  it("merges configured role defaults into the builtin catalog", () => {
    const env = {
      PI_DEVELOPER_PROVIDER: "acme",
      PI_DEVELOPER_MODEL: "m1",
      PI_REVIEWER_PROVIDER: "openai-proxy",
      PI_REVIEWER_MODEL: "gpt-5.6-sol",
    } as NodeJS.ProcessEnv;
    const entries = loadModelCatalog(env);
    expect(findModel(entries, "acme", "m1")).toBeDefined();
    expect(findModel(entries, "deepseek", "deepseek-flash")).toBeDefined();
    expect(findModel(entries, "openai-proxy", "gpt-5.6-sol")).toBeDefined();
  });

  it("treats an explicit allowlist as strict and does not grow it with defaults (AT-MODEL-002)", () => {
    const env = {
      PI_MODEL_CATALOG_JSON: JSON.stringify([{ provider: "acme", model: "m1", roles: ["developer"], label: "M1" }]),
      PI_DEVELOPER_PROVIDER: "deepseek",
      PI_DEVELOPER_MODEL: "deepseek-flash",
      PI_REVIEWER_PROVIDER: "openai-proxy",
      PI_REVIEWER_MODEL: "gpt-5.6-sol",
    } as NodeJS.ProcessEnv;
    const entries = loadModelCatalog(env);
    expect(entries).toHaveLength(1);
    expect(findModel(entries, "acme", "m1")).toBeDefined();
    // Defaults must NOT be appended, and roles must NOT be extended.
    expect(findModel(entries, "deepseek", "deepseek-flash")).toBeUndefined();
    expect(findModel(entries, "openai-proxy", "gpt-5.6-sol")).toBeUndefined();
    expect(entries[0].roles).toEqual(["developer"]);
    // The default reviewer selection is no longer in the catalog.
    expect(validateModelSelection(entries, "reviewer", { provider: "openai-proxy", model: "gpt-5.6-sol" }, []))
      .toMatchObject({ ok: false, code: "MODEL_CONFIG_INVALID" });
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

  it("does not treat a length-valid but unverified key as available (AT-MODEL-004)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [
      { provider: "deepseek", configured: true, verifiedAt: null, verifiedModels: null },
    ];
    const models = availableModels(entries, availability);
    const flash = models.find((entry) => entry.provider === "deepseek" && entry.model === "deepseek-flash");
    expect(flash?.available).toBe(false);
    expect(flash?.unavailableReason).toBe("credential_unverified");
    expect(flash?.verified).toBe(false);
    expect(providerModelState(availability, "deepseek", "deepseek-flash")).toBe("unverified");
    expect(validateModelSelection(entries, "developer", { provider: "deepseek", model: "deepseek-flash" }, availability))
      .toMatchObject({ ok: false, code: "MODEL_NOT_AVAILABLE" });
  });

  it("reports a model the provider probe did not enumerate (AT-MODEL-001/004)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [
      { provider: "deepseek", configured: true, verifiedAt: "2026-01-01T00:00:00.000Z", verifiedModels: ["deepseek-chat"] },
    ];
    const models = availableModels(entries, availability);
    expect(models.find((entry) => entry.model === "deepseek-chat")?.available).toBe(true);
    const flash = models.find((entry) => entry.model === "deepseek-flash");
    expect(flash?.available).toBe(false);
    expect(flash?.unavailableReason).toBe("model_unverified");
    expect(providerModelState(availability, "deepseek", "deepseek-flash")).toBe("model_unverified");
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

  it("applies runtime capability overrides to catalog entries (AT-MODEL-001)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const models = availableModels(entries, new Set(["deepseek"]), {
      "deepseek/deepseek-flash": { reasoning: true, contextWindow: 64_000 },
    });
    const flash = models.find((entry) => entry.model === "deepseek-flash");
    expect(flash?.reasoning).toBe(true);
    expect(flash?.contextWindow).toBe(64_000);
  });

  it("treats operator-asserted credentials as usable but not verified (AUD-08)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [
      { provider: "deepseek", configured: true, verifiedAt: null, verifiedModels: null, verification: "operator_asserted", asserted: true },
    ];
    // Preflight passes for the opt-out path so real runs remain possible…
    expect(preflightRunModels(
      entries,
      { developer: { provider: "deepseek", model: "deepseek-flash" }, reviewer: { provider: "deepseek", model: "deepseek-chat" } },
      availability,
    ).ok).toBe(true);
    // …but the model is never presented as verified.
    const flash = availableModels(entries, availability).find((entry) => entry.model === "deepseek-flash");
    expect(flash?.available).toBe(true);
    expect(flash?.verified).toBe(false);
    expect(flash?.asserted).toBe(true);
    expect(flash?.verification).toBe("operator_asserted");
    expect(flash?.verificationLabel).toBe("未校验（操作者断言）");
    expect(providerModelState(availability, "deepseek", "deepseek-flash")).toBe("asserted");
    // Asserted credentials carry no per-model restriction.
    expect(validateModelSelection(entries, "developer", { provider: "deepseek", model: "deepseek-flash" }, availability).ok).toBe(true);
  });

  it("prefers a live verification over an older assertion (AUD-08)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [
      {
        provider: "deepseek",
        configured: true,
        verifiedAt: "2026-01-01T00:00:00.000Z",
        verifiedModels: ["deepseek-chat"],
        verification: "live",
      },
    ];
    const flash = availableModels(entries, availability).find((entry) => entry.model === "deepseek-flash");
    expect(flash?.available).toBe(false);
    expect(flash?.unavailableReason).toBe("model_unverified");
  });

  it("surfaces provider-reported capabilities and flags them as verified (AT-MODEL-001)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [
      {
        provider: "deepseek",
        configured: true,
        verifiedAt: "2026-01-01T00:00:00.000Z",
        verifiedModels: ["deepseek-flash", "deepseek-chat"],
        verification: "live",
        capabilities: { "deepseek-flash": { contextWindow: 128_000, maxOutputTokens: 8_192, toolCalling: true, reasoning: true } },
      },
    ];
    const models = availableModels(entries, availability);
    const flash = models.find((entry) => entry.model === "deepseek-flash");
    expect(flash?.contextWindow).toBe(128_000);
    expect(flash?.maxOutputTokens).toBe(8_192);
    expect(flash?.toolCalling).toBe(true);
    expect(flash?.reasoning).toBe(true);
    expect(flash?.capabilitiesVerified).toBe(true);
    // A model the probe enumerated but reported no capabilities for keeps the
    // catalog values, flagged as not runtime-verified.
    const chat = models.find((entry) => entry.model === "deepseek-chat");
    expect(chat?.capabilitiesVerified).toBe(false);
    expect(chat?.capabilities).toBeNull();
  });

  it("passes preflight when one provider serves both roles (AT-MODEL-007/008)", () => {
    const entries = loadModelCatalog({
      PI_MODEL_CATALOG_JSON: JSON.stringify([
        { provider: "deepseek", model: "deepseek-chat", roles: ["developer", "reviewer"], label: "DeepSeek Chat" },
      ]),
    } as NodeJS.ProcessEnv);
    const availability: ProviderAvailability[] = [verified("deepseek", ["deepseek-chat"])];
    const result = preflightRunModels(
      entries,
      { developer: { provider: "deepseek", model: "deepseek-chat" }, reviewer: { provider: "deepseek", model: "deepseek-chat" } },
      availability,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roles.developer.provider).toBe("deepseek");
      expect(result.roles.reviewer.provider).toBe("deepseek");
    }
  });

  it("fails preflight early with a clear code for an unusable role model (AT-MODEL-008)", () => {
    const entries = loadModelCatalog({} as NodeJS.ProcessEnv);
    const missing = preflightRunModels(
      entries,
      { developer: { provider: "deepseek", model: "deepseek-flash" }, reviewer: { provider: "openai-proxy", model: "gpt-5.6-sol" } },
      [{ provider: "deepseek", configured: true, verifiedAt: "2026-01-01T00:00:00.000Z", verifiedModels: null }],
    );
    expect(missing).toMatchObject({ ok: false, role: "reviewer", code: "MODEL_UNAVAILABLE" });

    const unverified = preflightRunModels(
      entries,
      { developer: { provider: "deepseek", model: "deepseek-flash" }, reviewer: { provider: "deepseek", model: "deepseek-chat" } },
      [{ provider: "deepseek", configured: true, verifiedAt: null, verifiedModels: null }],
    );
    expect(unverified).toMatchObject({ ok: false, role: "developer", code: "MODEL_NOT_AVAILABLE" });
  });

  it("fails preflight when a strict allowlist leaves a role uncovered (AT-MODEL-002/008)", () => {
    const entries = loadModelCatalog({
      PI_MODEL_CATALOG_JSON: JSON.stringify([{ provider: "acme", model: "m1", roles: ["reviewer"], label: "M1" }]),
    } as NodeJS.ProcessEnv);
    const result = preflightRunModels(
      entries,
      { developer: { provider: "acme", model: "m1" }, reviewer: { provider: "acme", model: "m1" } },
      [verified("acme", ["m1"])],
    );
    expect(result).toMatchObject({ ok: false, role: "developer", code: "MODEL_CONFIG_INVALID" });
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
