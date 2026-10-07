/**
 * `/api/provider-credits` 的共享契约（服务端与客户端同源，避免两边漂移）。
 *
 * 只有额度/花费的读与录入走这里；金额口径本身在 `provider-credits.ts`，
 * 未收录即「未知」的规则也在那边，两边必须一起看。
 */
import type { CreditStatus, ProviderSpend } from "./provider-credits.js";

export const PROVIDER_CREDITS_PATH = "/api/provider-credits";

/** 运维配置文件的完整性（缺失/损坏都如实上报，不让人误以为"没有花费"）。 */
export type ConfigIntegrity = "ok" | "missing" | "invalid";

export interface ProviderCreditsSource {
  creditsFile: string;
  creditsIntegrity: ConfigIntegrity;
  creditsDetail?: string;
  pricesFile: string;
  pricesIntegrity: ConfigIntegrity;
  pricesDetail?: string;
  /** 计价时读到的审计行数，以及是否被读取上限截断（截断时金额只是下界）。 */
  rows: number;
  truncated: boolean;
}

export interface ProviderCreditsResponse {
  schemaVersion: 1;
  currency: string;
  computedAt: string;
  credits: CreditStatus[];
  spend: ProviderSpend[];
  source: ProviderCreditsSource;
}

export interface ProviderCreditUpdate {
  provider: string;
  creditedUsd: number;
  currency?: string;
  note?: string;
}

/** PUT 的响应：快照 + 刚更新的那一行（便于界面就地刷新）。 */
export type ProviderCreditUpdateResponse = ProviderCreditsResponse & { updated: CreditStatus };
