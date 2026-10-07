/**
 * Model price table (AT-JEV-062 / COST-00x).
 *
 * Product rule this module exists to enforce: a missing price is **unknown**, not
 * zero. Never derive `$0.00` from absence — the UI shows 「未知」 and the role
 * usage counters report `unpricedCalls`. Everything here is pure and fs-free so
 * the server, the worker and the client can share one implementation; the file
 * loader lives in `src/server/model-prices-file.ts`.
 *
 * Two callers, one table:
 *  - the decision plane: the provider (typesafe/Jev) reports no `usage.cost`, so
 *    its `estimatedCostUsd` is derived locally from tokens × this table;
 *  - role usage: when a provider reports no cost, the same table may supply an
 *    estimate — the caller must keep the "estimated vs reported" distinction.
 */

/** One provider/model rate. Rates are per 1,000,000 tokens, in `currency`. */
export interface ModelPriceEntry {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** ISO date from which this row applies; absent = applies from the beginning. */
  effectiveFrom?: string;
}

export interface ModelPriceTable {
  /** ISO-4217 code; defaults to USD. Reported for display only. */
  currency: string;
  entries: ModelPriceEntry[];
}

/** No prices configured: every lookup is `priced: false` (behaviour unchanged). */
export const EMPTY_MODEL_PRICE_TABLE: ModelPriceTable = { currency: "USD", entries: [] };

export class ModelPriceTableError extends Error {}

export const TOKENS_PER_MTOK = 1_000_000;

function requireNonEmptyString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelPriceTableError(`${context}: ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireRate(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ModelPriceTableError(`${context}: ${field} 必须是 >= 0 的有限数字`);
  }
  return value;
}

/** `YYYY-MM-DD` or any string `Date.parse` accepts; normalized to ISO. */
function requireEffectiveFrom(value: unknown, context: string): string {
  const raw = requireNonEmptyString(value, "effectiveFrom", context);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ModelPriceTableError(`${context}: effectiveFrom="${raw}" 不是可解析的日期`);
  }
  return parsed.toISOString();
}

/**
 * Strict parse. Invalid operator config must fail loudly rather than silently
 * degrade to "no prices" — that is exactly the kind of lax default this file
 * exists to prevent. An *empty* table is legitimate and stays allowed.
 */
export function parseModelPriceTable(raw: unknown): ModelPriceTable {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelPriceTableError("价格表必须是对象：{ currency?, entries: [...] }");
  }
  const record = raw as Record<string, unknown>;
  const currency = record.currency === undefined ? "USD" : requireNonEmptyString(record.currency, "currency", "价格表");
  const entriesRaw = record.entries;
  if (!Array.isArray(entriesRaw)) throw new ModelPriceTableError("价格表缺少 entries 数组");

  const entries: ModelPriceEntry[] = [];
  const seen = new Set<string>();
  entriesRaw.forEach((item, index) => {
    const context = `entries[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ModelPriceTableError(`${context} 必须是对象`);
    }
    const row = item as Record<string, unknown>;
    const provider = requireNonEmptyString(row.provider, "provider", context);
    const model = requireNonEmptyString(row.model, "model", context);
    const inputPerMTok = requireRate(row.inputPerMTok, "inputPerMTok", context);
    const outputPerMTok = requireRate(row.outputPerMTok, "outputPerMTok", context);
    const effectiveFrom = row.effectiveFrom === undefined ? undefined : requireEffectiveFrom(row.effectiveFrom, context);
    // Same provider+model+生效日出现两次就没有确定答案了，直接拒绝。
    const key = `${provider}\u0000${model}\u0000${effectiveFrom ?? ""}`;
    if (seen.has(key)) {
      throw new ModelPriceTableError(`${context}: ${provider}/${model}${effectiveFrom ? ` @${effectiveFrom}` : ""} 重复定义`);
    }
    seen.add(key);
    entries.push({ provider, model, inputPerMTok, outputPerMTok, ...(effectiveFrom ? { effectiveFrom } : {}) });
  });

  return { currency, entries };
}

export interface PriceLookup {
  provider: string;
  model: string;
  /** Instant to price at; defaults to now. Rows with a later `effectiveFrom` never apply. */
  at?: Date | string;
}

/**
 * The applicable row for a model: the newest `effectiveFrom` that is not in the
 * future wins; a row without `effectiveFrom` applies from the beginning and is
 * therefore superseded by any dated row.
 */
export function priceFor(table: ModelPriceTable, lookup: PriceLookup): ModelPriceEntry | undefined {
  const atMs = lookup.at === undefined ? Date.now() : new Date(lookup.at).getTime();
  if (Number.isNaN(atMs)) return undefined;
  const provider = lookup.provider.trim();
  const model = lookup.model.trim();
  if (!provider || !model) return undefined;

  let best: ModelPriceEntry | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const entry of table.entries) {
    if (entry.provider !== provider || entry.model !== model) continue;
    const fromMs = entry.effectiveFrom === undefined ? Number.NEGATIVE_INFINITY : new Date(entry.effectiveFrom).getTime();
    if (Number.isNaN(fromMs) || fromMs > atMs) continue;
    if (fromMs >= bestMs) {
      best = entry;
      bestMs = fromMs;
    }
  }
  return best;
}

export interface CostUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type CostEstimate =
  | { priced: true; usd: number; currency: string; entry: ModelPriceEntry; basis: { inputTokens: number; outputTokens: number } }
  /** `no_price`: this model has no row — the caller must show 未知, never 0. */
  | { priced: false; reason: "no_price" }
  /** `no_usage`: a price exists but nothing was consumed, so the cost really is 0. */
  | { priced: false; reason: "no_usage" };

function tokensOf(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Estimated cost for one call. Returns `no_price` (not 0) when the model is not
 * in the table, and `no_usage` when a price exists but both counters are zero —
 * those are different facts and callers render them differently.
 */
export function estimateCostFor(table: ModelPriceTable, lookup: PriceLookup & CostUsage): CostEstimate {
  const inputTokens = tokensOf(lookup.inputTokens);
  const outputTokens = tokensOf(lookup.outputTokens);
  const entry = priceFor(table, lookup);
  if (!entry) return { priced: false, reason: "no_price" };
  if (inputTokens === 0 && outputTokens === 0) return { priced: false, reason: "no_usage" };
  const usd = (inputTokens / TOKENS_PER_MTOK) * entry.inputPerMTok + (outputTokens / TOKENS_PER_MTOK) * entry.outputPerMTok;
  return {
    priced: true,
    usd: Math.round(usd * 1e6) / 1e6,
    currency: table.currency,
    entry,
    basis: { inputTokens, outputTokens },
  };
}
