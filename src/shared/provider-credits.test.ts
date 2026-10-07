import { describe, expect, it } from "vitest";
import {
  BUDGET_WARNING_RATIO,
  EMPTY_PROVIDER_CREDIT_BOOK,
  ProviderCreditError,
  creditStatus,
  parseProviderCreditBook,
  setProviderCredit,
  summarizeProviderSpend,
  type ProviderSpend,
} from "./provider-credits.js";

/**
 * 人工录入额度 + 已花费/剩余的口径。
 *
 * 这一组用例守住两条产品不变量：
 *  - 未录入额度是「未录入」（level=unknown），不是 $0.00；
 *  - 有未计价调用时"已花"只是下界（complete=false），界面必须写"≥"，不得当作精确值。
 */

const book = parseProviderCreditBook({
  credits: [
    { provider: "typesafe", creditedUsd: 10, note: "Jev 充值", updatedAt: "2026-10-07" },
    { provider: "deepseek", creditedUsd: 5 },
  ],
});

describe("parseProviderCreditBook / setProviderCredit", () => {
  it("严格解析：非法输入响亮失败，不静默丢成「未录入」", () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /必须是对象/],
      [{}, /缺少 credits/],
      [{ credits: [{ provider: "", creditedUsd: 1 }] }, /provider 必须是非空字符串/],
      [{ credits: [{ provider: "p", creditedUsd: -1 }] }, /creditedUsd 必须是 >= 0/],
      [{ credits: [{ provider: "p", creditedUsd: Number.POSITIVE_INFINITY }] }, /creditedUsd 必须是 >= 0/],
      [{ credits: [{ provider: "p", creditedUsd: 1, updatedAt: "nope" }] }, /不是可解析的时间/],
      [{ credits: [{ provider: "p", creditedUsd: 1 }, { provider: "p", creditedUsd: 2 }] }, /重复录入/],
    ];
    for (const [input, pattern] of bad) {
      expect(() => parseProviderCreditBook(input)).toThrow(ProviderCreditError);
      expect(() => parseProviderCreditBook(input)).toThrow(pattern);
    }
  });

  it("upsert：同一 provider 覆盖（保留更新时间），其它 provider 不受影响，列表按 provider 排序", () => {
    const updated = setProviderCredit(book, { provider: "typesafe", creditedUsd: 25, note: "追加", now: "2026-10-08T00:00:00Z" });
    expect(updated.credits).toHaveLength(2);
    const typesafe = updated.credits.find((row) => row.provider === "typesafe");
    expect(typesafe).toMatchObject({ creditedUsd: 25, note: "追加", updatedAt: "2026-10-08T00:00:00.000Z" });
    expect(updated.credits.find((row) => row.provider === "deepseek")?.creditedUsd).toBe(5);
    expect(updated.credits.map((row) => row.provider)).toEqual(["deepseek", "typesafe"]);
    // 显式清空为"未录入"
    const cleared = setProviderCredit(updated, { provider: "typesafe", creditedUsd: 0 });
    expect(creditStatus(cleared.credits.find((row) => row.provider === "typesafe"), undefined, cleared).level).toBe("unknown");
  });
});

describe("creditStatus", () => {
  const spend = (usd: number, complete = true): ProviderSpend => ({
    provider: "typesafe",
    pricedCalls: 10,
    unpricedCalls: complete ? 0 : 3,
    inputTokens: 1000,
    outputTokens: 500,
    usd,
    complete,
  });

  it("正常/预警/超额三档，剩余夹到 0 不出现负数", () => {
    const credit = { provider: "typesafe", creditedUsd: 10, updatedAt: "2026-10-07T00:00:00.000Z" };
    expect(creditStatus(credit, spend(1))).toMatchObject({ level: "ok", remainingUsd: 9, ratio: 0.1 });
    expect(creditStatus(credit, spend(8))).toMatchObject({ level: "warning", remainingUsd: 2 }); // 80% 起预警
    expect(creditStatus(credit, spend(8.5))).toMatchObject({ level: "warning" });
    expect(creditStatus(credit, spend(10))).toMatchObject({ level: "exhausted", remainingUsd: 0 });
    expect(creditStatus(credit, spend(12.5))).toMatchObject({ level: "exhausted", remainingUsd: 0, ratio: 1.25 });
    expect(BUDGET_WARNING_RATIO).toBe(0.8);
  });

  it("未录入额度 → unknown（不是 0 元、不是超额）", () => {
    expect(creditStatus(undefined, spend(3))).toMatchObject({ level: "unknown", spentUsd: 3 });
    expect(creditStatus({ provider: "typesafe", creditedUsd: 0 }, spend(3))).toMatchObject({ level: "unknown" });
    expect(creditStatus(undefined, undefined)).toMatchObject({ level: "unknown", spentUsd: 0 });
    expect(creditStatus(undefined, spend(3))).not.toHaveProperty("remainingUsd");
  });

  it("存在未计价调用时 complete=false，状态如实标注（界面据此写 ≥）", () => {
    const status = creditStatus({ provider: "typesafe", creditedUsd: 10 }, spend(1, false));
    expect(status.spentComplete).toBe(false);
    expect(status.spentUsd).toBe(1);
    expect(status.level).toBe("ok");
  });

  it("币种取额度行优先，其次账簿默认", () => {
    expect(creditStatus({ provider: "typesafe", creditedUsd: 1, currency: "CNY" }, undefined, book).currency).toBe("CNY");
    expect(creditStatus({ provider: "typesafe", creditedUsd: 1 }, undefined, book).currency).toBe("USD");
    expect(creditStatus(EMPTY_PROVIDER_CREDIT_BOOK.credits[0], undefined, EMPTY_PROVIDER_CREDIT_BOOK).currency).toBe("USD");
  });
});

describe("summarizeProviderSpend", () => {
  const rows = [
    { provider: "typesafe", requestedModel: "jev-latest", resolvedModel: "jev-1.13.0", inputTokens: 1_000_000, outputTokens: 0 },
    { provider: "typesafe", requestedModel: "jev-latest", resolvedModel: "jev-1.13.0", inputTokens: 0, outputTokens: 500_000 },
    { provider: "typesafe", requestedModel: "jev-latest", inputTokens: 10, outputTokens: 10 },
    { provider: "mock", requestedModel: "mock:jev-latest", inputTokens: 100, outputTokens: 100 },
  ];
  const priceFor = (provider: string, model: string) =>
    provider === "typesafe" && model === "jev-1.13.0" ? { inputPerMTok: 0.15, outputPerMTok: 0.6 } : undefined;

  it("按 resolved 模型计价（退回 requested），算不出的行计入 unpricedCalls 且 complete=false", () => {
    const spend = summarizeProviderSpend(rows, { priceFor });
    const typesafe = spend.find((entry) => entry.provider === "typesafe");
    expect(typesafe).toMatchObject({
      pricedCalls: 2,
      unpricedCalls: 1,
      inputTokens: 1_000_010,
      outputTokens: 500_010,
      complete: false,
    });
    // 0.15 + 0.3 = 0.45，未计价的第三行不产生金额（也不假装免费）
    expect(typesafe?.usd).toBe(0.45);

    const mock = spend.find((entry) => entry.provider === "mock");
    expect(mock).toMatchObject({ pricedCalls: 0, unpricedCalls: 1, usd: 0, complete: false });
    expect(spend.map((entry) => entry.provider)).toEqual(["mock", "typesafe"]);
  });

  it("没有价目表时全部记为未计价（绝不返回 0 当作已算清）", () => {
    const spend = summarizeProviderSpend(rows);
    expect(spend.every((entry) => entry.complete === false)).toBe(true);
    expect(spend.find((entry) => entry.provider === "typesafe")?.unpricedCalls).toBe(3);
  });

  it("空输入 → 空结果；无 provider 的行被忽略", () => {
    expect(summarizeProviderSpend([])).toEqual([]);
    expect(summarizeProviderSpend([{ provider: "", requestedModel: "x" }])).toEqual([]);
  });
});
