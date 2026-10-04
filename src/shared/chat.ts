import type { ChatChannel, ChatMessage, ChatParticipant, ChatRole, Finding, RunEvent } from "./types";

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
  /** Item-2: structured review findings attached to a hand-off message. */
  findings?: Finding[];
  /** Item-3: codename of the sub-agent that produced the message. */
  agent?: string;
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
      findings: payload.findings?.length ? payload.findings : undefined,
      agent: payload.agent,
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

const severityOrder: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Severity + title ordering so a round's most important findings surface first. */
export function compareFindingSeverity(a: Finding, b: Finding): number {
  return severityOrder[a.severity] - severityOrder[b.severity] || a.title.localeCompare(b.title);
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<Finding["severity"], number>;
  /** Highest-severity findings first, capped for compact rendering. */
  top: Finding[];
}

/** Count + top-severity summary used by the rework branch popover. */
export function summarizeFindings(findings: Finding[], limit = 3): FindingsSummary {
  const bySeverity: Record<Finding["severity"], number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return {
    total: findings.length,
    bySeverity,
    top: [...findings].sort(compareFindingSeverity).slice(0, limit),
  };
}

/**
 * Findings attributable to one review round. `firstSeenRound` is the stable
 * marker; runs/findings persisted before that field existed fall back to
 * `lastSeenRound`.
 */
export function findingsForRound(findings: Finding[], round: number): Finding[] {
  const firstSeen = findings.filter((finding) => finding.firstSeenRound === round);
  if (firstSeen.length > 0) return firstSeen;
  return findings.filter((finding) => finding.lastSeenRound === round);
}

export interface ReworkBranchDetail {
  round: number;
  /** The `review.changes_requested` message for this round. */
  reason: string;
  at?: string;
  findings: Finding[];
  summary: FindingsSummary;
}

/**
 * One entry per rendered rework branch: the reviewer's return message plus the
 * findings for that round. Findings prefer the review event's own `meta.findings`
 * when present, and otherwise join `run.findings` by round/first_seen_round.
 */
export function reworkBranchDetails(events: RunEvent[], findings: Finding[] = []): ReworkBranchDetail[] {
  const byRound = new Map<number, RunEvent>();
  for (const event of events) {
    if (event.type === "review.changes_requested") byRound.set(event.round, event);
  }
  return [...byRound.values()]
    .sort((a, b) => a.round - b.round)
    .map((event) => {
      const roundFindings = findingsForRound(findings, event.round);
      const metaFindings = Array.isArray(event.meta?.findings) ? (event.meta.findings as Finding[]) : [];
      const effective = roundFindings.length > 0 ? roundFindings : metaFindings;
      return {
        round: event.round,
        reason: event.message,
        at: event.at,
        findings: effective,
        summary: summarizeFindings(effective),
      };
    });
}

/** Review rounds and reviewer/hand-off messages carry the reviewer's structured output. */
export function isReviewMessage(message: ChatMessage): boolean {
  return message.channel === "handoff" || message.channel === "reviewer";
}

function isFindingLike(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.title === "string" && typeof item.severity === "string" && item.severity in severityOrder;
}

/**
 * Best-effort recovery of findings from a message body. Real runs persist the
 * review hand-off as `JSON.stringify(findings, null, 2)`; this makes those older
 * messages render structured without a migration or new API.
 */
export function parseFindings(content: string): Finding[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFindingLike).map((item) => ({ ...item, requiredChange: item.requiredChange ?? "", evidence: item.evidence ?? "", resolved: item.resolved ?? false }));
  } catch {
    return [];
  }
}

/** Structured findings for a chat message: attached payload first, JSON body second. */
export function messageFindings(message: ChatMessage): Finding[] {
  if (message.findings && message.findings.length > 0) return message.findings;
  return parseFindings(message.content);
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
