/**
 * B3 — batch operations over a list of run ids. The route stays thin; the
 * bounded list parsing and the per-run outcome shaping (partial failures
 * reported individually) live here so they are unit-testable.
 */

export const MAX_BATCH_RUN_IDS = 50;

export type BatchAction = "continue" | "accept" | "cleanup";

export type BatchResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

/**
 * Parses and bounds the requested run ids: non-empty strings only, de-duplicated,
 * order preserved, at least one and at most `MAX_BATCH_RUN_IDS`.
 */
export function parseBatchRunIds(value: unknown): BatchResult {
  if (!Array.isArray(value)) return { ok: false, message: "runIds 必须是数组" };
  const ids = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, message: "至少需要选择一个任务" };
  if (ids.length > MAX_BATCH_RUN_IDS) return { ok: false, message: `一次最多处理 ${MAX_BATCH_RUN_IDS} 个任务` };
  return { ok: true, ids };
}

/** B6: on-disk run directory fate after a cleanup action. */
export type BatchStorageOutcome = "removed" | "kept";

export interface BatchItemOutcome {
  runId: string;
  ok: boolean;
  /** Machine-readable failure code (e.g. OPEN_FINDINGS, MERGE_CONFLICT). */
  code?: string;
  error?: string;
  /** The run state after the operation, when it succeeded. */
  state?: string;
  /** B6: for cleanup, whether the server-side run directory/worktree was removed or kept. */
  storage?: BatchStorageOutcome;
}

export interface BatchSummary {
  action: BatchAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemOutcome[];
}

export function batchItemSuccess(runId: string, state: string, storage?: BatchStorageOutcome): BatchItemOutcome {
  return { runId, ok: true, state, ...(storage ? { storage } : {}) };
}

export function batchItemFailure(runId: string, status: number, code: string | undefined, error: string, storage?: BatchStorageOutcome): BatchItemOutcome {
  return { runId, ok: false, ...(code ? { code } : {}), error: error || `HTTP ${status}`, ...(storage ? { storage } : {}) };
}

/** Shapes the ordered per-run outcomes into the response body. */
export function summarizeBatch(action: BatchAction, results: BatchItemOutcome[]): BatchSummary {
  const ordered = [...results];
  const succeeded = ordered.filter((result) => result.ok).length;
  return { action, total: ordered.length, succeeded, failed: ordered.length - succeeded, results: ordered };
}
