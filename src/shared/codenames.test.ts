import { describe, expect, it } from "vitest";
import { assignSubAgentCodenames, stableHash, subAgentCodename, SUBAGENT_CODENAMES } from "./codenames";

describe("subAgentCodename", () => {
  it("is deterministic for the same run + task id", () => {
    expect(subAgentCodename("run_a", "task-1")).toBe(subAgentCodename("run_a", "task-1"));
    expect(subAgentCodename("run_a", "task-1")).toBe(subAgentCodename("run_a", "task-1"));
  });

  it("always returns a name from the curated catalog", () => {
    for (const taskId of ["task-1", "task-2", "implementation", "修复并发"]) {
      expect(SUBAGENT_CODENAMES).toContain(subAgentCodename("run_a", taskId));
    }
  });

  it("hash is stable and unsigned", () => {
    expect(stableHash("run_a:task-1")).toBe(stableHash("run_a:task-1"));
    expect(stableHash("run_a:task-1")).toBeGreaterThanOrEqual(0);
  });
});

describe("assignSubAgentCodenames", () => {
  it("is deterministic across repeated calls (re-render/resume)", () => {
    const ids = ["task-1", "task-2", "task-3", "task-4"];
    expect(assignSubAgentCodenames("run_a", ids)).toEqual(assignSubAgentCodenames("run_a", ids));
  });

  it("returns one name per task id in order", () => {
    const names = assignSubAgentCodenames("run_a", ["a", "b", "c"]);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it("keeps names collision-free even when ids hash to the same slot", () => {
    // A one-name catalog forces every task onto the same slot; the walk/fallback
    // must still produce distinct names.
    const names = assignSubAgentCodenames("run_a", ["a", "b", "c", "d"], ["云舟"]);
    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => name.startsWith("云舟"))).toBe(true);
  });

  it("falls back deterministically with a suffix once the catalog is exhausted", () => {
    const catalog = ["云舟", "观澜"];
    const first = assignSubAgentCodenames("run_a", ["a", "b", "c", "d", "e"], catalog);
    const second = assignSubAgentCodenames("run_a", ["a", "b", "c", "d", "e"], catalog);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(5);
    // Every catalog entry is used before any suffixed fallback appears.
    expect(catalog.every((name) => first.includes(name))).toBe(true);
    expect(first.some((name) => /·\d+$/.test(name))).toBe(true);
  });

  it("handles an empty task list and an empty catalog", () => {
    expect(assignSubAgentCodenames("run_a", [])).toEqual([]);
    expect(new Set(assignSubAgentCodenames("run_a", ["a", "b"], [])).size).toBe(2);
  });
});
