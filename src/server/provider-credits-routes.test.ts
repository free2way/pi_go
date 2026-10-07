import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ModelPriceTable } from "../shared/model-prices.js";
import type { ProviderCreditBook, SpendRow } from "../shared/provider-credits.js";
import type { ConfigFileState } from "./provider-cost-config.js";
import {
  PROVIDER_CREDITS_PATH,
  buildProviderCreditsResponse,
  computeSpend,
  parseCreditInput,
  registerProviderCreditsRoutes,
} from "./provider-credits-routes.js";

/**
 * AT-JEV-062 · 人工额度 + 已花费/剩余 API。
 *
 * 三条不变量：没录入额度 → unknown（不是 0）；有未计价调用 → spentComplete=false（界面写 ≥）；
 * 录入是管理员操作、非法输入不落盘、损坏的现有文件不被静默覆盖。
 */

const prices = (entries: ModelPriceTable["entries"]): ConfigFileState<ModelPriceTable> => ({
  value: { currency: "USD", entries },
  integrity: "ok",
  file: "/data/model-prices.json",
});

const credits = (rows: ProviderCreditBook["credits"]): ConfigFileState<ProviderCreditBook> => ({
  value: { currency: "USD", credits: rows },
  integrity: "ok",
  file: "/data/provider-credits.json",
});

const row = (over: Partial<SpendRow> = {}): SpendRow => ({
  provider: "typesafe",
  requestedModel: "jev-latest",
  resolvedModel: "jev-1.13.0",
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  ...over,
});

function app(deps: Partial<Parameters<typeof registerProviderCreditsRoutes>[1]> = {}) {
  const instance = Fastify();
  registerProviderCreditsRoutes(instance, {
    sessionAuthorized: () => true,
    isAdmin: () => true,
    readCredits: () => credits([{ provider: "typesafe", creditedUsd: 10 }]),
    writeCredits: () => {},
    readPrices: () => prices([{ provider: "typesafe", model: "jev-1.13.0", inputPerMTok: 0.15, outputPerMTok: 0.6 }]),
    listRecent: async () => [row()],
    now: () => new Date("2026-10-07T12:00:00Z"),
    warn: () => {},
    ...deps,
  });
  return instance;
}

describe("computeSpend / buildProviderCreditsResponse", () => {
  it("按 resolved 模型计价，未计价的调用把 complete 置 false", () => {
    const spend = computeSpend([row(), row({ resolvedModel: "unknown-model" })], prices([{ provider: "typesafe", model: "jev-1.13.0", inputPerMTok: 0.15, outputPerMTok: 0.6 }]).value, new Date("2026-10-07T12:00:00Z"));
    expect(spend[0]).toMatchObject({ provider: "typesafe", pricedCalls: 1, unpricedCalls: 1, usd: 0.45, complete: false });
  });

  it("只录额度未花钱、只花钱未录额度，都各出一行", () => {
    const response = buildProviderCreditsResponse({
      credits: credits([{ provider: "deepseek", creditedUsd: 5 }]),
      prices: prices([]),
      rows: [row()],
      truncated: false,
      now: new Date("2026-10-07T12:00:00Z"),
    });
    expect(response.credits.map((entry) => entry.provider)).toEqual(["deepseek", "typesafe"]);
    const deepseek = response.credits.find((entry) => entry.provider === "deepseek");
    expect(deepseek).toMatchObject({ level: "ok", creditedUsd: 5, spentUsd: 0, remainingUsd: 5 });
    const typesafe = response.credits.find((entry) => entry.provider === "typesafe");
    expect(typesafe).toMatchObject({ level: "unknown", spentUsd: 0, spentComplete: false });
    expect(typesafe).not.toHaveProperty("remainingUsd");
  });

  it("剩余与预警：花到 80% 起 warning，超额夹到 0", () => {
    const at80 = buildProviderCreditsResponse({
      credits: credits([{ provider: "typesafe", creditedUsd: 10 }]),
      prices: prices([{ provider: "typesafe", model: "jev-1.13.0", inputPerMTok: 0, outputPerMTok: 16 }]),
      rows: [row({ inputTokens: 0, outputTokens: 500_000 })],
      truncated: false,
      now: new Date("2026-10-07T12:00:00Z"),
    });
    expect(at80.credits[0]).toMatchObject({ level: "warning", spentUsd: 8, remainingUsd: 2 });
    const over = buildProviderCreditsResponse({
      credits: credits([{ provider: "typesafe", creditedUsd: 1 }]),
      prices: prices([{ provider: "typesafe", model: "jev-1.13.0", inputPerMTok: 0, outputPerMTok: 16 }]),
      rows: [row({ inputTokens: 0, outputTokens: 500_000 })],
      truncated: false,
      now: new Date("2026-10-07T12:00:00Z"),
    });
    expect(over.credits[0]).toMatchObject({ level: "exhausted", remainingUsd: 0 });
  });
});

describe("parseCreditInput", () => {
  it("接受合法录入，拒绝非法输入（含 0 与负数语义）", () => {
    expect(parseCreditInput({ provider: "typesafe", creditedUsd: 10, note: "Jev" })).toMatchObject({ provider: "typesafe", creditedUsd: 10, note: "Jev" });
    // 0 合法：表示显式清空为"未录入"
    expect(parseCreditInput({ provider: "typesafe", creditedUsd: 0 }).creditedUsd).toBe(0);
    expect(() => parseCreditInput(null)).toThrow(/必须是对象/);
    expect(() => parseCreditInput({ creditedUsd: 10 })).toThrow(/provider 必须是非空字符串/);
    expect(() => parseCreditInput({ provider: "typesafe", creditedUsd: -1 })).toThrow(/creditedUsd 必须是 >= 0/);
    expect(() => parseCreditInput({ provider: "typesafe", creditedUsd: "10" })).toThrow(/creditedUsd 必须是 >= 0/);
  });
});

describe("GET /api/provider-credits", () => {
  it("未认证 → 401", async () => {
    const instance = app({ sessionAuthorized: () => false });
    const response = await instance.inject({ method: "GET", url: PROVIDER_CREDITS_PATH });
    expect(response.statusCode).toBe(401);
  });

  it("返回额度、花费、来源与完整性（管理员的 Jev 例子：$10 额度，已花 $0.45）", async () => {
    const instance = app();
    const response = await instance.inject({ method: "GET", url: PROVIDER_CREDITS_PATH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ schemaVersion: 1, currency: "USD", computedAt: "2026-10-07T12:00:00.000Z" });
    expect(body.credits[0]).toMatchObject({
      provider: "typesafe",
      creditedUsd: 10,
      spentUsd: 0.45,
      remainingUsd: 9.55,
      level: "ok",
      spentComplete: true,
    });
    expect(body.source).toMatchObject({ creditsIntegrity: "ok", pricesIntegrity: "ok", rows: 1, truncated: false });
  });

  it("审计读取失败或超上限：如实标记不完整，不让 0 冒充", async () => {
    const broken = app({ listRecent: async () => { throw new Error("db down"); } });
    const failed = await broken.inject({ method: "GET", url: PROVIDER_CREDITS_PATH });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().source.truncated).toBe(true);
    expect(failed.json().credits[0]).toMatchObject({ spentUsd: 0, spentComplete: false });

    const capped = app({ maxRows: 1, listRecent: async () => [row(), row()] });
    const truncated = await capped.inject({ method: "GET", url: PROVIDER_CREDITS_PATH });
    expect(truncated.json().source).toMatchObject({ rows: 1, truncated: true });
  });

  it("价目表损坏时：integrity 如实上报，费用全记未计价", async () => {
    const instance = app({
      readPrices: () => ({ value: { currency: "USD", entries: [] }, integrity: "invalid", detail: "entries 缺失", file: "/data/model-prices.json" }),
    });
    const body = (await instance.inject({ method: "GET", url: PROVIDER_CREDITS_PATH })).json();
    expect(body.source).toMatchObject({ pricesIntegrity: "invalid", pricesDetail: "entries 缺失" });
    expect(body.credits[0]).toMatchObject({ spentComplete: false, spentUsd: 0 });
  });
});

describe("PUT /api/provider-credits（人工录入）", () => {
  it("非管理员 → 403；未认证 → 401", async () => {
    const forbidden = app({ isAdmin: () => false });
    const response = await forbidden.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: { provider: "typesafe", creditedUsd: 10 } });
    expect(response.statusCode).toBe(403);
    const unauthorized = app({ sessionAuthorized: () => false });
    expect((await unauthorized.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: {} })).statusCode).toBe(401);
  });

  it("非法输入 → 422 且不写盘", async () => {
    const writeCredits = vi.fn();
    const instance = app({ writeCredits });
    const response = await instance.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: { provider: "", creditedUsd: 10 } });
    expect(response.statusCode).toBe(422);
    expect(writeCredits).not.toHaveBeenCalled();
  });

  it("现有文件损坏 → 409（不静默覆盖），修正后才写入", async () => {
    const writeCredits = vi.fn();
    const instance = app({
      readCredits: () => ({ value: { currency: "USD", credits: [] }, integrity: "invalid", detail: "credits 缺失", file: "/data/provider-credits.json" }),
      writeCredits,
    });
    const response = await instance.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: { provider: "typesafe", creditedUsd: 10 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("/data/provider-credits.json");
    expect(writeCredits).not.toHaveBeenCalled();
  });

  it("成功录入 → 写入并回读状态（Jev $10）", async () => {
    let book: ProviderCreditBook = { currency: "USD", credits: [] };
    const instance = app({
      readCredits: () => ({ value: book, integrity: "ok", file: "/data/provider-credits.json" }),
      writeCredits: (next) => {
        book = next;
      },
    });
    const response = await instance.inject({
      method: "PUT",
      url: PROVIDER_CREDITS_PATH,
      payload: { provider: "typesafe", creditedUsd: 10, note: "Jev 充值" },
    });
    expect(response.statusCode).toBe(200);
    expect(book.credits).toEqual([expect.objectContaining({ provider: "typesafe", creditedUsd: 10, note: "Jev 充值" })]);
    expect(response.json().updated).toMatchObject({ provider: "typesafe", creditedUsd: 10, remainingUsd: 9.55, level: "ok" });

    // 显式清空（0）→ 回到「未录入」
    const cleared = await instance.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: { provider: "typesafe", creditedUsd: 0 } });
    expect(cleared.json().updated).toMatchObject({ level: "unknown" });
    expect(cleared.json().updated).not.toHaveProperty("remainingUsd");
  });

  it("写盘失败 → 500 且带上原因（不谎报成功）", async () => {
    const instance = app({
      writeCredits: () => {
        throw new Error("ENOSPC");
      },
    });
    const response = await instance.inject({ method: "PUT", url: PROVIDER_CREDITS_PATH, payload: { provider: "typesafe", creditedUsd: 10 } });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain("ENOSPC");
  });
});
