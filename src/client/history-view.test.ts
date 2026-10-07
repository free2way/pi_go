import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, paginate } from "./history-view";

const items = (count: number) => Array.from({ length: count }, (_value, index) => `r${index + 1}`);

describe("paginate (需求历史 · 每 10 条一页)", () => {
  it("默认页大小为 10", () => {
    expect(HISTORY_PAGE_SIZE).toBe(10);
    expect(paginate(items(25), 1).items).toHaveLength(10);
  });

  it("空列表：1 页、from/to 为 0", () => {
    expect(paginate([], 1)).toEqual({ items: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0 });
  });

  it("恰好一页：不产生多余空页", () => {
    const page = paginate(items(10), 1);
    expect(page).toMatchObject({ page: 1, pageCount: 1, from: 1, to: 10, total: 10 });
    expect(page.items).toHaveLength(10);
  });

  it("跨页切片与序号正确", () => {
    const list = items(25);
    expect(paginate(list, 1).items[0]).toBe("r1");
    const second = paginate(list, 2);
    expect(second).toMatchObject({ page: 2, pageCount: 3, from: 11, to: 20 });
    expect(second.items[0]).toBe("r11");
    const last = paginate(list, 3);
    expect(last).toMatchObject({ page: 3, pageCount: 3, from: 21, to: 25, total: 25 });
    expect(last.items).toEqual(["r21", "r22", "r23", "r24", "r25"]);
  });

  it("页码越界被夹紧（筛选后列表变短不需要调用方额外处理）", () => {
    expect(paginate(items(12), 99).page).toBe(2);
    expect(paginate(items(12), 0).page).toBe(1);
    expect(paginate(items(12), -3).page).toBe(1);
    expect(paginate(items(12), Number.NaN).page).toBe(1);
  });

  it("非法的 pageSize 回落到默认值", () => {
    expect(paginate(items(12), 1, 0).items).toHaveLength(10);
    expect(paginate(items(12), 1, Number.NaN).items).toHaveLength(10);
    expect(paginate(items(12), 1, 5).items).toHaveLength(5);
  });

  it("英文/数字标题不受影响（纯切片，不重排）", () => {
    const list = ["E2E-08 恶意仓库", "E2E SSE", "需求：模型页", ...items(8)];
    expect(paginate(list, 1).items[0]).toBe("E2E-08 恶意仓库");
    expect(paginate(list, 1).total).toBe(11);
    expect(paginate(list, 2).items).toHaveLength(1);
  });
});
