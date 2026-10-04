import { describe, expect, it } from "vitest";
import { createProviderProbe, providerBaseUrl, providerProbeDisabled } from "./provider-probe.js";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

describe("provider probe", () => {
  it("resolves provider base urls and honours explicit overrides", () => {
    expect(providerBaseUrl("deepseek", {} as NodeJS.ProcessEnv)).toContain("deepseek");
    expect(providerBaseUrl("openai-proxy", { OPENAI_BASE_URL: "https://proxy.example/v1/" } as NodeJS.ProcessEnv)).toBe("https://proxy.example/v1");
    expect(providerBaseUrl("custom", { PI_PROVIDER_PROBE_BASE_URL: "https://custom.example" } as NodeJS.ProcessEnv)).toBe("https://custom.example");
    expect(providerBaseUrl("custom", {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(providerProbeDisabled({ PI_MODEL_PROBE_MODE: "off" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("returns the provider model ids on a successful probe (AT-MODEL-001/004)", async () => {
    const calls: string[] = [];
    const probe = createProviderProbe({
      env: { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push(String(url));
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
        return jsonResponse({ data: [{ id: "deepseek-chat" }, { id: "deepseek-flash" }] });
      }) as unknown as typeof fetch,
    });
    const result = await probe({ provider: "deepseek", apiKey: "secret-key" });
    expect(result).toMatchObject({ ok: true, models: ["deepseek-chat", "deepseek-flash"] });
    expect(calls).toEqual(["https://provider.example/v1/models"]);
  });

  it("classifies unauthorized and unreachable probes without throwing (AT-MODEL-004/012)", async () => {
    const base = { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv;
    const unauthorized = createProviderProbe({
      env: base,
      fetchImpl: (async () => jsonResponse({ error: "invalid api key" }, 401)) as unknown as typeof fetch,
    });
    expect(await unauthorized({ provider: "deepseek", apiKey: "bad-key" })).toMatchObject({ ok: false, code: "PROBE_UNAUTHORIZED" });

    const unreachable = createProviderProbe({
      env: base,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(await unreachable({ provider: "deepseek", apiKey: "key" })).toMatchObject({ ok: false, code: "PROBE_UNREACHABLE" });
  });

  it("reports unsupported when no probe endpoint is known", async () => {
    const probe = createProviderProbe({ env: {} as NodeJS.ProcessEnv });
    expect(await probe({ provider: "unknown-provider", apiKey: "key" })).toMatchObject({ ok: false, code: "PROBE_UNSUPPORTED" });
  });

  it("captures provider-reported capabilities when present (AT-MODEL-001)", async () => {
    const probe = createProviderProbe({
      env: { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv,
      fetchImpl: (async () => jsonResponse({
        data: [
          {
            id: "deepseek-chat",
            context_window: 128000,
            max_output_tokens: 8192,
            capabilities: { tool_calling: true, reasoning: false },
          },
          {
            id: "deepseek-reasoner",
            context_length: "65536",
            top_provider: { max_completion_tokens: 4096 },
            supported_parameters: ["tools", "reasoning"],
          },
        ],
      })) as unknown as typeof fetch,
    });
    const result = await probe({ provider: "deepseek", apiKey: "secret-key" });
    expect(result).toMatchObject({
      ok: true,
      models: ["deepseek-chat", "deepseek-reasoner"],
      capabilities: {
        "deepseek-chat": { contextWindow: 128000, maxOutputTokens: 8192, toolCalling: true, reasoning: false },
        "deepseek-reasoner": { contextWindow: 65536, maxOutputTokens: 4096, toolCalling: true, reasoning: true },
      },
    });
  });

  it("never invents capabilities the provider did not report (AT-MODEL-001)", async () => {
    const probe = createProviderProbe({
      env: { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv,
      fetchImpl: (async () => jsonResponse({ data: [{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }] })) as unknown as typeof fetch,
    });
    const result = await probe({ provider: "deepseek", apiKey: "secret-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual(["deepseek-chat"]);
      expect(result.capabilities).toBeUndefined();
    }
  });

  it("ignores malformed items without failing the probe (AT-MODEL-001)", async () => {
    const probe = createProviderProbe({
      env: { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv,
      fetchImpl: (async () => jsonResponse({
        models: [null, "not-an-object", { id: "ok-model", context_window: "abc", reasoning: "maybe" }, { noId: true, context_window: 10 }],
      })) as unknown as typeof fetch,
    });
    const result = await probe({ provider: "deepseek", apiKey: "secret-key" });
    expect(result).toMatchObject({ ok: true, models: ["ok-model"] });
    if (result.ok) expect(result.capabilities).toBeUndefined();
  });

  it("ignores a non-object /models body gracefully", async () => {
    const probe = createProviderProbe({
      env: { PI_PROVIDER_PROBE_BASE_URL: "https://provider.example/v1" } as NodeJS.ProcessEnv,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => 42 }) as Response) as unknown as typeof fetch,
    });
    expect(await probe({ provider: "deepseek", apiKey: "secret-key" })).toMatchObject({ ok: true, models: [] });
  });
});
