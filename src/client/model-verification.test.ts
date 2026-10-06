import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../shared/types";
import { availabilityLabel, modelCapabilityHint, modelVerificationState, verificationBadge } from "./model-verification";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "deepseek/deepseek-chat",
    provider: "deepseek",
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    toolCalling: true,
    reasoning: false,
    roles: ["developer"],
    status: "available",
    available: true,
    unavailableReason: null,
    ...overrides,
  };
}

describe("verificationBadge (AUD-08)", () => {
  it("labels a live-verified key as 已验证 with an ok tone", () => {
    const badge = verificationBadge(model({ verification: "live", verificationLabel: "已验证" }));
    expect(badge.state).toBe("live");
    expect(badge.label).toBe("已验证");
    expect(badge.tone).toBe("ok");
  });

  it("never claims verified for an operator-asserted key", () => {
    const badge = verificationBadge(model({ verification: "operator_asserted", verificationLabel: "未校验（操作者断言）" }));
    expect(badge.label).toBe("未校验（操作者断言）");
    expect(badge.tone).toBe("warn");
  });

  it("falls back to the conventional copy when the server omits verificationLabel", () => {
    expect(verificationBadge(model({ verification: "operator_asserted" })).label).toBe("未校验（操作者断言）");
    expect(verificationBadge(model({ verification: "unchecked" })).label).toBe("未校验");
    expect(verificationBadge(model({ verification: "unchecked" })).tone).toBe("warn");
  });

  it("falls back to the English catalog copy", () => {
    expect(verificationBadge(model({ verification: "operator_asserted" }), "en").label).toBe("Unverified (operator asserted)");
    expect(verificationBadge(model({ verification: "live" }), "en").title).toContain("live /models probe");
    expect(modelCapabilityHint(model({ verification: "live", capabilitiesVerified: true, capabilities: { contextWindow: 64_000 } }), "en")?.label)
      .toBe("Capabilities · runtime");
    expect(availabilityLabel(model({ available: false, unavailableReason: "credential_missing" }), "en")).toBe("No credential");
  });

  it("derives the state for responses that predate the field", () => {
    expect(modelVerificationState(model({ verified: true }))).toBe("live");
    expect(modelVerificationState(model({ asserted: true, verified: false }))).toBe("operator_asserted");
    expect(modelVerificationState(model({}))).toBe("unchecked");
  });
});

describe("modelCapabilityHint (AUD-08 / AT-MODEL-001)", () => {
  it("marks runtime-verified capabilities only for a live-verified model", () => {
    const hint = modelCapabilityHint(model({ verification: "live", capabilitiesVerified: true, capabilities: { contextWindow: 64_000 } }));
    expect(hint?.runtimeVerified).toBe(true);
    expect(hint?.label).toBe("能力·运行时");
  });

  it("treats capabilities as catalog-only when the credential is merely asserted", () => {
    const hint = modelCapabilityHint(model({ verification: "operator_asserted", capabilitiesVerified: true, capabilities: { contextWindow: 64_000 } }));
    expect(hint?.runtimeVerified).toBe(false);
    expect(hint?.label).toBe("能力·目录");
  });

  it("returns no hint when the model carries no capability values", () => {
    expect(modelCapabilityHint(model({ contextWindow: undefined, maxOutputTokens: undefined, capabilities: null }))).toBeUndefined();
  });
});

describe("availabilityLabel (AUD-08)", () => {
  it("separates availability from verification", () => {
    expect(availabilityLabel(model({ available: true, unavailableReason: null }))).toBe("可用");
    expect(availabilityLabel(model({ available: false, unavailableReason: "credential_missing" }))).toBe("缺凭据");
    expect(availabilityLabel(model({ available: false, unavailableReason: "model_unverified" }))).toBe("模型未校验");
    expect(availabilityLabel(model({ available: false, unavailableReason: "credential_unverified" }))).toBe("待校验");
    expect(availabilityLabel(model({ available: false, unavailableReason: "role_restricted" }))).toBe("角色受限");
  });
});
