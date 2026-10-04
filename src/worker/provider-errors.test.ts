import { describe, expect, it } from "vitest";
import { apiKeyEnvName, classifyProviderError, providerErrorSummary } from "./provider-errors.js";

describe("provider error classification", () => {
  it("classifies credential, rate limit, timeout, unsupported and provider failures", () => {
    expect(classifyProviderError('401: {"message":"Authentication Fails, Your api key: ****1234 is invalid"}')).toBe("credential");
    expect(classifyProviderError("429 Too Many Requests: no available OpenAI accounts supporting model") ).toBe("rate_limit");
    expect(classifyProviderError("Error: request timed out after 60000ms")).toBe("timeout");
    expect(classifyProviderError('Error: Unknown provider "openai-proxy". Use --list-models')).toBe("unsupported");
    expect(classifyProviderError("502 Bad Gateway")).toBe("provider");
    expect(classifyProviderError("something unusual happened")).toBe("unknown");
  });

  it("maps providers onto Pi key environment variables", () => {
    expect(apiKeyEnvName("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(apiKeyEnvName("openai-proxy")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvName("acme-models")).toBe("ACME_MODELS_API_KEY");
  });

  it("renders an actionable summary", () => {
    const summary = providerErrorSummary("credential", "api key invalid");
    expect(summary).toContain("分类：credential");
    expect(summary).toContain("模型与凭据");
  });
});
