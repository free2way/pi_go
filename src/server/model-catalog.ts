import type { ModelCatalogEntry, ModelInfo, ModelRole, ModelSelection } from "../shared/types.js";

/**
 * Built-in allowlist. The entries mirror the providers and models configured for
 * this deployment; `PI_MODEL_CATALOG_JSON` replaces the list, and the role
 * defaults from `PI_DEVELOPER_PROVIDER/MODEL` and `PI_REVIEWER_PROVIDER/MODEL`
 * are always merged in so a custom catalog can never hide the configured defaults.
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
  const entries = parseModelCatalogJson(env.PI_MODEL_CATALOG_JSON) ?? [...builtinModelCatalog];
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

export type ModelValidation =
  | { ok: true; entry: ModelCatalogEntry }
  | { ok: false; code: "MODEL_NOT_FOUND" | "MODEL_NOT_ALLOWED" | "MODEL_UNAVAILABLE"; message: string };

export function validateModelSelection(
  entries: ModelCatalogEntry[],
  role: ModelRole,
  selection: ModelSelection,
  configuredProviders: Set<string>,
): ModelValidation {
  const entry = findModel(entries, selection.provider, selection.model);
  if (!entry) {
    return { ok: false, code: "MODEL_NOT_FOUND", message: `模型 ${selection.provider}/${selection.model} 不在允许目录中` };
  }
  if (!entry.roles.includes(role)) {
    return { ok: false, code: "MODEL_NOT_ALLOWED", message: `模型 ${entry.label} 不允许用于${role === "developer" ? "开发" : "审核"}角色` };
  }
  if (!configuredProviders.has(entry.provider)) {
    return { ok: false, code: "MODEL_UNAVAILABLE", message: `尚未配置 ${entry.provider} 的凭据，无法使用 ${entry.label}` };
  }
  return { ok: true, entry };
}

export function availableModels(entries: ModelCatalogEntry[], configuredProviders: Set<string>): ModelInfo[] {
  return entries.map((entry) => {
    const hasCredential = configuredProviders.has(entry.provider);
    return {
      ...entry,
      available: hasCredential && entry.roles.length > 0,
      unavailableReason: hasCredential ? null : "credential_missing",
    };
  });
}
