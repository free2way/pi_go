import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import { parseRunSearch, searchRuns } from "./run-search.js";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: `run_${Math.random().toString(36).slice(2)}`,
    ownerId: "owner_1",
    title: "修复并发刷新竞态",
    task: "修复 token 并发刷新导致的重复请求问题",
    repository: "demo/auth-service",
    branch: "pigo/1",
    mode: "demo",
    state: "completed",
    round: 1,
    maxRounds: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    developer: { provider: "deepseek", model: "m" },
    reviewer: { provider: "openai-proxy", model: "m" },
    checks: [],
    findings: [],
    diff: "",
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
    ...overrides,
  };
}

describe("parseRunSearch (需求历史)", () => {
  it("returns an empty filter when both parameters are absent (backward compatible)", () => {
    expect(parseRunSearch({})).toEqual({ ok: true, filter: {} });
    expect(parseRunSearch({ query: "", state: "" })).toEqual({ ok: true, filter: {} });
  });

  it("trims the query and accepts a known state", () => {
    expect(parseRunSearch({ query: "  并发  ", state: "needs_human" })).toEqual({
      ok: true,
      filter: { query: "并发", state: "needs_human" },
    });
  });

  it("rejects an unknown state so the route can answer 400", () => {
    const parsed = parseRunSearch({ state: "exploded" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected rejection");
    expect(parsed.error).toContain("exploded");
  });
});

describe("searchRuns (需求历史)", () => {
  it("returns the list unchanged when no filter is given", () => {
    const runs = [run(), run()];
    expect(searchRuns(runs, {})).toBe(runs);
  });

  it("matches title, task and human notes case-insensitively", () => {
    const runs = [
      run({ id: "byTitle", title: "Refactor Parser" }),
      run({ id: "byTask", title: "无关", task: "重建 PARSER 的缓存层" }),
      run({ id: "byNote", title: "无关", task: "无关任务描述", humanNotes: [{ at: "2026-01-01T00:00:00.000Z", kind: "resume", note: "重点处理 parser 边界" }] }),
      run({ id: "miss", title: "无关", task: "无关任务描述" }),
    ];
    expect(searchRuns(runs, { query: "parser" }).map((item) => item.id)).toEqual(["byTitle", "byTask", "byNote"]);
  });

  it("survives a run written before humanNotes existed", () => {
    const legacy = run({ id: "legacy", title: "旧任务", task: "旧需求" });
    delete (legacy as { humanNotes?: unknown }).humanNotes;
    expect(searchRuns([legacy], { query: "旧需求" }).map((item) => item.id)).toEqual(["legacy"]);
  });

  it("filters by state and combines it with the query", () => {
    const runs = [
      run({ id: "done", state: "completed", title: "并发修复" }),
      run({ id: "human", state: "needs_human", title: "并发修复" }),
    ];
    expect(searchRuns(runs, { state: "needs_human" }).map((item) => item.id)).toEqual(["human"]);
    expect(searchRuns(runs, { state: "completed", query: "并发" }).map((item) => item.id)).toEqual(["done"]);
    expect(searchRuns(runs, { state: "completed", query: "不存在" })).toEqual([]);
  });
});
