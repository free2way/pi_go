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
});
