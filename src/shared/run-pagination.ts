import type { Run } from "./types.js";

export type RunCursor = [updatedAt: string, id: string];
export type RunPageRequest = { limit: number; cursor?: RunCursor };
export type RunPage = { runs: Run[]; nextCursor: string | null; total: number; running: number };

export function encodeRunCursor(run: Pick<Run, "updatedAt" | "id">) {
  return JSON.stringify([run.updatedAt, run.id]);
}

export function decodeRunCursor(value: string): RunCursor | undefined {
  if (value.length > 512) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [date, id] = parsed;
    if (typeof date !== "string" || date.length > 64 || !Number.isFinite(Date.parse(date))) return undefined;
    if (typeof id !== "string" || !id || id.length > 256) return undefined;
    return [date, id];
  } catch {
    return undefined;
  }
}

export function runningRunCount(runs: Run[]) {
  return runs.filter((run) => !["completed", "failed", "cancelled", "needs_human"].includes(run.state)).length;
}

export function paginateRuns(runs: Run[], { limit, cursor }: RunPageRequest): RunPage {
  const sorted = [...runs].sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.id === b.id ? 0 : a.id > b.id ? -1 : 1
      : a.updatedAt > b.updatedAt ? -1 : 1,
  );
  const eligible = cursor
    ? sorted.filter((run) => run.updatedAt < cursor[0] || (run.updatedAt === cursor[0] && run.id < cursor[1]))
    : sorted;
  const page = eligible.slice(0, limit);
  return {
    runs: page,
    nextCursor: eligible.length > limit ? encodeRunCursor(page[page.length - 1]) : null,
    total: sorted.length,
    running: runningRunCount(sorted),
  };
}
