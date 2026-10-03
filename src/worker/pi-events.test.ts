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
});
