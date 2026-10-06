import { describe, expect, it } from "vitest";
import {
  asRunLocale,
  budgetExhaustedText,
  CANCELLED_TEXT,
  guardText,
  MAX_ROUNDS_TEXT,
  localizedPair,
  runFailureText,
  runLocale,
  severeRepeatLabels,
  snapshotDivergedText,
  storageErrorText,
} from "./runtime-locale.js";

describe("worker runtime locale (docs/24-i18n.md §9)", () => {
  it("reads an unknown/legacy run as Chinese", () => {
    expect(runLocale(undefined)).toBe("zh");
    expect(runLocale({})).toBe("zh");
    expect(runLocale({ locale: "de" })).toBe("zh");
    expect(runLocale({ locale: "en" })).toBe("en");
    expect(asRunLocale(null)).toBe("zh");
  });

  it("renders guard text in the run's locale and records locale + English variant", () => {
    expect(guardText(MAX_ROUNDS_TEXT, "zh")).toEqual({
      message: "达到最大审核轮次，需要人工处理",
      meta: { locale: "zh", messageEn: "Maximum review rounds reached; human handling required" },
    });
    expect(guardText(MAX_ROUNDS_TEXT, "en").message).toBe("Maximum review rounds reached; human handling required");
  });

  it("keeps the Chinese guard wording byte-identical", () => {
    expect(CANCELLED_TEXT.zh).toBe("任务已取消");
    expect(snapshotDivergedText("a；b").zh).toBe("审核快照与开发 worktree 的 tree hash 不一致，已阻断审核：a；b");
    expect(storageErrorText("storage", "boom").zh).toBe("存储错误，任务未完成，保持人工处理（storage）：boom");
    expect(budgetExhaustedText("运行预算已用尽").zh).toBe("运行预算已用尽，已停止新的模型调用：运行预算已用尽");
    expect(runFailureText("provider", "boom", "recovering").zh).toBe("Worker 恢复执行失败，保持人工处理（provider）：boom");
  });

  it("produces an English counterpart for every guard builder", () => {
    for (const text of [
      MAX_ROUNDS_TEXT,
      CANCELLED_TEXT,
      snapshotDivergedText("x"),
      storageErrorText("storage", "boom"),
      budgetExhaustedText("reason"),
      runFailureText("provider", "boom", "followup"),
    ]) {
      expect(text.en.trim()).not.toBe("");
      expect(text.en).not.toBe(text.zh);
    }
  });

  it("localizes the repeated-severe labels (rounds wording and separators)", () => {
    const items = [
      { severity: "high", title: "凭据隔离缺失", rounds: 2 },
      { severity: "critical", title: "事务提交顺序颠倒", rounds: 3 },
    ];
    expect(severeRepeatLabels(items, "zh")).toBe("high「凭据隔离缺失」(2 轮)；critical「事务提交顺序颠倒」(3 轮)");
    expect(severeRepeatLabels(items, "en")).toBe('high "凭据隔离缺失" (2 rounds); critical "事务提交顺序颠倒" (3 rounds)');
  });

  it("returns the {message, messageEn} pair used by pure planners", () => {
    expect(localizedPair(MAX_ROUNDS_TEXT, "zh")).toEqual({
      message: "达到最大审核轮次，需要人工处理",
      messageEn: "Maximum review rounds reached; human handling required",
    });
    expect(localizedPair(MAX_ROUNDS_TEXT, "en").message).toBe(localizedPair(MAX_ROUNDS_TEXT, "en").messageEn);
  });
});
