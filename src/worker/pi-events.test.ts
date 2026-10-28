import { describe, expect, it } from "vitest";
import { UsageTracker, assistantErrorFromEvent, assistantTextFromEvent, emptyUsage, toRunUsage, toolNameFromEvent } from "./pi-events.js";

describe("pi events", () => {
  it("extracts tool names from tool_execution_start events", () => {
    expect(toolNameFromEvent({ type: "tool_execution_start", toolCallId: "call_abc", toolName: "bash", args: {} })).toBe("bash");
    expect(toolNameFromEvent({ type: "tool_execution_start", toolCallId: "call_abc" })).toBe("tool");
    expect(toolNameFromEvent({ type: "message_end" })).toBeUndefined();
  });

  it("extracts provider errors from failed assistant messages", () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429: rate limited", content: [] },
    };
    expect(assistantErrorFromEvent(event)).toBe("429: rate limited");
    expect(assistantErrorFromEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })).toBeUndefined();
    expect(assistantErrorFromEvent({ type: "message_end" })).toBeUndefined();
  });

  it("extracts assistant text from message_end events only", () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    };
    expect(assistantTextFromEvent(event)).toBe("hello\nworld");
    expect(assistantTextFromEvent({ type: "message_end", message: { role: "user", content: [] } })).toBeUndefined();
  });

  it("commits cumulative streaming usage once per assistant message", () => {
    const tracker = new UsageTracker();
    tracker.track({
      type: "message_update",
      usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    });
    tracker.track({
      type: "message_update",
      usage: { input: 120, output: 30, totalTokens: 150, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
    });
    tracker.track({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 120, output: 42, cacheRead: 3, cacheWrite: 4, totalTokens: 169, cost: { total: 0.012 } },
      },
    });
    expect(tracker.totals).toEqual({ input: 120, output: 42, cacheRead: 3, cacheWrite: 4, totalTokens: 169, cost: 0.012 });

    tracker.track({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
    });
    expect(tracker.totals.input).toBe(120);
  });

  it("falls back to the last streaming usage when message_end omits it", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "message_update", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } } });
    tracker.track({ type: "message_end", message: { role: "assistant", content: [] } });
    expect(tracker.totals).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.001 });
  });

  it("maps totals to the run usage shape", () => {
    const totals = emptyUsage();
    totals.input = 12.4;
    totals.output = 3.2;
    totals.cost = 0.5;
    expect(toRunUsage(totals)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      estimatedCost: 0.5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it("keeps successful tool-turn usage when a denied continuation is aborted", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } } } });
    tracker.track({ type: "message_end", message: { role: "assistant", stopReason: "aborted", usage: { input: 0, output: 0, totalTokens: 0 } } });
    expect(tracker.reportedCalls).toBe(1); expect(tracker.totals.totalTokens).toBe(12);
    expect(assistantErrorFromEvent({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Request aborted" } })).toContain("PI_ASSISTANT_ABORTED");
  });
  it("includes reported compaction usage without inventing usage for a failed compaction", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "compaction_end", result: { usage: { input: 20, output: 3, totalTokens: 23 } } });
    tracker.track({ type: "compaction_end", aborted: true });
    expect(tracker.reportedCalls).toBe(1); expect(tracker.totals.totalTokens).toBe(23);
  });
  it("counts each managed summary once and ignores the native aggregate", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "pigo_compaction_start" });
    for (const tokens of [12, 25]) tracker.track({ type: "pigo_compaction_request_end", message: { role: "assistant", stopReason: "stop", usage: { input: tokens - 2, output: 2, totalTokens: tokens } } });
    tracker.track({ type: "compaction_end", result: { usage: { input: 33, output: 4, totalTokens: 37 } } });
    tracker.track({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 8, output: 2, totalTokens: 10 } } });
    expect(tracker.reportedCalls).toBe(3); expect(tracker.totals.totalTokens).toBe(47);
  });
  it("retains per-request compaction usage when a later summary fails or is denied", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "pigo_compaction_start" });
    tracker.track({ type: "pigo_compaction_request_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2, totalTokens: 12 } } });
    const failure = { type: "pigo_compaction_request_end", message: { role: "assistant", stopReason: "error", errorMessage: "503 fixture", usage: { input: 20, output: 1, totalTokens: 21 } } };
    tracker.track(failure);
    tracker.track({ type: "compaction_end", errorMessage: "503 fixture" });
    expect(tracker.reportedCalls).toBe(1); expect(tracker.totals.totalTokens).toBe(33);
    expect(assistantErrorFromEvent(failure)).toBe("503 fixture");
    expect(assistantTextFromEvent({ ...failure, message: { ...failure.message, content: [{ type: "text", text: "Private summary" }] } })).toBeUndefined();
  });
  it("retains partial streaming usage while keeping the failed request unknown", () => {
    const tracker = new UsageTracker();
    tracker.track({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 2, totalTokens: 12 } } });
    tracker.track({ type: "message_update", usage: { input: 20, output: 1, totalTokens: 21, cost: { total: 0.01 } } });
    tracker.track({ type: "message_end", message: { role: "assistant", stopReason: "error", usage: { input: 0, output: 0, totalTokens: 0 } } });
    expect(tracker.totals.totalTokens).toBe(33); expect(tracker.totals.cost).toBe(0.01); expect(tracker.reportedCalls).toBe(1);
  });
});
