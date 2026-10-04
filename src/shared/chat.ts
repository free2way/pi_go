import type { ChatChannel, ChatMessage, ChatParticipant, ChatRole, RunEvent } from "./types";

export type ChatTab = "all" | ChatChannel;

export const chatTabs: Array<{ id: ChatTab; label: string; hint: string }> = [
  { id: "all", label: "全部", hint: "完整协作对话" },
  { id: "developer", label: "开发", hint: "Developer Agent 会话" },
  { id: "reviewer", label: "审核", hint: "Reviewer Agent 会话" },
  { id: "handoff", label: "退回", hint: "审核与检查退回意见" },
  { id: "checks", label: "检查", hint: "确定性检查结果" },
  { id: "system", label: "系统", hint: "编排器事件" },
];

export const chatChannelLabels: Record<ChatChannel, string> = {
  developer: "开发",
  reviewer: "审核",
  handoff: "退回",
  checks: "检查",
  system: "系统",
};

export const chatParticipantLabels: Record<ChatParticipant, string> = {
  orchestrator: "编排器",
  developer: "开发 Agent",
  reviewer: "审核 Agent",
  checks: "质量检查",
  user: "用户",
};

export interface ChatPayload {
  channel: ChatChannel;
  from: ChatParticipant;
  to: ChatParticipant;
  role: ChatRole;
  content: string;
}

/** Reads the structured chat payload attached to a `chat.message` event. */
function chatPayload(event: RunEvent): ChatPayload | undefined {
  const meta = event.meta?.chat as ChatPayload | undefined;
  if (!meta || typeof meta.content !== "string" || !meta.content.trim()) return undefined;
  return meta;
}

/** Maps legacy/plain activity events into chat entries when no chat stream exists. */
function fallbackPayload(event: RunEvent): ChatPayload {
  const isReturn = event.type.includes("changes_requested") || event.type.includes("returned");
  const channel: ChatChannel = isReturn
    ? "handoff"
    : event.source === "developer"
      ? "developer"
      : event.source === "reviewer"
        ? "reviewer"
        : event.source === "checks"
          ? "checks"
          : "system";
  const role: ChatRole = event.type.startsWith("tool")
    ? "tool"
    : isReturn
      ? "feedback"
      : "status";
  return {
    channel,
    from: event.source === "system" ? "orchestrator" : event.source,
    to: isReturn ? "developer" : "orchestrator",
    role,
    content: event.message,
  };
}

/**
 * Turns the persisted run events into an ordered chat transcript.
 * Events carrying a structured `meta.chat` payload are used verbatim; when none
 * exist (older runs or plain activity feeds) every event is mapped instead.
 */
export function chatMessagesFromEvents(events: RunEvent[]): ChatMessage[] {
  const explicit = events.filter((event) => chatPayload(event));
  const source = explicit.length ? explicit : events;
  return source.map((event) => {
    const payload = chatPayload(event) ?? fallbackPayload(event);
    return {
      id: `${event.runId}-${event.seq}`,
      seq: event.seq,
      runId: event.runId,
      round: event.round,
      channel: payload.channel,
      from: payload.from,
      to: payload.to,
      role: payload.role,
      content: payload.content,
      at: event.at,
    };
  });
}

export function filterChatMessages(messages: ChatMessage[], tab: ChatTab): ChatMessage[] {
  return tab === "all" ? messages : messages.filter((message) => message.channel === tab);
}

/** UTF-8 byte length without depending on Node's Buffer (isomorphic). */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Hard per-message cap on persisted chat content. A cap keeps storage bounded,
 * but it must never truncate silently: the caller appends `chatTruncationMarker`
 * so the reader can see that content was dropped and how much.
 */
export const CHAT_CONTENT_MAX = 12_000;

export interface ClippedChatContent {
  /** Content to persist (already carries the marker when truncated). */
  content: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
}

/** Explicit, human-readable marker appended to a truncated chat message. */
export function chatTruncationMarker(originalBytes: number, retainedBytes: number): string {
  return `\n\n…（内容已截断：完整内容约 ${originalBytes} 字节，此处保留前 ${retainedBytes} 字节；完整输出请查看制品或服务器日志）`;
}

/**
 * Bounds one chat message to `max` characters and, when it clipped anything,
 * appends an explicit marker with the original/retained byte counts. Never
 * returns truncated content without the marker.
 */
export function clipChatContent(content: string, max = CHAT_CONTENT_MAX): ClippedChatContent {
  const originalBytes = utf8Bytes(content);
  if (content.length <= max) {
    return { content, truncated: false, originalBytes, retainedBytes: originalBytes };
  }
  const head = content.slice(0, max);
  const retainedBytes = utf8Bytes(head);
  return { content: `${head}${chatTruncationMarker(originalBytes, retainedBytes)}`, truncated: true, originalBytes, retainedBytes };
}

/** Long messages are collapsed by default; short ones render inline. */
export const CHAT_COLLAPSE_BYTES = 700;
export const CHAT_COLLAPSE_LINES = 12;

export interface ChatMessageView {
  /** Text to render right now (preview when collapsed, full when expanded). */
  text: string;
  /** Full persisted content — the copy target, never a slice. */
  full: string;
  collapsible: boolean;
  expanded: boolean;
  /** Prompts, tool output and fenced code render as a monospace block. */
  monospace: boolean;
  bytes: number;
  /** Bytes hidden by the collapsed preview (0 when expanded/not collapsible). */
  hiddenBytes: number;
}

function looksLikeCode(message: ChatMessage): boolean {
  if (message.role === "prompt" || message.role === "tool") return true;
  if (message.content.includes("```")) return true;
  return message.content.split("\n").some((line) => /^\s{2,}\S/.test(line));
}

/**
 * Pure shaping for one chat entry: decides whether it is collapsible, whether
 * it should render monospace, and returns the exact text for the current
 * expand/collapse state. Collapsing only shortens what is displayed — the full
 * `content` is always available via `full` (copy) and the expanded state.
 */
export function chatMessageView(message: ChatMessage, expanded: boolean): ChatMessageView {
  const full = message.content;
  const bytes = utf8Bytes(full);
  const lines = full.split("\n").length;
  const collapsible = bytes > CHAT_COLLAPSE_BYTES || lines > CHAT_COLLAPSE_LINES;
  if (!collapsible || expanded) {
    return { text: full, full, collapsible, expanded, monospace: looksLikeCode(message), bytes, hiddenBytes: 0 };
  }
  const preview = full.slice(0, CHAT_COLLAPSE_BYTES);
  const hiddenBytes = Math.max(0, bytes - utf8Bytes(preview));
  return {
    text: `${preview.trimEnd()}\n…（已折叠约 ${hiddenBytes} 字节，展开查看完整内容）`,
    full,
    collapsible,
    expanded,
    monospace: looksLikeCode(message),
    bytes,
    hiddenBytes,
  };
}

export function chatCounts(messages: ChatMessage[]): Record<ChatTab, number> {
  const counts = { all: messages.length } as Record<ChatTab, number>;
  for (const tab of chatTabs) {
    if (tab.id === "all") continue;
    counts[tab.id] = messages.filter((message) => message.channel === tab.id).length;
  }
  return counts;
}

/** Returns the rounds in which the reviewer asked the developer to rework. */
export function reworkRounds(events: RunEvent[]): number[] {
  const rounds = events
    .filter((event) => event.type === "review.changes_requested")
    .map((event) => event.round);
  return [...new Set(rounds)].sort((a, b) => a - b);
}

/**
 * The rounds that should be rendered as reviewer rework branches.
 *
 * Only a real `review.changes_requested` event proves the reviewer sent work
 * back. We deliberately never infer a branch from `run.round > 1`: deterministic
 * check failures also advance the round without any reviewer involvement, so a
 * round-based fallback would draw a bogus Reviewer → Developer branch.
 */
export function reworkBranchRounds(events: RunEvent[]): number[] {
  return reworkRounds(events);
}

export interface CheckChatInput {
  command: string;
  passed: boolean;
  durationMs: number;
  output?: string;
}

/** Builds the structured `checks` chat entry for a finished check command. */
export function checkChatMessage(input: CheckChatInput): ChatPayload {
  const seconds = (input.durationMs / 1000).toFixed(1);
  if (input.passed) {
    return {
      channel: "checks",
      from: "checks",
      to: "orchestrator",
      role: "status",
      content: `检查通过：${input.command}（${seconds}s）`,
    };
  }
  const detail = (input.output ?? "").trim().slice(-2_000);
  return {
    channel: "checks",
    from: "checks",
    to: "developer",
    role: "feedback",
    content: `检查失败：${input.command}（${seconds}s）${detail ? `\n\n${detail}` : ""}`,
  };
}
