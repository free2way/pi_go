/**
 * AUD-08 / AT-MODEL-004: a stored API key is not proof of availability. This
 * probe performs a cheap live `GET {base}/models` against the provider so a
 * credential can be marked verified (`verifiedAt` + `verifiedModels`) instead of
 * being trusted purely because its length looked valid.
 *
 * The probe is intentionally injectable: `fetchImpl` can be stubbed in tests and
 * the endpoint map can be overridden per deployment, so unit tests never need a
 * real network call.
 */

export interface ModelCapabilityOverride {
  toolCalling?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
}

export type ProviderProbeResult =
  | { ok: true; models: string[]; capabilities?: Record<string, ModelCapabilityOverride> }
  | { ok: false; code: "PROBE_UNSUPPORTED" | "PROBE_UNAUTHORIZED" | "PROBE_UNREACHABLE" | "PROBE_ERROR"; message: string };

export type ProviderProbe = (input: { provider: string; apiKey: string }) => Promise<ProviderProbeResult>;

export interface ProviderProbeOptions {
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** Resolves the OpenAI-compatible base URL for a provider, if one is known. */
export function providerBaseUrl(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const generic = env.PI_PROVIDER_PROBE_BASE_URL?.trim();
  if (generic) return generic.replace(/\/+$/, "");
  const normalized = provider.toLowerCase();
  if (normalized.startsWith("deepseek")) return (env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URLS.deepseek).replace(/\/+$/, "");
  // `openai-proxy` and similar gateways are expected to expose a compatible
  // /models endpoint via OPENAI_BASE_URL.
  if (normalized.startsWith("openai")) return (env.OPENAI_BASE_URL || env.PI_OPENAI_BASE_URL || DEFAULT_BASE_URLS.openai).replace(/\/+$/, "");
  if (normalized.startsWith("anthropic") || normalized.includes("claude")) return (env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URLS.anthropic).replace(/\/+$/, "");
  if (normalized.startsWith("google") || normalized.includes("gemini")) return (env.GOOGLE_BASE_URL || DEFAULT_BASE_URLS.google).replace(/\/+$/, "");
  return undefined;
}

/** True when probing is disabled by the operator (`PI_MODEL_PROBE_MODE=off`). */
export function providerProbeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PI_MODEL_PROBE_MODE || "probe").toLowerCase() === "off";
}

export function createProviderProbe(options: ProviderProbeOptions = {}): ProviderProbe {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? Number(env.PI_PROVIDER_PROBE_TIMEOUT_MS || 8_000);

  return async ({ provider, apiKey }) => {
    const base = providerBaseUrl(provider, env);
    if (!base) return { ok: false, code: "PROBE_UNSUPPORTED", message: `provider ${provider} 未配置探测端点` };
    try {
      const response = await fetchImpl(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "PROBE_UNAUTHORIZED" : "PROBE_ERROR";
        return { ok: false, code, message: `provider 探测返回 HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> } | undefined;
      const rawModels = Array.isArray(body?.data) ? body!.data : Array.isArray(body?.models) ? body!.models : [];
      const models = rawModels.map((item) => String(item?.id || "").trim()).filter(Boolean);
      return { ok: true, models };
    } catch (error) {
      return { ok: false, code: "PROBE_UNREACHABLE", message: `provider 探测失败：${(error as Error).message}` };
    }
  };
}
