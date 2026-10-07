/**
 * Provider 额度卡片 — 客户端视图助手（AT-JEV-062）。
 *
 * 与 `decision-metrics-view.ts` 同一套路：卡片只是薄壳，把
 * `GET /api/provider-credits` 的响应映射成 label/tone/row 的全是这里的纯函数，
 * 因此不需要 DOM 测试环境。
 *
 * 两条口径在这里落地：
 *  - 未录入额度 → 显示「未录入」，**绝不**显示 $0.00；
 *  - 有未计价调用（`spentComplete=false`）→ 金额前缀 `≥`，并给出"为什么"。
 */
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";
import type { CreditStatus } from "../shared/provider-credits";
import type { ProviderCreditsResponse } from "../shared/provider-credits-api";

export type CreditTone = "ok" | "warn" | "error" | "muted";

const LEVEL_KEYS: Record<CreditStatus["level"], MessageKey> = {
  ok: "credits.level.ok",
  warning: "credits.level.warning",
  exhausted: "credits.level.exhausted",
  unknown: "credits.level.unknown",
};

const LEVEL_TONES: Record<CreditStatus["level"], CreditTone> = {
  ok: "ok",
  warning: "warn",
  exhausted: "error",
  unknown: "muted",
};

export function creditLevelLabel(level: CreditStatus["level"], locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, LEVEL_KEYS[level] ?? "credits.level.unknown");
}

export function creditLevelTone(level: CreditStatus["level"]): CreditTone {
  return LEVEL_TONES[level] ?? "muted";
}

/**
 * 金额：常规两位小数；**小于 0.01 时给足有效位**（Jev 单次评估约 $0.00004，两位小数会把它
 * 显示成 $0.00 —— 那等于谎报成"没花钱"）。零仍然显示 $0.00（零是事实）。
 */
export function formatCreditAmount(value: number | undefined, currency: string, locale: Locale = DEFAULT_LOCALE): string {
  if (value === undefined || !Number.isFinite(value)) return t(locale, "credits.unknownAmount");
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : `${currency} `;
  if (value === 0) return `${symbol}0.00`;
  if (value < 0.01) {
    // 六位小数，去掉尾随零：0.000755 → "$0.000755"
    const precise = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return `${symbol}${precise}`;
  }
  return `${symbol}${value.toFixed(2)}`;
}

/** 已花：不完整时前缀 `≥`（服务端已保证 usd 是下界）。 */
export function creditSpentLabel(status: CreditStatus, locale: Locale = DEFAULT_LOCALE): string {
  const amount = formatCreditAmount(status.spentUsd, status.currency, locale);
  return status.spentComplete ? amount : `≥ ${amount}`;
}

/** 剩余：未录入额度时是「未录入」，而不是 0。 */
export function creditRemainingLabel(status: CreditStatus, locale: Locale = DEFAULT_LOCALE): string {
  if (status.level === "unknown" || status.remainingUsd === undefined) return t(locale, "credits.unknownAmount");
  return formatCreditAmount(status.remainingUsd, status.currency, locale);
}

export interface ProviderCreditRow {
  key: string;
  label: string;
  value: string;
  tone: CreditTone;
}

/** 每个 provider 一段：额度 / 已花 / 剩余 / 状态。 */
export function providerCreditRows(response: ProviderCreditsResponse, locale: Locale = DEFAULT_LOCALE): ProviderCreditRow[] {
  const rows: ProviderCreditRow[] = [];
  for (const status of response.credits) {
    const prefix = status.provider || "";
    rows.push({
      key: `${prefix}:credited`,
      label: `${prefix} · ${t(locale, "credits.credited")}`,
      value: status.creditedUsd === undefined ? t(locale, "credits.unknownAmount") : formatCreditAmount(status.creditedUsd, status.currency, locale),
      tone: status.creditedUsd === undefined ? "muted" : "muted",
    });
    rows.push({
      key: `${prefix}:spent`,
      label: `${prefix} · ${t(locale, "credits.spent")}`,
      value: creditSpentLabel(status, locale),
      tone: status.spentComplete ? "muted" : "warn",
    });
    rows.push({
      key: `${prefix}:remaining`,
      label: `${prefix} · ${t(locale, "credits.remaining")}`,
      value: creditRemainingLabel(status, locale),
      tone: creditLevelTone(status.level),
    });
    rows.push({
      key: `${prefix}:level`,
      label: `${prefix} · ${t(locale, "credits.status")}`,
      value: creditLevelLabel(status.level, locale),
      tone: creditLevelTone(status.level),
    });
  }
  return rows;
}

/** 必须先说明的例外情况（价目表/额度文件损坏、读取截断、未计价调用）。 */
export function providerCreditNotices(response: ProviderCreditsResponse, locale: Locale = DEFAULT_LOCALE): string[] {
  const notices: string[] = [];
  if (response.source.creditsIntegrity === "invalid") notices.push(t(locale, "credits.creditsBroken"));
  if (response.source.pricesIntegrity === "invalid") notices.push(t(locale, "credits.pricesBroken"));
  // 只有在"确实有审计行要计价"时，缺价目表才是问题；空历史下说这句会让人以为花费不可信。
  else if (response.source.pricesIntegrity === "missing" && response.source.rows > 0) notices.push(t(locale, "credits.noPrices"));
  if (response.source.truncated) notices.push(t(locale, "credits.truncated"));
  if (response.credits.some((status) => !status.spentComplete) && !notices.includes(t(locale, "credits.noPrices")) && response.source.rows > 0) {
    notices.push(t(locale, "credits.incompleteHint"));
  }
  if (response.credits.length === 0) notices.push(t(locale, "credits.none"));
  return notices;
}

/** 录入表单的本地校验（服务端仍会再校验一次）。 */
export function parseCreditInput(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100) / 100;
}
