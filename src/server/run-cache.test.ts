import { describe, expect, it } from "vitest";
import { decodeRunCursor, paginateRuns } from "../shared/run-pagination.js";
import type { Run } from "../shared/types.js";
import { RunCache } from "./run-cache.js";

const run = (id: string, state: Run["state"] = "completed") =>
  ({ id, state, updatedAt: "2026-01-01T00:00:00.000Z" }) as Run;

describe("bounded Run history", () => {
  it("evicts the oldest finished entry and preserves active entries", () => {
    const cache = new RunCache(3);
    for (const entry of [run("active", "checking"), run("older"), run("newer")]) cache.set(entry.id, entry);
    cache.get("older");
    cache.set("incoming", run("incoming"));
    expect(cache.get("newer")).toBeUndefined();
    expect(cache.get("active")?.state).toBe("checking");
    expect(cache.get("older")?.id).toBe("older");
    expect(cache.size).toBe(3);
  });

  it("stays bounded when the cache is full of active Runs", () => {
    const cache = new RunCache(1);
    cache.set("review", run("review", "reviewing"));
    cache.set("queued", run("queued", "queued"));
    expect(cache.size).toBe(1);
    expect(cache.get("review")?.id).toBe("review");
    expect(cache.get("queued")).toBeUndefined();
  });

  it("pages tied update timestamps without duplicating a row when a newer row arrives", () => {
    const rows = ["d", "b", "c", "a"].map((id) => run(id));
    const first = paginateRuns(rows, { limit: 2 });
    expect(first.runs.map((entry) => entry.id)).toEqual(["d", "c"]);
    const cursor = decodeRunCursor(first.nextCursor!);
    const next = paginateRuns([...rows, run("new")], { limit: 2, cursor });
    expect(next.runs.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(next.nextCursor).toBeNull();
  });
});
