import { describe, expect, it } from "vitest";
import { mergeRunEvents } from "./events.js";
import type { RunEvent } from "./types";

const event = (seq: number, type = "chat.message", runId = "run_test"): RunEvent => ({
  seq,
  runId,
  round: 1,
  source: "developer",
  type,
  message: `message-${seq}`,
  at: "2026-10-04T10:00:00.000Z",
});

describe("mergeRunEvents", () => {
  it("keeps a streamed event that arrived during the snapshot request", () => {
    // The snapshot only contains seq 1, but seq 2 already arrived over SSE.
    const current = [event(2)];
    const snapshot = [event(1)];

    const merged = mergeRunEvents(current, snapshot);

    expect(merged.map((item) => item.seq)).toEqual([1, 2]);
    expect(merged.some((item) => item.seq === 2)).toBe(true);
  });

  it("deduplicates by sequence and keeps the latest copy", () => {
    const merged = mergeRunEvents([event(1, "old")], [event(1, "new")]);

    expect(merged).toHaveLength(1);
    expect(merged[0].type).toBe("new");
  });

  it("sorts out-of-order incoming events", () => {
    const merged = mergeRunEvents([event(3)], [event(1), event(2)]);

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("does not dedupe different runs that share a sequence number", () => {
    const merged = mergeRunEvents([event(1, "chat.message", "run_a")], [event(1, "chat.message", "run_b")]);

    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.runId).sort()).toEqual(["run_a", "run_b"]);
  });
});
