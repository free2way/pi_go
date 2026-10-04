import { describe, expect, it } from "vitest";
import type { ChatMessage, RunEvent } from "./types";
import { checkChatMessage, chatCounts, chatMessageView, chatMessagesFromEvents, clipChatContent, filterChatMessages, reworkBranchRounds, reworkRounds, type ChatPayload } from "./chat";

const baseEvent = (overrides: Partial<RunEvent>): RunEvent => ({
  seq: 1,
  runId: "run_test",
  round: 1,
  source: "system",
  type: "run.created",
  message: "created",
  at: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

const chatEvent = (seq: number, source: RunEvent["source"], chat: ChatPayload, round = 1): RunEvent =>
  baseEvent({ seq, round, source, type: "chat.message", message: chat.content, meta: { chat } });

describe("chatMessagesFromEvents", () => {
  it("prefers structured chat payloads and keeps their content", () => {
    const events: RunEvent[] = [
      baseEvent({ seq: 1, type: "chat.message", source: "system", meta: {
        chat: { channel: "developer", from: "orchestrator", to: "developer", role: "prompt", content: "please implement" },
      }, message: "please implement" }),
      baseEvent({ seq: 2, type: "agent.started", source: "developer", message: "started" }),
      baseEvent({ seq: 3, type: "chat.message", source: "reviewer", round: 1, meta: {
        chat: { channel: "handoff", from: "reviewer", to: "developer", role: "feedback", content: "fix the race" },
      }, message: "fix the race" }),
    ];

    const messages = chatMessagesFromEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.seq)).toEqual([1, 3]);
    expect(messages[0]).toMatchObject({ channel: "developer", from: "orchestrator", to: "developer", role: "prompt", content: "please implement" });
    expect(messages[1]).toMatchObject({ channel: "handoff", from: "reviewer", to: "developer", role: "feedback", content: "fix the race" });
  });

  it("falls back to activity events and detects return rounds", () => {
    const events: RunEvent[] = [
      baseEvent({ seq: 1, source: "developer", type: "agent.activity", message: "reading files" }),
      baseEvent({ seq: 2, source: "checks", type: "check.failed", message: "npm test failed" }),
      baseEvent({ seq: 3, source: "reviewer", type: "review.changes_requested", message: "changes requested" }),
    ];

    const messages = chatMessagesFromEvents(events);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ channel: "developer", to: "orchestrator", role: "status" });
    expect(messages[1]).toMatchObject({ channel: "checks", from: "checks" });
    expect(messages[2]).toMatchObject({ channel: "handoff", from: "reviewer", to: "developer", role: "feedback" });
  });

  it("filters messages by channel and counts each tab", () => {
    const messages = chatMessagesFromEvents([
      baseEvent({ seq: 1, type: "chat.message", source: "developer", meta: {
        chat: { channel: "developer", from: "developer", to: "orchestrator", role: "response", content: "a" },
      } }),
      baseEvent({ seq: 2, type: "chat.message", source: "reviewer", meta: {
        chat: { channel: "reviewer", from: "reviewer", to: "orchestrator", role: "response", content: "b" },
      } }),
      baseEvent({ seq: 3, type: "chat.message", source: "reviewer", meta: {
        chat: { channel: "handoff", from: "reviewer", to: "developer", role: "feedback", content: "c" },
      } }),
    ]);

    expect(filterChatMessages(messages, "all")).toHaveLength(3);
    expect(filterChatMessages(messages, "handoff").map((message) => message.content)).toEqual(["c"]);
    expect(chatCounts(messages)).toEqual({ all: 3, developer: 1, reviewer: 1, handoff: 1, checks: 0, system: 0 });
  });

  it("counts each tab for a realistic real-run event sequence", () => {
    const events: RunEvent[] = [
      chatEvent(1, "system", { channel: "developer", from: "orchestrator", to: "developer", role: "prompt", content: "implement" }),
      chatEvent(2, "developer", { channel: "developer", from: "developer", to: "orchestrator", role: "response", content: "done" }),
      baseEvent({ seq: 3, source: "checks", type: "check.started", message: "npm test" }),
      chatEvent(4, "checks", checkChatMessage({ command: "npm test", passed: true, durationMs: 1_200 })),
      chatEvent(5, "system", { channel: "reviewer", from: "orchestrator", to: "reviewer", role: "prompt", content: "review" }),
      chatEvent(6, "reviewer", { channel: "handoff", from: "reviewer", to: "developer", role: "feedback", content: "fix the race" }),
      baseEvent({ seq: 7, source: "reviewer", type: "review.changes_requested", message: "changes" }),
      chatEvent(8, "checks", checkChatMessage({ command: "npm test", passed: false, durationMs: 900, output: "1 failing" })),
    ];

    const counts = chatCounts(chatMessagesFromEvents(events));

    expect(counts).toEqual({ all: 6, developer: 2, reviewer: 1, handoff: 1, checks: 2, system: 0 });
  });
});

describe("checkChatMessage", () => {
  it("builds a checks status entry for a passing check", () => {
    const payload = checkChatMessage({ command: "npm test", passed: true, durationMs: 1_500 });

    expect(payload).toMatchObject({ channel: "checks", from: "checks", to: "orchestrator", role: "status" });
    expect(payload.content).toContain("检查通过");
    expect(payload.content).toContain("1.5s");
  });

  it("builds an actionable checks feedback entry for a failing check", () => {
    const payload = checkChatMessage({ command: "npm test", passed: false, durationMs: 2_000, output: "1 test failed" });

    expect(payload).toMatchObject({ channel: "checks", from: "checks", to: "developer", role: "feedback" });
    expect(payload.content).toContain("检查失败");
    expect(payload.content).toContain("1 test failed");
  });
});

describe("reworkRounds", () => {
  it("returns unique sorted rounds that the reviewer sent back", () => {
    const events: RunEvent[] = [
      baseEvent({ seq: 1, round: 2, source: "checks", type: "checks.returned" }),
      baseEvent({ seq: 2, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 3, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 4, round: 3, source: "reviewer", type: "review.approved" }),
      baseEvent({ seq: 5, round: 2, source: "reviewer", type: "review.changes_requested" }),
    ];

    expect(reworkRounds(events)).toEqual([1, 2]);
  });

  it("returns an empty list when no rework happened", () => {
    expect(reworkRounds([baseEvent({ source: "reviewer", type: "review.approved" })])).toEqual([]);
  });
});

describe("reworkBranchRounds", () => {
  it("draws a branch only when an actual reviewer return event exists", () => {
    const events: RunEvent[] = [
      baseEvent({ seq: 1, round: 1, source: "reviewer", type: "review.changes_requested" }),
      baseEvent({ seq: 2, round: 2, source: "checks", type: "checks.returned" }),
    ];

    expect(reworkBranchRounds(events)).toEqual([1]);
  });

  it("does not draw a reviewer branch when checks failed and advanced the round", () => {
    const events: RunEvent[] = [
      baseEvent({ seq: 1, round: 1, source: "checks", type: "checks.returned" }),
      baseEvent({ seq: 2, round: 2, source: "system", type: "round.started" }),
      baseEvent({ seq: 3, round: 2, source: "developer", type: "agent.started" }),
    ];

    expect(reworkBranchRounds(events)).toEqual([]);
  });
});

const chatMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "run_test-1",
  seq: 1,
  runId: "run_test",
  round: 1,
  channel: "developer",
  from: "developer",
  to: "orchestrator",
  role: "response",
  content: "hello",
  at: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

describe("clipChatContent", () => {
  it("returns short content unchanged without any marker", () => {
    const result = clipChatContent("hello");

    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello");
    expect(result.originalBytes).toBe(5);
    expect(result.retainedBytes).toBe(5);
    expect(result.content).not.toContain("截断");
  });

  it("truncates long content with an explicit original/retained byte marker", () => {
    const result = clipChatContent("x".repeat(50), 10);

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(50);
    expect(result.retainedBytes).toBe(10);
    expect(result.content.startsWith("x".repeat(10))).toBe(true);
    expect(result.content).toContain("已截断");
    expect(result.content).toContain("50 字节");
    expect(result.content).toContain("10 字节");
  });

  it("reports real UTF-8 bytes for multibyte content", () => {
    // 30 CJK characters = 90 UTF-8 bytes.
    const result = clipChatContent("中".repeat(30), 5);

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(90);
    expect(result.content).toContain("90 字节");
  });

  it("keeps a large real-run style message bounded yet marked", () => {
    const result = clipChatContent("y".repeat(100_000));

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(100_000);
    expect(result.content).toContain("100000 字节");
  });
});

describe("chatMessageView", () => {
  it("keeps short messages inline and renders them as prose", () => {
    const view = chatMessageView(chatMessage({ content: "done", role: "response" }), false);

    expect(view.collapsible).toBe(false);
    expect(view.text).toBe("done");
    expect(view.full).toBe("done");
    expect(view.monospace).toBe(false);
    expect(view.hiddenBytes).toBe(0);
  });

  it("collapses long messages but always exposes the full copy target", () => {
    const content = "a".repeat(2_000);
    const collapsed = chatMessageView(chatMessage({ content, role: "response" }), false);

    expect(collapsed.collapsible).toBe(true);
    expect(collapsed.text.length).toBeLessThan(content.length);
    expect(collapsed.text).toContain("已折叠");
    expect(collapsed.full).toBe(content);
    expect(collapsed.hiddenBytes).toBeGreaterThan(0);

    const expanded = chatMessageView(chatMessage({ content, role: "response" }), true);
    expect(expanded.text).toBe(content);
    expect(expanded.hiddenBytes).toBe(0);
  });

  it("marks prompts, tool output and fenced code as monospace", () => {
    expect(chatMessageView(chatMessage({ role: "prompt", content: "implement X" }), false).monospace).toBe(true);
    expect(chatMessageView(chatMessage({ role: "tool", content: "ls -la" }), false).monospace).toBe(true);
    expect(chatMessageView(chatMessage({ role: "response", content: "```ts\nconst a = 1;\n```" }), false).monospace).toBe(true);
    expect(chatMessageView(chatMessage({ role: "response", content: "all good" }), false).monospace).toBe(false);
  });
});
