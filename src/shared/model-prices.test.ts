import { describe, expect, it } from "vitest";
import {
  EMPTY_MODEL_PRICE_TABLE,
  ModelPriceTableError,
  estimateCostFor,
  parseModelPriceTable,
  priceFor,
} from "./model-prices.js";

/**
 * AT-JEV-062 / COST-00x · 价目表的语义边界。
 *
 * 这一组用例存在的理由只有一条：**价格缺失是"未知"，不是 0**。任何让未知退化成
 * `$0.00` 的实现都必须在这里失败，否则界面与审计会给出错误结论。
 */

const table = parseModelPriceTable({
  entries: [
    { provider: "typesafe", model: "jev-latest", inputPerMTok: 0.15, outputPerMTok: 0.6 },
    { provider: "deepseek", model: "deepseek-flash", inputPerMTok: 0.02, outputPerMTok: 0.08 },
  ],
});

describe("parseModelPriceTable", () => {
  it("接受合法表并默认 USD；空表是合法的", () => {
    expect(table.currency).toBe("USD");
    expect(table.entries).toHaveLength(2);
    expect(parseModelPriceTable({ currency: "CNY", entries: [] })).toEqual({ currency: "CNY", entries: [] });
    expect(EMPTY_MODEL_PRICE_TABLE.entries).toEqual([]);
  });

  it("非法配置一律响亮失败（不降级成空表）", () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /必须是对象/],
      [[], /必须是对象/],
      [{}, /缺少 entries/],
      [{ entries: [{ provider: "", model: "m", inputPerMTok: 1, outputPerMTok: 1 }] }, /provider 必须是非空字符串/],
      [{ entries: [{ provider: "p", model: " ", inputPerMTok: 1, outputPerMTok: 1 }] }, /model 必须是非空字符串/],
      [{ entries: [{ provider: "p", model: "m", inputPerMTok: -1, outputPerMTok: 1 }] }, /inputPerMTok 必须是 >= 0/],
      [{ entries: [{ provider: "p", model: "m", inputPerMTok: 1, outputPerMTok: Number.NaN }] }, /outputPerMTok 必须是 >= 0/],
      [{ entries: [{ provider: "p", model: "m", inputPerMTok: 1, outputPerMTok: 1, effectiveFrom: "not-a-date" }] }, /不是可解析的日期/],
      [
        {
          entries: [
            { provider: "p", model: "m", inputPerMTok: 1, outputPerMTok: 1, effectiveFrom: "2026-01-01" },
            { provider: "p", model: "m", inputPerMTok: 2, outputPerMTok: 2, effectiveFrom: "2026-01-01" },
          ],
        },
        /重复定义/,
      ],
    ];
    for (const [input, pattern] of bad) {
      expect(() => parseModelPriceTable(input)).toThrow(ModelPriceTableError);
      expect(() => parseModelPriceTable(input)).toThrow(pattern);
    }
  });

  it("effectiveFrom 归一化为 ISO", () => {
    const parsed = parseModelPriceTable({
      entries: [{ provider: "p", model: "m", inputPerMTok: 1, outputPerMTok: 1, effectiveFrom: "2026-03-05" }],
    });
    expect(parsed.entries[0].effectiveFrom).toBe(new Date("2026-03-05").toISOString());
  });
});

describe("priceFor", () => {
  const dated = parseModelPriceTable({
    entries: [
      { provider: "p", model: "m", inputPerMTok: 1, outputPerMTok: 1 },
      { provider: "p", model: "m", inputPerMTok: 2, outputPerMTok: 2, effectiveFrom: "2026-02-01" },
      { provider: "p", model: "m", inputPerMTok: 3, outputPerMTok: 3, effectiveFrom: "2026-06-01" },
    ],
  });

  it("按生效日取最新的一条；未生效的未来价不参与", () => {
    expect(priceFor(dated, { provider: "p", model: "m", at: "2026-01-15" })?.inputPerMTok).toBe(1);
    expect(priceFor(dated, { provider: "p", model: "m", at: "2026-03-15" })?.inputPerMTok).toBe(2);
    expect(priceFor(dated, { provider: "p", model: "m", at: "2026-07-01" })?.inputPerMTok).toBe(3);
    // 生效日当天即生效
    expect(priceFor(dated, { provider: "p", model: "m", at: "2026-06-01" })?.inputPerMTok).toBe(3);
  });

  it("查不到就是 undefined：模型未知、provider 不匹配、空键、非法时间", () => {
    expect(priceFor(table, { provider: "typesafe", model: "unknown" })).toBeUndefined();
    expect(priceFor(table, { provider: "other", model: "jev-latest" })).toBeUndefined();
    expect(priceFor(table, { provider: " ", model: "jev-latest" })).toBeUndefined();
    expect(priceFor(table, { provider: "typesafe", model: " " })).toBeUndefined();
    expect(priceFor(table, { provider: "typesafe", model: "jev-latest", at: "bogus" })).toBeUndefined();
    expect(priceFor(EMPTY_MODEL_PRICE_TABLE, { provider: "typesafe", model: "jev-latest" })).toBeUndefined();
  });
});

describe("estimateCostFor", () => {
  it("按 token × 每百万单价计算，6 位小数（真实价目表口径）", () => {
    const result = estimateCostFor(table, { provider: "typesafe", model: "jev-latest", inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(result.priced).toBe(true);
    if (!result.priced) return;
    expect(result.usd).toBe(0.45);
    expect(result.currency).toBe("USD");
    expect(result.basis).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000 });

    const small = estimateCostFor(table, { provider: "typesafe", model: "jev-latest", inputTokens: 150, outputTokens: 0 });
    expect(small.priced).toBe(true);
    // 150 token × $0.15/MTok = 0.0000225；二进制浮点下 22.5 略小于 22.5，四舍五入到 6 位是 0.000022。
    // 这种"零头"由界面口径处理（< $0.000001 显示为小于最小单位），模块本身只保证确定性与可复现。
    if (small.priced) expect(small.usd).toBe(0.000022);
  });

  it("未收录的模型返回 no_price —— 调用方必须显示「未知」，不能退化成 0", () => {
    const result = estimateCostFor(table, { provider: "typesafe", model: "jev-next", inputTokens: 10_000, outputTokens: 10_000 });
    expect(result).toEqual({ priced: false, reason: "no_price" });
    // 这一条就是本模块存在的理由：绝不能是 { usd: 0 }。
    expect(result).not.toHaveProperty("usd");
  });

  it("有价但零消耗 → no_usage（此时 0 才是事实，但与未知是两件事）", () => {
    expect(estimateCostFor(table, { provider: "deepseek", model: "deepseek-flash" })).toEqual({ priced: false, reason: "no_usage" });
    expect(estimateCostFor(table, { provider: "deepseek", model: "deepseek-flash", inputTokens: 0, outputTokens: 0 })).toEqual({
      priced: false,
      reason: "no_usage",
    });
  });

  it("负数/非有限 token 视为 0；只用一处价格时的零头四舍五入", () => {
    const negative = estimateCostFor(table, { provider: "deepseek", model: "deepseek-flash", inputTokens: -5, outputTokens: Number.NaN });
    expect(negative).toEqual({ priced: false, reason: "no_usage" });
    const onlyInput = estimateCostFor(table, { provider: "deepseek", model: "deepseek-flash", inputTokens: 1_000_000 });
    expect(onlyInput.priced).toBe(true);
    if (onlyInput.priced) expect(onlyInput.usd).toBe(0.02);
  });
});
