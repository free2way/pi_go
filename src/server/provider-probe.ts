/**
 * AUD-08 / AT-MODEL-004: a stored API key is not proof of availability. This
 * probe performs a cheap live `GET {base}/models` against the provider so a
 * credential can be marked verified (`verifiedAt` + `verifiedModels`) instead of
 * being trusted purely because its length looked valid.
 *
 * AT-MODEL-001: when the provider response also carries per-model capabilities
 * (context window, max output tokens, tool-calling / reasoning support), they are
 * captured verbatim and returned so `/api/models` can surface runtime data
 * instead of a static catalog. Nothing is invented: a capability is only emitted
 * when the payload actually contains a recognizable field.
 *
 * The probe is intentionally injectable: `fetchImpl` can be stubbed in tests and
 * the endpoint map can be overridden per deployment, so unit tests never need a
 * real network call.
 */

import type { ProviderModelCapability } from "../shared/types.js";

/** @deprecated kept as an alias for older call sites; use ProviderModelCapability. */
export type ModelCapabilityOverride = ProviderModelCapability;

export type ProviderProbeResult =
  | { ok: true; models: string[]; capabilities?: Record<string, ProviderModelCapability> }
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
  /**
   * TypeSafe System One (Jev) exposes an OpenAI-ish `GET /v1/models` list under
   * the same host as `/v1/systemone`, so the generic probe can verify a stored
   * decision-plane key exactly like any other provider.
   */
  typesafe: "https://api.typesafe.ai/v1",
};

/** TypeSafe/Jev aliases that share the decision-plane base URL. */
const TYPESAFE_PROVIDERS = ["typesafe", "jev"];

/**
 * Resolves the OpenAI-compatible base URL for a provider, if one is known.
 *
 * `PI_PROVIDER_PROBE_BASE_URL` still wins for every provider. TypeSafe/Jev uses
 * `PI_JEV_BASE_URL` (the same variable the adapter reads), which is documented
 * WITHOUT the `/v1` suffix, so `/v1` is appended here for the `/models` probe.
 */
export function providerBaseUrl(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const generic = env.PI_PROVIDER_PROBE_BASE_URL?.trim();
  if (generic) return generic.replace(/\/+$/, "");
  const normalized = provider.toLowerCase();
  if (TYPESAFE_PROVIDERS.some((alias) => normalized === alias || normalized.startsWith(`${alias}-`))) {
    const base = (env.PI_JEV_BASE_URL || DEFAULT_BASE_URLS.typesafe).replace(/\/+$/, "");
    // Tolerate an operator who already included the `/v1` prefix.
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
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

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "supported", "enabled"].includes(normalized)) return true;
    if (["false", "no", "0", "unsupported", "disabled"].includes(normalized)) return false;
  }
  return undefined;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extracts capabilities from a single `/models` item. Only recognizable fields
 * are read, from the item itself and from common nested containers. Returns
 * `undefined` when the provider reported nothing we understand.
 */
export function extractModelCapability(raw: unknown): ProviderModelCapability | undefined {
  const item = objectOrUndefined(raw);
  if (!item) return undefined;
  const containers = [objectOrUndefined(item.capabilities), objectOrUndefined(item.capability), objectOrUndefined(item.features)].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  );
  const sources = [item, ...containers];
  const pick = (...keys: string[]): unknown => {
    for (const source of sources) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
      }
    }
    return undefined;
  };

  const capability: ProviderModelCapability = {};
  const contextWindow = asPositiveInt(
    pick("context_window", "context_length", "contextWindow", "contextLength", "max_context_length", "max_input_tokens"),
  );
  if (contextWindow !== undefined) capability.contextWindow = contextWindow;

  const topProvider = objectOrUndefined(item.top_provider) ?? objectOrUndefined(item.topProvider);
  const maxOutputTokens =
    asPositiveInt(pick("max_output_tokens", "maxOutputTokens", "max_completion_tokens", "maxCompletionTokens")) ??
    asPositiveInt(topProvider?.max_completion_tokens);
  if (maxOutputTokens !== undefined) capability.maxOutputTokens = maxOutputTokens;

  const toolCalling = asBool(
    pick("tool_calling", "toolCalling", "function_calling", "functionCalling", "supports_tools", "supports_function_calling", "tools"),
  );
  const reasoning = asBool(pick("reasoning", "supports_reasoning", "supports_thinking"));

  // OpenRouter-style `supported_parameters` list as a fallback signal.
  const supported = item.supported_parameters ?? item.supportedParameters;
  const supportedParams = Array.isArray(supported) ? supported.map((value) => String(value)) : [];
  const toolFromParams = supportedParams.some((param) => ["tools", "tool_choice", "function_call", "functions"].includes(param));
  const reasoningFromParams = supportedParams.some((param) => ["reasoning", "include_reasoning", "reasoning_effort"].includes(param));

  const resolvedToolCalling = toolCalling ?? (toolFromParams ? true : undefined);
  const resolvedReasoning = reasoning ?? (reasoningFromParams ? true : undefined);
  if (resolvedToolCalling !== undefined) capability.toolCalling = resolvedToolCalling;
  if (resolvedReasoning !== undefined) capability.reasoning = resolvedReasoning;

  return Object.keys(capability).length > 0 ? capability : undefined;
}

function extractCapabilities(rawModels: unknown[]): Record<string, ProviderModelCapability> | undefined {
  const capabilities: Record<string, ProviderModelCapability> = {};
  for (const item of rawModels) {
    try {
      const record = objectOrUndefined(item);
      if (!record) continue;
      const id = String(record.id || "").trim();
      if (!id) continue;
      const capability = extractModelCapability(record);
      if (capability) capabilities[id] = capability;
    } catch {
      // A malformed item must never break the whole probe.
    }
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
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
      const body = (await response.json().catch(() => undefined)) as
        | { data?: unknown; models?: unknown }
        | undefined;
      const rawList = Array.isArray(body?.data) ? body!.data : Array.isArray(body?.models) ? body!.models : [];
      const models = rawList.map((item) => String(objectOrUndefined(item)?.id || "").trim()).filter(Boolean);
      const capabilities = extractCapabilities(rawList);
      return capabilities ? { ok: true, models, capabilities } : { ok: true, models };
    } catch (error) {
      return { ok: false, code: "PROBE_UNREACHABLE", message: `provider 探测失败：${(error as Error).message}` };
    }
  };
}
