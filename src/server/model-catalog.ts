import type {
  CredentialVerificationState,
  ModelCatalogEntry,
  ModelInfo,
  ModelRole,
  ModelSelection,
  ProviderAvailability,
  ProviderModelCapability,
} from "../shared/types.js";

/**
 * Built-in allowlist. The entries mirror the providers and models configured for
 * this deployment. When no explicit `PI_MODEL_CATALOG_JSON` is set the role
 * defaults from `PI_DEVELOPER_PROVIDER/MODEL` and `PI_REVIEWER_PROVIDER/MODEL`
 * are merged in so the builtin catalog cannot hide the configured defaults.
 *
 * AUD-08 / AT-MODEL-002: an explicit operator allowlist is STRICT. It is used
 * verbatim — no defaults are appended and role mappings are not extended. If a
 * role ends up without a usable model, preflight reports a configuration error
 * instead of silently widening the catalog.
 */
export const builtinModelCatalog: ModelCatalogEntry[] = [
  { id: "deepseek/deepseek-flash", provider: "deepseek", model: "deepseek-flash", label: "DeepSeek Flash", toolCalling: true, reasoning: false, roles: ["developer"], status: "available" },
  { id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", toolCalling: true, reasoning: false, roles: ["developer", "reviewer"], status: "available" },
  { id: "openai-proxy/gpt-5.6-sol", provider: "openai-proxy", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", toolCalling: true, reasoning: true, roles: ["reviewer"], status: "available" },
  { id: "openai-proxy/gpt-5.6-luna", provider: "openai-proxy", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", toolCalling: true, reasoning: true, roles: ["developer", "reviewer"], status: "available" },
];

function normalizeEntry(raw: unknown, index: number): ModelCatalogEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const provider = String(item.provider || "").trim();
  const model = String(item.model || "").trim();
  if (!provider || !model) return undefined;
  const roles = Array.isArray(item.roles)
    ? item.roles.map((role) => String(role)).filter((role): role is ModelRole => role === "developer" || role === "reviewer")
    : [];
  return {
    id: String(item.id || `${provider}/${model}`).slice(0, 120),
    provider: provider.slice(0, 80),
    model: model.slice(0, 120),
    label: String(item.label || model).slice(0, 120),
    contextWindow: typeof item.contextWindow === "number" ? item.contextWindow : undefined,
    maxOutputTokens: typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : undefined,
    toolCalling: item.toolCalling !== false,
    reasoning: item.reasoning === true,
    roles: roles.length ? roles : ["developer", "reviewer"],
    status: item.status === "preview" || item.status === "deprecated" ? item.status : "available",
  };
}

export function parseModelCatalogJson(raw: string | undefined): ModelCatalogEntry[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const entries = parsed.map(normalizeEntry).filter((entry): entry is ModelCatalogEntry => Boolean(entry));
    return entries.length ? entries : undefined;
  } catch {
    return undefined;
  }
}

/** True when the operator supplied an explicit JSON allowlist (even an empty one). */
export function hasExplicitModelCatalog(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_MODEL_CATALOG_JSON?.trim();
  return Boolean(raw && raw.startsWith("["));
}

function roleDefault(env: NodeJS.ProcessEnv, role: ModelRole, fallback: ModelSelection): ModelSelection {
  if (role === "developer") {
    return {
      provider: env.PI_DEVELOPER_PROVIDER || fallback.provider,
      model: env.PI_DEVELOPER_MODEL || fallback.model,
    };
  }
  return {
    provider: env.PI_REVIEWER_PROVIDER || fallback.provider,
    model: env.PI_REVIEWER_MODEL || fallback.model,
  };
}

export function loadModelCatalog(env: NodeJS.ProcessEnv = process.env): ModelCatalogEntry[] {
  // AUD-08 / AT-MODEL-002: an explicit allowlist is authoritative. It is never
  // widened with defaults and its role mappings are never extended.
  if (hasExplicitModelCatalog(env)) {
    return parseModelCatalogJson(env.PI_MODEL_CATALOG_JSON) ?? [];
  }
  const entries = [...builtinModelCatalog];
  const defaults = {
    developer: roleDefault(env, "developer", { provider: "deepseek", model: "deepseek-flash" }),
    reviewer: roleDefault(env, "reviewer", { provider: "openai-proxy", model: "gpt-5.6-sol" }),
  };
  const ensure = (selection: ModelSelection, roles: ModelRole[]) => {
    const existing = entries.find((entry) => entry.provider === selection.provider && entry.model === selection.model);
    if (existing) {
      for (const role of roles) if (!existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    entries.unshift({
      id: `${selection.provider}/${selection.model}`,
      provider: selection.provider,
      model: selection.model,
      label: selection.model,
      toolCalling: true,
      reasoning: false,
      roles,
      status: "available",
    });
  };
  ensure(defaults.developer, ["developer"]);
  ensure(defaults.reviewer, ["reviewer"]);
  return entries;
}

export function defaultSelections(env: NodeJS.ProcessEnv = process.env): { developer: ModelSelection; reviewer: ModelSelection } {
  return {
    developer: roleDefault(env, "developer", { provider: "deepseek", model: "deepseek-flash" }),
    reviewer: roleDefault(env, "reviewer", { provider: "openai-proxy", model: "gpt-5.6-sol" }),
  };
}

export function findModel(entries: ModelCatalogEntry[], provider: string, model: string) {
  return entries.find((entry) => entry.provider === provider && entry.model === model);
}

export type ProviderAvailabilityIndex = Map<string, ProviderAvailability>;
export type ProviderAvailabilityInput = Set<string> | ProviderAvailability[] | ProviderAvailabilityIndex;

function normalizeAvailability(input: ProviderAvailabilityInput): ProviderAvailabilityIndex {
  if (input instanceof Map) return input;
  const index: ProviderAvailabilityIndex = new Map();
  if (input instanceof Set) {
    // A bare Set is the legacy "these providers are usable" shorthand.
    for (const provider of input) {
      index.set(provider, { provider, configured: true, verifiedAt: null, verifiedModels: null, verified: true, verification: "live" });
    }
    return index;
  }
  for (const item of input) index.set(item.provider, item);
  return index;
}

export type ProviderModelState = "missing" | "unverified" | "model_unverified" | "ready" | "asserted";

/** Resolves the verification state, tolerating records written before it existed. */
export function availabilityVerification(record: ProviderAvailability): CredentialVerificationState {
  if (record.verification) return record.verification;
  if (record.asserted === true) return "operator_asserted";
  if (record.verified === true || record.verifiedAt !== null) return "live";
  return "unchecked";
}

/**
 * AUD-08 / AT-MODEL-004: a stored key is not "available" until a live probe
 * verified it, or the operator explicitly asserted it with probing disabled.
 * A live verification always wins over a stale assertion.
 */
export function providerModelState(
  availability: ProviderAvailabilityInput,
  provider: string,
  model: string,
): ProviderModelState {
  const index = normalizeAvailability(availability);
  const record = index.get(provider);
  if (!record || !record.configured) return "missing";
  const verification = availabilityVerification(record);
  if (verification === "live") {
    if (Array.isArray(record.verifiedModels) && record.verifiedModels.length > 0 && !record.verifiedModels.includes(model)) {
      return "model_unverified";
    }
    return "ready";
  }
  if (verification === "operator_asserted") return "asserted";
  return "unverified";
}

export type ModelValidation =
  | { ok: true; entry: ModelCatalogEntry }
  | { ok: false; code: "MODEL_NOT_FOUND" | "MODEL_NOT_ALLOWED" | "MODEL_UNAVAILABLE" | "MODEL_NOT_AVAILABLE" | "MODEL_CONFIG_INVALID"; message: string };

export function validateModelSelection(
  entries: ModelCatalogEntry[],
  role: ModelRole,
  selection: ModelSelection,
  availability: ProviderAvailabilityInput,
): ModelValidation {
  if (!entries.some((entry) => entry.roles.includes(role))) {
    // AUD-08 / AT-MODEL-002: an explicit allowlist can leave a role uncovered;
    // report the configuration error instead of falling back to a default.
    return { ok: false, code: "MODEL_CONFIG_INVALID", message: `允许目录未包含可用于${role === "developer" ? "开发" : "审核"}角色的模型，请修正模型目录配置` };
  }
  const entry = findModel(entries, selection.provider, selection.model);
  if (!entry) {
    return { ok: false, code: "MODEL_NOT_FOUND", message: `模型 ${selection.provider}/${selection.model} 不在允许目录中` };
  }
  if (!entry.roles.includes(role)) {
    return { ok: false, code: "MODEL_NOT_ALLOWED", message: `模型 ${entry.label} 不允许用于${role === "developer" ? "开发" : "审核"}角色` };
  }
  const state = providerModelState(availability, entry.provider, entry.model);
  if (state === "missing") {
    return { ok: false, code: "MODEL_UNAVAILABLE", message: `尚未配置 ${entry.provider} 的凭据，无法使用 ${entry.label}` };
  }
  if (state === "unverified") {
    return { ok: false, code: "MODEL_NOT_AVAILABLE", message: `${entry.provider} 的凭据尚未通过可用性校验，请在「模型与凭据」页重新保存或校验 Key` };
  }
  if (state === "model_unverified") {
    return { ok: false, code: "MODEL_NOT_AVAILABLE", message: `${entry.label} 未在该 provider 实际可用的模型列表中，无法使用` };
  }
  return { ok: true, entry };
}

/** Optional runtime capability overrides captured from a provider probe. */
export type RuntimeCapability = ProviderModelCapability;

function verificationText(state: CredentialVerificationState): string {
  if (state === "live") return "已验证";
  if (state === "operator_asserted") return "未校验（操作者断言）";
  return "未校验";
}

export function availableModels(
  entries: ModelCatalogEntry[],
  availability: ProviderAvailabilityInput,
  runtime?: Record<string, RuntimeCapability>,
): ModelInfo[] {
  const index = normalizeAvailability(availability);
  return entries.map((entry) => {
    const record = index.get(entry.provider);
    const capability = record?.capabilities?.[entry.model] ?? runtime?.[`${entry.provider}/${entry.model}`];
    const capabilitiesVerified = Boolean(record?.capabilities?.[entry.model]);
    const merged = capability ? { ...entry, ...capability } : entry;
    const verification = record ? availabilityVerification(record) : "unchecked";
    const base = {
      ...merged,
      verifiedAt: record?.verifiedAt ?? null,
      verification,
      asserted: verification === "operator_asserted",
      verificationLabel: verificationText(verification),
      capabilitiesVerified,
      capabilities: capability ?? null,
    };
    if (!entry.roles.length) {
      return { ...base, available: false, unavailableReason: "role_restricted" as const, verified: false };
    }
    const state = providerModelState(index, entry.provider, entry.model);
    if (state === "ready" || state === "asserted") {
      return { ...base, available: true, unavailableReason: null, verified: state === "ready" };
    }
    const unavailableReason =
      state === "missing" ? "credential_missing" : state === "unverified" ? "credential_unverified" : "model_unverified";
    return { ...base, available: false, unavailableReason, verified: false };
  });
}

export type RunPreflightFailure = {
  ok: false;
  role: ModelRole;
  code: "MODEL_NOT_FOUND" | "MODEL_NOT_ALLOWED" | "MODEL_UNAVAILABLE" | "MODEL_NOT_AVAILABLE" | "MODEL_CONFIG_INVALID";
  message: string;
};

export type RunPreflightResult =
  | { ok: true; roles: { developer: ModelCatalogEntry; reviewer: ModelCatalogEntry } }
  | RunPreflightFailure;

/**
 * AUD-08 / AT-MODEL-008: before a run is enqueued, verify that every role the run
 * will use is usable. The planner and developer both execute on the developer
 * selection (see worker/index.ts), and the reviewer on the reviewer selection.
 * A failure here rejects the run early with a clear code instead of failing mid-run.
 */
export function preflightRunModels(
  entries: ModelCatalogEntry[],
  selections: { developer: ModelSelection; reviewer: ModelSelection },
  availability: ProviderAvailabilityInput,
): RunPreflightResult {
  const resolved: Partial<Record<ModelRole, ModelCatalogEntry>> = {};
  for (const role of ["developer", "reviewer"] as ModelRole[]) {
    const check = validateModelSelection(entries, role, selections[role], availability);
    if (!check.ok) return { ok: false, role, code: check.code, message: check.message };
    resolved[role] = check.entry;
  }
  return { ok: true, roles: { developer: resolved.developer!, reviewer: resolved.reviewer! } };
}
