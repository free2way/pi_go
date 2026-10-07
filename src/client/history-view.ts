/**
 * 需求历史的分页（纯函数，便于单测）。
 *
 * 需求：需求历史里按每 10 条分页。分页作用在**已过滤**（搜索 / 状态筛选）的列表上，
 * 页码 1-based；越界页码会被夹到有效范围，因此筛选后列表变短不需要调用方额外处理。
 * 空列表返回 `pageCount = 1`、`from/to = 0`，便于界面显示「共 0 条」。
 */
export const HISTORY_PAGE_SIZE = 10;

export interface HistoryPage<T> {
  /** 当前页的条目（已切片）。 */
  items: T[];
  /** 生效页码（1-based，已夹紧）。 */
  page: number;
  /** 总页数（空列表为 1）。 */
  pageCount: number;
  /** 当前页第一条在整体中的序号（1-based；空列表为 0）。 */
  from: number;
  /** 当前页最后一条的序号（空列表为 0）。 */
  to: number;
  /** 过滤后的总条数。 */
  total: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number = HISTORY_PAGE_SIZE): HistoryPage<T> {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : HISTORY_PAGE_SIZE;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.trunc(page) : 1;
  const current = Math.min(Math.max(1, requested), pageCount);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: current,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
    total,
  };
}
