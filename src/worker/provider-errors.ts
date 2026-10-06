import { DEFAULT_LOCALE, type Locale } from "../shared/i18n.js";

export type ProviderErrorKind =
  | "credential"
  | "storage"
  | "rate_limit"
  | "timeout"
  | "unsupported"
  | "provider"
  | "protocol"
  | "unknown";

const patterns: Array<[ProviderErrorKind, RegExp]> = [
  // AT-REL-007: persistence failures must be reported as storage problems, never
  // as a successful run.
  ["storage", /storage_unavailable|no space left on device|enospc|disk (space|full)|econnrefused|connection terminated|terminating connection|callback failed|数据库不可用|存储不可用/i],
  ["credential", /\b(401|403)\b|unauthorized|invalid[_\s-]*api[_\s-]*key|authentication|permission denied|api key.*(invalid|not valid)|invalid_request_error.*\bkey\b/i],
  ["rate_limit", /\b429\b|rate[_\s-]?limit|too many requests|insufficient_quota|no available (accounts|capacity)|model_rate_limited|quota/i],
  ["timeout", /timeout|timed out|etimedout|econnreset|socket hang up|\baborted\b|temporarily unavailable/i],
  ["unsupported", /unknown provider|model.?(not found|does not exist)|unsupported|not supported|invalid model|no such model|model_not_allowed/i],
  ["protocol", /not valid json|invalid json|unexpected token|协议|schema|unparseable/i],
  ["provider", /\b5\d\d\b|server error|bad gateway|service unavailable|overloaded|internal error|upstream/i],
];

/** Maps provider/runtime error text onto the categories required by AT-MODEL-011/012. */
export function classifyProviderError(message: string): ProviderErrorKind {
  for (const [kind, pattern] of patterns) {
    if (pattern.test(message)) return kind;
  }
  return "unknown";
}

export const providerErrorHints: Record<ProviderErrorKind, string> = {
  credential: "凭据问题：请在「模型与凭据」页检查或轮换该 provider 的 Key。",
  storage: "存储错误：数据库或磁盘写入失败，任务未完成；恢复存储后可从「需要人工处理」入口继续。",
  rate_limit: "限流或额度不足：稍后重试，或更换模型/账号额度。",
  timeout: "调用超时：确认网络与代理稳定后重试（任务可人工恢复）。",
  unsupported: "该账号或代理不支持所选模型：改用允许目录内的其他模型。",
  provider: "provider 侧故障：确认代理/网关状态后重试。",
  protocol: "模型输出不符合协议：已自动重试一次，仍失败需人工处理。",
  unknown: "未知错误：查看任务事件与 worker 日志后重试。",
};

/**
 * English rendering of {@link providerErrorHints} (docs/24-i18n.md §9). Additive:
 * the Chinese table above stays the default, so a run without a locale reads
 * exactly as before.
 */
export const providerErrorHintsEn: Record<ProviderErrorKind, string> = {
  credential: "Credential problem: check or rotate this provider's key on the Models & Credentials page.",
  storage: "Storage error: a database or disk write failed and the task did not complete; restore storage and continue from the needs-human entry.",
  rate_limit: "Rate limited or out of quota: retry later, or switch model/account quota.",
  timeout: "Call timed out: confirm the network and proxy are stable, then retry (the run can be resumed manually).",
  unsupported: "This account or proxy does not support the selected model: switch to another model in the allowed catalog.",
  provider: "Provider-side failure: confirm the proxy/gateway status and retry.",
  protocol: "The model output did not match the protocol: it was retried once automatically and still needs human handling.",
  unknown: "Unknown error: inspect the run events and worker logs, then retry.",
};

/** Pi reads provider keys from provider-specific environment variables. */
export function apiKeyEnvName(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized.startsWith("openai")) return "OPENAI_API_KEY";
  if (normalized.startsWith("deepseek")) return "DEEPSEEK_API_KEY";
  if (normalized.startsWith("anthropic") || normalized.includes("claude")) return "ANTHROPIC_API_KEY";
  if (normalized.startsWith("google") || normalized.includes("gemini")) return "GOOGLE_API_KEY";
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Short, UI-friendly rendering used in run summaries: `kind｜hint`. */
export function providerErrorSummary(kind: ProviderErrorKind, message: string, locale: Locale = DEFAULT_LOCALE): string {
  if (locale === "en") {
    return `${message} (category: ${kind}) | hint: ${providerErrorHintsEn[kind]}`;
  }
  return `${message}（分类：${kind}）｜建议：${providerErrorHints[kind]}`;
}
