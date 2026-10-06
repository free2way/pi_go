import { describe, expect, it } from "vitest";
import { DECISION_ENGINE_DEFAULTS, loadDecisionEngineConfig } from "./config.js";

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ ...overrides }) as NodeJS.ProcessEnv;

describe("loadDecisionEngineConfig — defaults", () => {
  it("defaults to disabled/off with no credentials and never leaks a key", () => {
    const result = loadDecisionEngineConfig(env());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      engine: "disabled",
      mode: "off",
      baseUrl: DECISION_ENGINE_DEFAULTS.baseUrl,
      model: "jev-latest",
      timeoutMs: 3000,
      maxAttempts: 2,
      maxStateTokens: 24000,
      maxStateBytes: 262144,
      reviewMaxFindings: 50,
      shadowSampleRate: 1,
      policyVersion: "review-triage-v1",
      allowSource: false,
      hasApiKey: false,
    });
    // The key is presence-only: no field on the config may carry its value.
    expect(JSON.stringify(result.config)).not.toContain("secret");
  });

  it("treats blank values as absent (defaults)", () => {
    const result = loadDecisionEngineConfig(
      env({ PI_DECISION_ENGINE: "  ", PI_JEV_TIMEOUT_MS: "", PI_JEV_MODEL: "", PI_JEV_POLICY_VERSION: "   " }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.engine).toBe("disabled");
    expect(result.config.timeoutMs).toBe(3000);
    expect(result.config.model).toBe("jev-latest");
    expect(result.config.policyVersion).toBe("review-triage-v1");
  });

  it("records key presence without the value and accepts an empty key as absent for mock", () => {
    const result = loadDecisionEngineConfig(env({ PI_DECISION_ENGINE: "mock", TYPESAFE_API_KEY: "sk-super-secret" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.hasApiKey).toBe(true);
    expect(JSON.stringify(result.config)).not.toContain("sk-super-secret");
  });
});

describe("loadDecisionEngineConfig — strict validation", () => {
  it.each([
    ["PI_DECISION_ENGINE", "yes"],
    ["PI_JEV_MODE", "sometimes"],
    ["PI_JEV_TIMEOUT_MS", "-1"],
    ["PI_JEV_TIMEOUT_MS", "0"],
    ["PI_JEV_TIMEOUT_MS", "1.5"],
    ["PI_JEV_TIMEOUT_MS", "soon"],
    ["PI_JEV_MAX_ATTEMPTS", "0"],
    ["PI_JEV_STATE_MAX_TOKENS", "0"],
    ["PI_JEV_STATE_MAX_BYTES", "not-a-number"],
    ["PI_JEV_REVIEW_MAX_FINDINGS", "-3"],
    ["PI_JEV_SHADOW_SAMPLE_RATE", "1.0001"],
    ["PI_JEV_SHADOW_SAMPLE_RATE", "-0.1"],
    ["PI_JEV_SHADOW_SAMPLE_RATE", "mostly"],
    ["PI_JEV_BASE_URL", "ftp://example.com"],
    ["PI_JEV_BASE_URL", "not a url"],
  ])("rejects %s=%s as invalid_configuration", (key, value) => {
    const result = loadDecisionEngineConfig(env({ [key]: value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_configuration");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("never degrades an invalid value to a宽松 default", () => {
    const result = loadDecisionEngineConfig(env({ PI_JEV_MODE: "loud" }));
    expect(result.ok).toBe(false);
  });

  it("rejects PI_JEV_ALLOW_SOURCE=true with invalid_configuration even with a valid key", () => {
    const result = loadDecisionEngineConfig(
      env({ PI_DECISION_ENGINE: "jev", TYPESAFE_API_KEY: "sk-x", PI_JEV_ALLOW_SOURCE: "true" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_configuration");
    expect(result.detail).toContain("PI_JEV_ALLOW_SOURCE");
  });

  it("rejects a non-boolean PI_JEV_ALLOW_SOURCE", () => {
    const result = loadDecisionEngineConfig(env({ PI_JEV_ALLOW_SOURCE: "maybe" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_configuration");
  });

  it("never includes the secret value in an error detail", () => {
    const result = loadDecisionEngineConfig(
      env({ PI_DECISION_ENGINE: "jev", TYPESAFE_API_KEY: "sk-do-not-log-me", PI_JEV_MODE: "broken" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain("sk-do-not-log-me");
  });
});

describe("loadDecisionEngineConfig — credentials", () => {
  it("requires a key for engine=jev (missing_credentials)", () => {
    const result = loadDecisionEngineConfig(env({ PI_DECISION_ENGINE: "jev", PI_JEV_MODE: "shadow" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_credentials");
  });

  it("accepts engine=jev with a key and preserves the requested mode", () => {
    const result = loadDecisionEngineConfig(
      env({ PI_DECISION_ENGINE: "jev", TYPESAFE_API_KEY: "sk-x", PI_JEV_MODE: "assist" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.engine).toBe("jev");
    expect(result.config.mode).toBe("assist");
    expect(result.config.hasApiKey).toBe(true);
  });

  it("does not require a key for mock", () => {
    const result = loadDecisionEngineConfig(env({ PI_DECISION_ENGINE: "mock", PI_JEV_MODE: "shadow" }));
    expect(result.ok).toBe(true);
  });

  it("accepts sample rate boundaries 0 and 1", () => {
    for (const value of ["0", "1", "0.25"]) {
      const result = loadDecisionEngineConfig(env({ PI_JEV_SHADOW_SAMPLE_RATE: value }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.shadowSampleRate).toBe(Number(value));
    }
  });
});
