import { describe, expect, it } from "vitest";
import type { CreditStatus, ProviderSpend } from "../shared/provider-credits";
import type { ProviderCreditsResponse } from "../shared/provider-credits-api";
import {
  creditLevelLabel,
  creditLevelTone,
  creditRemainingLabel,
  creditSpentLabel,
  formatCreditAmount,
  parseCreditInput,
  providerCreditNotices,
  providerCreditRows,
} from "./provider-credits-view";

/**
 * Provider 额度卡片的显示口径（纯函数层）。
 *
 * 守住两条：未录入额度显示「未录入」而不是 $0.00；有未计价调用时金额带 ≥，
 * 并且页面必须说明"为什么是不完整的"。
 */

const status = (over: Partial<CreditStatus> = {}): CreditStatus => ({
  provider: "typesafe",
  currency: "USD",
  creditedUsd: 10,
  spentUsd: 0.45,
  remainingUsd: 9.55,
  ratio: 0.045,
  level: "ok",
  spentComplete: true,
  ...over,
});

const response = (over: Partial<ProviderCreditsResponse> = {}): ProviderCreditsResponse => ({
  schemaVersion: 1,
  currency: "USD",
  computedAt: "2026-10-07T12:00:00.000Z",
  credits: [status()],
  spend: [] as ProviderSpend[],
  source: {
    creditsFile: "/app/data/provider-credits.json",
    creditsIntegrity: "ok",
    pricesFile: "/app/data/model-prices.json",
    pricesIntegrity: "ok",
    rows: 3,
    truncated: false,
  },
  ...over,
});

describe("金额与档位文案", () => {
  it("金额两位小数；USD/CNY 用符号，其它币种用代码", () => {
    expect(formatCreditAmount(9.5, "USD")).toBe("$9.50");
    expect(formatCreditAmount(9.5, "CNY")).toBe("¥9.50");
    expect(formatCreditAmount(9.5, "EUR")).toBe("EUR 9.50");
    expect(formatCreditAmount(undefined, "USD")).toBe("未录入");
    expect(formatCreditAmount(Number.NaN, "USD")).toBe("未录入");
  });

  it("已花：完整时不加前缀，不完整时是 ≥；剩余：未录入就是「未录入」，绝不为 0", () => {
    expect(creditSpentLabel(status())).toBe("$0.45");
    expect(creditSpentLabel(status({ spentComplete: false }))).toBe("≥ $0.45");
    expect(creditRemainingLabel(status())).toBe("$9.55");
    expect(creditRemainingLabel(status({ level: "unknown", creditedUsd: undefined, remainingUsd: undefined }))).toBe("未录入");
    expect(creditRemainingLabel(status({ level: "exhausted", remainingUsd: 0 }))).toBe("$0.00");
  });

  it("档位文案与色调：充足/接近用尽/已用尽/未录入（中英各一套）", () => {
    expect(creditLevelLabel("ok")).toBe("充足");
    expect(creditLevelLabel("warning")).toBe("接近用尽");
    expect(creditLevelLabel("exhausted")).toBe("已用尽");
    expect(creditLevelLabel("unknown")).toBe("未录入");
    expect(creditLevelLabel("warning", "en")).toBe("Running low");
    expect(creditLevelTone("exhausted")).toBe("error");
    expect(creditLevelTone("unknown")).toBe("muted");
  });
});

describe("卡片行与提示", () => {
  it("每个 provider 四行：额度/已花/剩余/状态，标签带 provider 前缀", () => {
    const rows = providerCreditRows(response());
    expect(rows.map((row) => row.key)).toEqual(["typesafe:credited", "typesafe:spent", "typesafe:remaining", "typesafe:level"]);
    expect(rows[0]).toMatchObject({ label: "typesafe · 额度", value: "$10.00", tone: "muted" });
    expect(rows[1]).toMatchObject({ label: "typesafe · 已花", value: "$0.45", tone: "muted" });
    expect(rows[2]).toMatchObject({ label: "typesafe · 剩余", value: "$9.55", tone: "ok" });
    expect(rows[3]).toMatchObject({ label: "typesafe · 状态", value: "充足", tone: "ok" });
  });

  it("未计价调用把「已花」标成 warn，并在提示里说明原因", () => {
    const rows = providerCreditRows(response({ credits: [status({ spentComplete: false })] }));
    expect(rows[1]).toMatchObject({ value: "≥ $0.45", tone: "warn" });
    expect(providerCreditNotices(response({ credits: [status({ spentComplete: false })] }))).toContain("存在未计价调用，金额为下界");
  });

  it("空历史（没有审计行）时不喊「缺价目表」——没有东西要计价", () => {
    const empty = response({ source: { ...response().source, pricesIntegrity: "missing", rows: 0 } });
    expect(providerCreditNotices(empty)).toEqual([]);
    // 一旦有审计行要计价，缺价目表就必须说明
    const withRows = response({ source: { ...response().source, pricesIntegrity: "missing", rows: 3 } });
    expect(providerCreditNotices(withRows)).toContain("未配置价目表：已花只能给下界（金额为「≥ …」）");
  });

  it("价目表缺失/损坏、额度文件损坏、读取截断、未录入任何额度 —— 各自有明确提示", () => {
    expect(providerCreditNotices(response({ source: { ...response().source, pricesIntegrity: "missing" } }))).toContain(
      "未配置价目表：已花只能给下界（金额为「≥ …」）",
    );
    expect(providerCreditNotices(response({ source: { ...response().source, pricesIntegrity: "invalid" } }))).toContain("价目表内容非法，已花按未计价处理");
    expect(providerCreditNotices(response({ source: { ...response().source, creditsIntegrity: "invalid" } }))).toContain("额度文件内容非法，请修正后再录入");
    expect(providerCreditNotices(response({ source: { ...response().source, truncated: true } }))).toContain("审计行超过读取上限，已花只是已读部分的合计");
    expect(providerCreditNotices(response({ credits: [] }))).toContain("尚未录入任何额度");
    expect(providerCreditNotices(response())).toEqual([]);
  });
});

describe("录入表单的本地校验", () => {
  it("接受 ≥0 的数字（两位小数），拒绝空/负数/非数字", () => {
    expect(parseCreditInput("10")).toBe(10);
    expect(parseCreditInput(" 9.567 ")).toBe(9.57);
    expect(parseCreditInput("0")).toBe(0);
    expect(parseCreditInput("")).toBeUndefined();
    expect(parseCreditInput("abc")).toBeUndefined();
    expect(parseCreditInput("-1")).toBeUndefined();
  });
});
