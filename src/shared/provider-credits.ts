/**
 * Provider credit book (人工录入的额度) + spend/remaining 计算（AT-JEV-062 口径）。
 *
 * 为什么需要它：provider 的余额我们查不到（仓库只调 System One 的单个业务端点），
 * 所以"买了多少额度"必须**由人输入**。这个模块只做三件事：严格校验人工输入、把
 * 已花费（由审计行的 token × 价目表算出）与额度相减、把"花了多少"是否**完整**标出来。
 *
 * 两条不可退让的语义（与 AT-JEV-062 一致）：
 *  - 没有录入额度 ≠ 额度为 0，而是 `unknown`（界面显示「未录入」，不能显示 $0.00）；
 *  - 有未计价的调用时，已花费是**下界**，`spentComplete=false`，界面必须写"≥"。
 */

export const BUDGET_WARNING_RATIO = 0.8;

/** 一条人工录入的额度。`creditedUsd` 是"这一次充了多少/总共可用多少"。 */
export interface ProviderCredit {
  provider: string;
  creditedUsd: number;
  currency?: string;
  note?: string;
  /** ISO 时间：这条额度是什么时候录入/更新的。 */
  updatedAt?: string;
}

export interface ProviderCreditBook {
  currency: string;
  credits: ProviderCredit[];
}

export const EMPTY_PROVIDER_CREDIT_BOOK: ProviderCreditBook = { currency: "USD", credits: [] };

export class ProviderCreditError extends Error {}

function requireNonEmptyString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderCreditError(`${context}: ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireAmount(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProviderCreditError(`${context}: ${field} 必须是 >= 0 的有限数字`);
  }
  return value;
}

function optionalIso(value: unknown, field: string, context: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = requireNonEmptyString(value, field, context);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new ProviderCreditError(`${context}: ${field}="${raw}" 不是可解析的时间`);
  return parsed.toISOString();
}

/** 严格解析人工输入；非法输入响亮失败，不静默丢弃（否则额度会悄悄变成"未录入"）。 */
export function parseProviderCreditBook(raw: unknown): ProviderCreditBook {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderCreditError("额度文件必须是对象：{ currency?, credits: [...] }");
  }
  const record = raw as Record<string, unknown>;
  const currency = record.currency === undefined ? "USD" : requireNonEmptyString(record.currency, "currency", "额度文件");
  const list = record.credits;
  if (!Array.isArray(list)) throw new ProviderCreditError("额度文件缺少 credits 数组");

  const credits: ProviderCredit[] = [];
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const context = `credits[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ProviderCreditError(`${context} 必须是对象`);
    }
    const row = item as Record<string, unknown>;
    const provider = requireNonEmptyString(row.provider, "provider", context);
    if (seen.has(provider)) throw new ProviderCreditError(`${context}: provider "${provider}" 重复录入（一条 provider 只允许一条额度）`);
    seen.add(provider);
    const creditedUsd = requireAmount(row.creditedUsd, "creditedUsd", context);
    const note = row.note === undefined ? undefined : requireNonEmptyString(row.note, "note", context);
    const updatedAt = optionalIso(row.updatedAt, "updatedAt", context);
    credits.push({
      provider,
      creditedUsd,
      ...(row.currency === undefined ? {} : { currency: requireNonEmptyString(row.currency, "currency", context) }),
      ...(note ? { note } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  });
  return { currency, credits };
}

/** 一次 provider 的已花费（由审计行聚合而来）；`complete=false` 表示存在未计价调用。 */
export interface ProviderSpend {
  provider: string;
  pricedCalls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** 没有未计价调用时才为 true；否则 `usd` 只是下界。 */
  complete: boolean;
}

export type CreditLevel = "ok" | "warning" | "exhausted" | "unknown";

export interface CreditStatus {
  provider: string;
  currency: string;
  /** 未录入时 `undefined`（界面显示「未录入」），绝不用 0 冒充。 */
  creditedUsd?: number;
  spentUsd: number;
  /** 已花超出额度时夹到 0，不会出现负数余额。 */
  remainingUsd?: number;
  ratio?: number;
  level: CreditLevel;
  /** 已花费是否为完整值（存在未计价调用时为 false，界面必须写"≥"）。 */
  spentComplete: boolean;
  note?: string;
  updatedAt?: string;
}

/**
 * 额度状态。优先级：未录入 → `unknown`；已花满/超额 → `exhausted`；
 * 达到 80%（与运行预算同一比例）→ `warning`；否则 `ok`。
 */
export function creditStatus(credit: ProviderCredit | undefined, spend: ProviderSpend | undefined, book?: ProviderCreditBook): CreditStatus {
  const spentUsd = spend?.usd ?? 0;
  const spentComplete = spend?.complete ?? true;
  const currency = credit?.currency ?? book?.currency ?? "USD";
  const base = { provider: credit?.provider ?? spend?.provider ?? "", currency, spentUsd, spentComplete };
  if (!credit) {
    return { ...base, level: "unknown" };
  }
  const creditedUsd = credit.creditedUsd;
  if (!(creditedUsd > 0)) {
    return { ...base, creditedUsd, level: "unknown", ...(credit.note ? { note: credit.note } : {}), ...(credit.updatedAt ? { updatedAt: credit.updatedAt } : {}) };
  }
  const remainingUsd = Math.max(0, creditedUsd - spentUsd);
  const ratio = spentUsd / creditedUsd;
  const level: CreditLevel = remainingUsd <= 0 ? "exhausted" : ratio >= BUDGET_WARNING_RATIO ? "warning" : "ok";
  return {
    ...base,
    creditedUsd,
    remainingUsd,
    ratio: Math.round(ratio * 1e6) / 1e6,
    level,
    ...(credit.note ? { note: credit.note } : {}),
    ...(credit.updatedAt ? { updatedAt: credit.updatedAt } : {}),
  };
}

/** Upsert 一条额度（`creditedUsd=0` 表示显式清空为"未录入"）。 */
export function setProviderCredit(book: ProviderCreditBook, input: { provider: string; creditedUsd: number; currency?: string; note?: string; now?: Date | string }): ProviderCreditBook {
  const provider = requireNonEmptyString(input.provider, "provider", "额度录入");
  const creditedUsd = requireAmount(input.creditedUsd, "creditedUsd", "额度录入");
  const updatedAt = new Date(input.now ?? Date.now()).toISOString();
  const entry: ProviderCredit = {
    provider,
    creditedUsd,
    ...(input.currency ? { currency: requireNonEmptyString(input.currency, "currency", "额度录入") } : {}),
    ...(input.note !== undefined && input.note.trim() ? { note: input.note.trim() } : {}),
    updatedAt,
  };
  const others = book.credits.filter((row) => row.provider !== provider);
  return { ...book, credits: [...others, entry].sort((a, b) => a.provider.localeCompare(b.provider)) };
}

function tokensOf(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** The audit-row projection the spend aggregation needs (a full record is assignable). */
export interface SpendRow {
  provider: string;
  requestedModel: string;
  resolvedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SpendPriceLookup {
  /** 价目表；缺省表示没有可用价格（全部调用都会计入 `unpricedCalls`）。 */
  priceFor?: (provider: string, model: string) => { inputPerMTok: number; outputPerMTok: number } | undefined;
  currency?: string;
  /** 计价基准时间（价目表的 effectiveFrom 过滤）。 */
  at?: Date | string;
  /** 计价使用哪些模型名：优先 resolved（线上真实版本），退回 requested。 */
}

/**
 * 按 provider 聚合已花费：逐行用价目表算钱，**算不出来的行计入 `unpricedCalls`**
 * 并把 `complete` 置为 false —— 界面据此显示"≥ $X"，绝不把缺价当成免费。
 */
export function summarizeProviderSpend(rows: readonly SpendRow[], lookup: SpendPriceLookup = {}): ProviderSpend[] {
  const byProvider = new Map<string, ProviderSpend>();
  for (const row of rows) {
    const provider = String(row.provider ?? "").trim();
    if (!provider) continue;
    const current = byProvider.get(provider) ?? {
      provider,
      pricedCalls: 0,
      unpricedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      complete: true,
    };
    const inputTokens = tokensOf(row.inputTokens);
    const outputTokens = tokensOf(row.outputTokens);
    current.inputTokens += inputTokens;
    current.outputTokens += outputTokens;
    const model = String(row.resolvedModel || row.requestedModel || "").trim();
    const price = lookup.priceFor?.(provider, model);
    if (!price) {
      current.unpricedCalls += 1;
      current.complete = false;
    } else {
      current.pricedCalls += 1;
      current.usd += (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
    }
    byProvider.set(provider, current);
  }
  return [...byProvider.values()]
    .map((entry) => ({ ...entry, usd: Math.round(entry.usd * 1e6) / 1e6 }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}
