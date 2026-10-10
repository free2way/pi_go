import type { Locale } from "./i18n.js";
import type { ModelSelection, RunState } from "./types.js";

export const PI_ASSISTANT_PROMPT_VERSION = "pi-assistant-1";

export type PiAssistantPage =
  | "run"
  | "agile"
  | "workspaces"
  | "models"
  | "history"
  | "system"
  | "release-settings"
  | "accounts";

export interface PiAssistantRunContext {
  id: string;
  title: string;
  state: RunState;
  round: number;
  maxRounds: number;
  repository: string;
  summary: string;
  developer: ModelSelection;
  reviewer: ModelSelection;
  checks: Array<{ name: string; status: "pending" | "running" | "passed" | "failed"; exitCode?: number }>;
  findings: Array<{ severity: "critical" | "high" | "medium" | "low"; title: string; resolved: boolean }>;
  mergeStatus: "not_merged" | "pending" | "merged";
  release?: { status: string; environment?: string };
}

/** A deliberately small allowlist. Raw logs, diffs, paths and credentials never enter assistant prompts. */
export interface PiAssistantContext {
  page: PiAssistantPage;
  run?: PiAssistantRunContext;
}

export interface PiAssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PiAssistantAskInput {
  message: string;
  context: PiAssistantContext;
  history?: PiAssistantMessage[];
  model?: ModelSelection;
}

export interface PiAssistantAnswer {
  answer: string;
  category: "explain" | "diagnose" | "plan" | "navigate";
  suggestedQuestions: string[];
  model: ModelSelection;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  promptVersion: string;
}

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = cleanJson(text);
  try {
    const direct = JSON.parse(cleaned) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {
    // Fall through to bounded object extraction for providers that add a short preamble.
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
  }
  throw new SyntaxError("Pi assistant response did not contain a valid JSON object");
}

/** Strictly bounds model output before it reaches the browser. */
export function parsePiAssistantOutput(output: string): Pick<PiAssistantAnswer, "answer" | "category" | "suggestedQuestions"> {
  const raw = parseJsonObject(output);
  const answer = typeof raw.answer === "string" ? raw.answer.trim().slice(0, 6_000) : "";
  if (!answer) throw new Error("Pi assistant returned an empty answer");
  const category = raw.category === "diagnose" || raw.category === "plan" || raw.category === "navigate"
    ? raw.category
    : "explain";
  const suggestedQuestions = Array.isArray(raw.suggestedQuestions)
    ? raw.suggestedQuestions
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 3)
    : [];
  return { answer, category, suggestedQuestions };
}

export function piAssistantLanguage(locale: Locale) {
  return locale === "en" ? "English" : "Simplified Chinese";
}
