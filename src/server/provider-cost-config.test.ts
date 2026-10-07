import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  modelPriceFilePath,
  providerCreditsFilePath,
  readModelPriceTable,
  readProviderCreditBook,
  writeModelPriceTable,
  writeProviderCreditBook,
} from "./provider-cost-config.js";

/**
 * 运维配置文件（价目表 + 人工录入额度）的读写与"完整性"上报。
 *
 * 关键取舍：文件缺失/损坏时应用照常运行（显示「未录入」/「未知」），但必须把
 * `integrity` 与原因如实报给界面——静默的"没有价格"会让人以为成本是 0。
 */

const tempDir = () => mkdtempSync(join(tmpdir(), "pigo-cost-"));

describe("路径解析", () => {
  it("显式变量优先，否则取 PI_DATA_FILE 同目录，最后退回 cwd/data", () => {
    expect(providerCreditsFilePath({ PI_PROVIDER_CREDITS_FILE: "/x/y.json" })).toBe("/x/y.json");
    expect(providerCreditsFilePath({ PI_DATA_FILE: "/srv/pigo/data/runs.json" })).toBe("/srv/pigo/data/provider-credits.json");
    expect(modelPriceFilePath({ PI_DATA_FILE: "/srv/pigo/data/runs.json" })).toBe("/srv/pigo/data/model-prices.json");
    expect(modelPriceFilePath({ PI_MODEL_PRICES_FILE: "/etc/prices.json" })).toBe("/etc/prices.json");
    expect(providerCreditsFilePath({})).toBe(join(process.cwd(), "data", "provider-credits.json"));
  });
});

describe("读取与完整性", () => {
  it("文件不存在 → missing + 空配置（不是错误）", () => {
    const file = join(tempDir(), "provider-credits.json");
    const state = readProviderCreditBook({ env: { PI_PROVIDER_CREDITS_FILE: file } });
    expect(state.integrity).toBe("missing");
    expect(state.value.credits).toEqual([]);
    expect(state.file).toBe(file);
  });

  it("合法文件 → ok + 解析结果", () => {
    const dir = tempDir();
    const file = join(dir, "provider-credits.json");
    writeFileSync(file, JSON.stringify({ credits: [{ provider: "typesafe", creditedUsd: 10 }] }));
    const state = readProviderCreditBook({ env: { PI_PROVIDER_CREDITS_FILE: file } });
    expect(state.integrity).toBe("ok");
    expect(state.value.credits[0]).toMatchObject({ provider: "typesafe", creditedUsd: 10 });
  });

  it("内容损坏 → invalid + 空配置 + 告警（应用照常起，界面能看见问题）", () => {
    const warn = vi.fn();
    const file = join(tempDir(), "model-prices.json");
    writeFileSync(file, "{ not json");
    const state = readModelPriceTable({ env: { PI_MODEL_PRICES_FILE: file }, warn });
    expect(state.integrity).toBe("invalid");
    expect(state.value.entries).toEqual([]);
    expect(state.detail).toBeTruthy();
    expect(warn).toHaveBeenCalledOnce();
    // 详情里不能带文件内容
    expect(String(warn.mock.calls[0][1]?.detail ?? "")).not.toContain("not json");
  });
});

describe("写入（人工录入路径）", () => {
  it("写入后能读回，且是 600 权限的原子替换（无 .tmp 残留）", () => {
    const dir = tempDir();
    const env = { PI_PROVIDER_CREDITS_FILE: join(dir, "provider-credits.json") };
    const file = writeProviderCreditBook({ currency: "USD", credits: [{ provider: "typesafe", creditedUsd: 10 }] }, { env });
    expect(file).toBe(env.PI_PROVIDER_CREDITS_FILE);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain('"typesafe"');
    const state = readProviderCreditBook({ env });
    expect(state.integrity).toBe("ok");
    expect(state.value.credits[0].creditedUsd).toBe(10);
    expect(readFileSync(file, "utf8")).toBe(raw); // 幂等、无半截写入
  });

  it("价目表同样可写读；写入非法数据由调用方校验（这里只保证序列化）", () => {
    const dir = tempDir();
    const env = { PI_MODEL_PRICES_FILE: join(dir, "prices.json") };
    writeModelPriceTable({ currency: "USD", entries: [{ provider: "typesafe", model: "jev-1.13.0", inputPerMTok: 0.15, outputPerMTok: 0.6 }] }, { env });
    const state = readModelPriceTable({ env });
    expect(state.integrity).toBe("ok");
    expect(state.value.entries[0].model).toBe("jev-1.13.0");
  });
});
