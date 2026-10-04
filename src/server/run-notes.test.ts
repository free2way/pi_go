import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HumanNote, Run } from "../shared/types.js";
import { baseRealRun } from "./real-run.js";
import { appendHumanNote, humanNotesOf, mergeHumanNotes } from "./run-notes.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { RunStore } from "./store.js";
import { createTestDb } from "./test-db.js";

const note = (at: string, text: string, kind: HumanNote["kind"] = "resume"): HumanNote => ({ at, kind, note: text, by: "user_1" });

describe("humanNotes helpers (需求历史)", () => {
  it("treats a missing list as empty and appends without duplicating", () => {
    expect(humanNotesOf(undefined)).toEqual([]);
    const first = appendHumanNote(undefined, note("2026-01-01T00:00:00.000Z", "先修并发问题"));
    expect(first).toHaveLength(1);
    expect(appendHumanNote(first, first[0])).toHaveLength(1);
  });

  it("unions two lists, dedupes identical notes and orders by time", () => {
    const older = note("2026-01-01T00:00:00.000Z", "旧需求");
    const newer = note("2026-01-02T00:00:00.000Z", "新需求", "reject");
    expect(mergeHumanNotes([newer], [older, newer]).map((item) => item.note)).toEqual(["旧需求", "新需求"]);
  });

  it("drops empty-note entries that would otherwise pollute the history", () => {
    expect(mergeHumanNotes([{ at: "2026-01-01T00:00:00.000Z", kind: "resume", note: "" }], [])).toEqual([]);
  });
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return { ...baseRealRun({
    title: "需求历史测试",
    task: "验证人工需求备注会被持久化并可被搜索。",
    repository: "/srv/workspace/pi_go",
    workspaceId: "ws_1",
    mode: "real",
    checks: ["npm test"],
    developerModel: { provider: "deepseek", model: "deepseek-flash" },
    reviewerModel: { provider: "openai-proxy", model: "gpt-5.6-sol" },
  }, "owner_1"), ...overrides };
}

function event(run: Run) {
  return { runId: run.id, round: 1, source: "system" as const, type: "run.created", message: "created", at: new Date().toISOString() };
}

describe("humanNotes merge path (需求历史)", () => {
  it("appends into the JSON store and keeps an existing note", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-notes-"));
    const store = new RunStore(path.join(directory, "runs.json"));
    await store.init();
    const run = makeRun();
    await store.createRun(run, event(run));

    const first = note("2026-01-01T00:00:00.000Z", "第一条需求");
    await store.updateRun(run.id, { humanNotes: [first] });
    // A replace-style patch with an already stored note must not duplicate it.
    const updated = await store.updateRun(run.id, { humanNotes: [first, note("2026-01-02T00:00:00.000Z", "第二条需求", "approve_accept")] });

    expect(updated.humanNotes?.map((item) => item.note)).toEqual(["第一条需求", "第二条需求"]);
  });

  it("unions a stale patch with a concurrently appended note instead of dropping it", async () => {
    const db = await createTestDb();
    const storeA = new PostgresRunStore(db);
    const storeB = new PostgresRunStore(db);
    await storeA.init();
    await storeB.init();
    const run = makeRun();
    await storeA.createRun(run, event(run));
    await storeB.hydrate(run.id);

    const base = note("2026-01-01T00:00:00.000Z", "基础需求");
    await storeA.updateRun(run.id, { humanNotes: [base] });
    // B still holds the pre-append snapshot and writes note B2.
    await storeB.updateRun(run.id, { humanNotes: [base, note("2026-01-02T00:00:00.000Z", "B 实例追加")] });
    // A stale patch from A carries only {base, A2}; base already exists, A2 is new.
    await storeA.updateRun(run.id, { humanNotes: [base, note("2026-01-03T00:00:00.000Z", "A 实例追加")] });

    const stored = storeA.getRun(run.id)?.humanNotes ?? [];
    expect(stored.map((item) => item.note)).toEqual(["基础需求", "B 实例追加", "A 实例追加"]);
  });
});
