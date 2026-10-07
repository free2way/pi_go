/**
 * `/api/provider-credits` — 人工录入额度 + 已花费/剩余（docs/27 AT-JEV-062 口径）。
 *
 * 背景：provider 的账户余额查不到（仓库只调 System One 的业务端点），所以"买了多少额度"
 * 由人输入；"花了多少"则从决策审计行的 token × 价目表算出。两个方向都不猜：
 *  - 没录入额度 → `level: "unknown"`（界面显示「未录入」，不是 $0.00）；
 *  - 有未计价调用 → `spentComplete: false`（界面写 ≥，不当作精确值）。
 *
 * 权限：GET 与会话内其它运营读数同级（owner-agnostic 聚合、不含任何 run/评估 id 与密钥）；
 * PUT 是**管理员**操作（与工作区注册、合并、发布同一档）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModelPriceTable } from "../shared/model-prices.js";
import { priceFor } from "../shared/model-prices.js";
import {
  EMPTY_PROVIDER_CREDIT_BOOK,
  ProviderCreditError,
  creditStatus,
  parseProviderCreditBook,
  setProviderCredit,
  summarizeProviderSpend,
  type ProviderCreditBook,
  type ProviderSpend,
  type SpendRow,
} from "../shared/provider-credits.js";
import {
  PROVIDER_CREDITS_PATH,
  type ProviderCreditUpdateResponse,
  type ProviderCreditsResponse,
} from "../shared/provider-credits-api.js";
import type { ConfigFileState } from "./provider-cost-config.js";
export { PROVIDER_CREDITS_PATH };

export interface ProviderCreditsRouteDeps {
  sessionAuthorized?: (request: FastifyRequest) => boolean;
  /** 管理员判定（PUT 用）；缺省视为非管理员（fail-closed）。 */
  isAdmin?: (request: FastifyRequest) => Promise<boolean> | boolean;
  readCredits: () => ConfigFileState<ProviderCreditBook>;
  writeCredits: (book: ProviderCreditBook) => void;
  readPrices: () => ConfigFileState<ModelPriceTable>;
  /** 审计行读取（与决策指标同一 seam）。 */
  listRecent?: (options: { limit: number }) => Promise<readonly SpendRow[]>;
  maxRows?: number;
  now?: () => Date;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

/** 与审计存储自身的读取上限一致：超过它就如实标 truncated（金额只是已读部分的下界）。 */
export const PROVIDER_CREDITS_MAX_ROWS = 20_000;

/**
 * 花费用 `resolvedModel`（线上真实版本）计价，退回 `requestedModel`；两者都不在价目表里
 * 就计入未计价（`complete=false`），绝不当作 0。
 */
export function computeSpend(
  rows: readonly SpendRow[],
  prices: ModelPriceTable,
  at: Date,
): ProviderSpend[] {
  return summarizeProviderSpend(rows, { priceFor: (provider, model) => priceFor(prices, { provider, model, at }) });
}

export function buildProviderCreditsResponse(input: {
  credits: ConfigFileState<ProviderCreditBook>;
  prices: ConfigFileState<ModelPriceTable>;
  rows: readonly SpendRow[];
  truncated: boolean;
  now: Date;
  /** false = 这次读数不可靠（审计读失败/被上限截断）→ 已花费必须标为不完整。 */
  spendReliable?: boolean;
}): ProviderCreditsResponse {
  const reliable = input.spendReliable !== false;
  const raw = computeSpend(input.rows, input.prices.value, input.now);
  // 读数不可靠时，把每一行的 complete 压成 false：宁可说"这个数不完整"，也不能让界面
  // 把一个读失败当成"已花 $0 且完整"。
  const spend = reliable ? raw : raw.map((entry) => ({ ...entry, complete: false }));
  const spendByProvider = new Map(spend.map((entry) => [entry.provider, entry]));
  // 额度和花费任一出现过的 provider 都要有一行：只录额度还没花钱、或花了钱还没录额度
  // 都是运维要看见的状态。
  const providers = [...new Set([...input.credits.value.credits.map((row) => row.provider), ...spend.map((row) => row.provider)])].sort();
  const unreachable: ProviderSpend = {
    provider: "",
    pricedCalls: 0,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
    complete: false,
  };
  const credits = providers
    .map((provider) => {
      const entry = spendByProvider.get(provider);
      const fallback = reliable ? undefined : { ...unreachable, provider };
      return creditStatus(input.credits.value.credits.find((row) => row.provider === provider), entry ?? fallback, input.credits.value);
    })
    .map((status) => ({ ...status, provider: status.provider || "" }));
  return {
    schemaVersion: 1,
    currency: input.credits.value.currency,
    computedAt: input.now.toISOString(),
    credits,
    spend,
    source: {
      creditsFile: input.credits.file,
      creditsIntegrity: input.credits.integrity,
      ...(input.credits.detail ? { creditsDetail: input.credits.detail } : {}),
      pricesFile: input.prices.file,
      pricesIntegrity: input.prices.integrity,
      ...(input.prices.detail ? { pricesDetail: input.prices.detail } : {}),
      rows: input.rows.length,
      truncated: input.truncated,
    },
  };
}

/** 把一次 PUT 的 body 变成严格的额度行；非法输入抛 ProviderCreditError。 */
export function parseCreditInput(raw: unknown): { provider: string; creditedUsd: number; currency?: string; note?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderCreditError("请求体必须是对象：{ provider, creditedUsd, currency?, note? }");
  }
  const body = raw as Record<string, unknown>;
  const book = parseProviderCreditBook({
    credits: [
      {
        provider: body.provider,
        creditedUsd: body.creditedUsd,
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.note === undefined ? {} : { note: body.note }),
      },
    ],
  });
  const [entry] = book.credits;
  return { provider: entry.provider, creditedUsd: entry.creditedUsd, ...(entry.currency ? { currency: entry.currency } : {}), ...(entry.note ? { note: entry.note } : {}) };
}

export function registerProviderCreditsRoutes(app: FastifyInstance, deps: ProviderCreditsRouteDeps): void {
  const warn = deps.warn ?? ((message: string, details) => app.log.warn(details, message));
  const now = () => deps.now?.() ?? new Date();

  const snapshot = async (): Promise<ProviderCreditsResponse> => {
    const credits = deps.readCredits();
    const prices = deps.readPrices();
    const limit = deps.maxRows ?? PROVIDER_CREDITS_MAX_ROWS;
    let rows: readonly SpendRow[] = [];
    let truncated = false;
    let spendReliable = true;
    if (deps.listRecent) {
      try {
        // 多读一行用于判断是否被上限截断（此时金额只是已读部分的合计）。
        const listed = await deps.listRecent({ limit: limit + 1 });
        truncated = listed.length > limit;
        rows = truncated ? listed.slice(0, limit) : listed;
      } catch (error) {
        warn("provider credits: 读取决策审计失败，已花费标记为不完整（而不是 $0）", { error: (error as Error).message });
        rows = [];
        truncated = true;
      }
      spendReliable = !truncated;
    }
    return buildProviderCreditsResponse({ credits, prices, rows, truncated, now: now(), spendReliable });
  };

  app.get(PROVIDER_CREDITS_PATH, async (request, reply) => {
    if (!deps.sessionAuthorized?.(request)) return reply.code(401).send({ error: "Unauthorized" });
    return snapshot();
  });

  app.put(PROVIDER_CREDITS_PATH, async (request, reply) => {
    if (!deps.sessionAuthorized?.(request)) return reply.code(401).send({ error: "Unauthorized" });
    if (!(await deps.isAdmin?.(request))) {
      return reply.code(403).send({ error: "仅管理员可以录入额度" });
    }
    let input: ReturnType<typeof parseCreditInput>;
    try {
      input = parseCreditInput(request.body);
    } catch (error) {
      return reply.code(422).send({ error: (error as Error).message });
    }
    const current = deps.readCredits();
    if (current.integrity === "invalid") {
      // 覆盖一份损坏的文件之前先说清楚：否则录入会"顺手"丢掉原本看不全的内容。
      return reply.code(409).send({ error: `额度文件内容非法（${current.detail ?? "无法解析"}），请先修正 ${current.file} 再录入` });
    }
    const next = setProviderCredit(current.value.credits.length ? current.value : EMPTY_PROVIDER_CREDIT_BOOK, { ...input, now: now() });
    try {
      deps.writeCredits(next);
    } catch (error) {
      warn("provider credits: 写入额度文件失败", { error: (error as Error).message });
      return reply.code(500).send({ error: `写入失败：${(error as Error).message}` });
    }
    const body = await snapshot();
    const status = body.credits.find((row) => row.provider === input.provider);
    const response: ProviderCreditUpdateResponse = {
      ...body,
      updated: status ?? { provider: input.provider, currency: body.currency, spentUsd: 0, spentComplete: false, level: "unknown" },
    };
    return response;
  });
}
