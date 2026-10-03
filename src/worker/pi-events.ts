import type { Run } from "../shared/types.js";

export type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type UsageTotals = PiUsage;

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addUsage(target: UsageTotals, delta: PiUsage) {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  target.cost += delta.cost;
}

export function toRunUsage(usage: UsageTotals): Run["usage"] {
  return {
    inputTokens: Math.round(usage.input),
    outputTokens: Math.round(usage.output),
    estimatedCost: usage.cost,
    cacheReadTokens: Math.round(usage.cacheRead),
    cacheWriteTokens: Math.round(usage.cacheWrite),
    totalTokens: Math.round(usage.totalTokens),
  };
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(raw: unknown): PiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const cost = (usage.cost ?? {}) as Record<string, unknown>;
  const parsed: PiUsage = {
    input: toNumber(usage.input),
    output: toNumber(usage.output),
    cacheRead: toNumber(usage.cacheRead),
    cacheWrite: toNumber(usage.cacheWrite),
    totalTokens: toNumber(usage.totalTokens),
    cost: toNumber(cost.total),
  };
  if (parsed.input === 0 && parsed.output === 0 && parsed.totalTokens === 0) return undefined;
  return parsed;
}

export function assistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (message?.role !== "assistant") return undefined;
  return message.content?.filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
}

export function toolNameFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type !== "tool_execution_start") return undefined;
  return typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
}

/**
 * Accumulates provider-reported token usage from a Pi JSON event stream.
 * `message_update.usage` is cumulative per assistant response, so it is held as
 * pending state and committed once per authoritative `message_end`.
 * See Pi docs/json.md for the wire format.
 */
export class UsageTracker {
  readonly totals: UsageTotals = emptyUsage();
  private pending?: PiUsage;

  track(event: Record<string, unknown>) {
    if (event.type === "message_update") {
      const usage = readUsage(event.usage);
      if (usage) this.pending = usage;
      return;
    }
    if (event.type !== "message_end") return;
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") return;
    const usage = readUsage(message.usage) ?? this.pending;
    if (usage) addUsage(this.totals, usage);
    this.pending = undefined;
  }
}
