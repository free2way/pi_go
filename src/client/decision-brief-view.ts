/**
 * Decision Brief — client view helpers (docs/22 §2/§7).
 *
 * The card itself stays a thin presentational shell; the three-state rendering
 * rules and the one-click action wiring are extracted here as pure functions so
 * they are unit-testable without a DOM harness (the repo has no jsdom/testing-
 * library setup). All *judgement* still comes from the shared pure function —
 * these helpers only map a `DecisionBrief` to labels/targets/request payloads.
 */

import type { DecisionBrief } from "../shared/decision-brief";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";

export type DecisionNavTab = "checks" | "review" | "diff";
export type DecisionGateId = DecisionBrief["gates"][number]["id"];

/**
 * Locale-aware rendering of the code-generated Decision Brief text
 * (docs/24-i18n.md §9). The server always sends the Chinese field plus its
 * English `*En` counterpart, so switching language re-renders from the payload
 * already in memory (no refetch) and a missing `*En` (older payload / hand-made
 * fixture) safely falls back to the Chinese text.
 */
export function decisionGateDetail(gate: DecisionBrief["gates"][number], locale: Locale = DEFAULT_LOCALE): string {
  return locale === "en" && gate.detailEn ? gate.detailEn : gate.detail;
}

export function decisionRecommendationNote(brief: DecisionBrief, locale: Locale = DEFAULT_LOCALE): string {
  return locale === "en" && brief.recommendation.noteEn ? brief.recommendation.noteEn : brief.recommendation.note;
}

export function decisionStopMessage(stopReason: DecisionBrief["stopReason"], locale: Locale = DEFAULT_LOCALE): string {
  if (locale !== "en") return stopReason.message;
  // A recorded event may predate locale-aware generation: `messageEn` is then
  // absent and the original text is shown as-is (historically accurate).
  return stopReason.messageEn || stopReason.message;
}

/** Catalog keys for the four gate labels (the labels live in the catalog). */
export const decisionGateKeys: Record<DecisionGateId, MessageKey> = {
  checks: "decision.gate.checks",
  blocking: "decision.gate.blocking",
  scope: "decision.gate.scope",
  acceptance: "decision.gate.acceptance",
};

/** Where a non-green gate sends the operator to inspect the underlying data. */
export const decisionGateTabs: Record<DecisionGateId, DecisionNavTab> = {
  checks: "checks",
  blocking: "review",
  scope: "diff",
  acceptance: "diff",
};

export type DecisionTone = "accept" | "continue";

/** Green everywhere ⇒ accept tone; anything else (red or unknown) ⇒ continue. */
export function decisionBriefTone(brief: DecisionBrief): DecisionTone {
  return brief.recommendation.action === "accept" ? "accept" : "continue";
}

/** Catalog key for the heading, chosen by the tone. */
export function decisionBriefHeadingKey(brief: DecisionBrief): MessageKey {
  return decisionBriefTone(brief) === "accept" ? "decision.headingAccept" : "decision.headingContinue";
}

export function decisionBriefHeading(brief: DecisionBrief, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, decisionBriefHeadingKey(brief));
}

/** The anchor next to the run title is expanded only for a terminal run. */
export function decisionBriefExpanded(state: string, collapsed: boolean, terminalStates: readonly string[]): boolean {
  return terminalStates.includes(state) && !collapsed;
}

export type DecisionRemainingGroupKind = "ac" | "unknown" | "unmapped";

export interface DecisionRemainingGroup {
  kind: DecisionRemainingGroupKind;
  /** The mapped AC/DoD label when `kind === "ac"`; undefined otherwise. */
  ac?: string;
  items: DecisionBrief["remaining"];
}

/** Catalog key used for buckets that are not a concrete AC/DoD label. */
export function decisionRemainingGroupKey(kind: DecisionRemainingGroupKind): MessageKey | undefined {
  if (kind === "unknown") return "decision.group.unresolvedRelevance";
  if (kind === "unmapped") return "decision.group.unmappedAc";
  return undefined;
}

/**
 * Groups remaining findings by their mapped AC/DoD label, preserving order.
 * Findings with no confident label are split by *why*: relevance that could not
 * be ruled out is a blocking state (`unknown`), so it must not be lumped in
 * with findings proven unrelated to the story. Returns locale-neutral buckets —
 * the component renders the label from the catalog.
 */
export function groupRemainingByAc(remaining: DecisionBrief["remaining"]): DecisionRemainingGroup[] {
  const groups = new Map<string, DecisionRemainingGroup>();
  for (const item of remaining) {
    const kind: DecisionRemainingGroupKind = item.ac ? "ac" : item.relevance === "unknown" ? "unknown" : "unmapped";
    const key = item.ac ?? kind;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { kind, ...(item.ac ? { ac: item.ac } : {}), items: [item] });
  }
  return [...groups.values()];
}

/** Tab (+ finding anchor) a gate's "定位" action should open. */
export function gateNavTarget(gate: DecisionBrief["gates"][number]): { tab: DecisionNavTab; key?: string } {
  if (gate.id === "blocking") {
    const key = gate.findings?.[0]?.key;
    return key ? { tab: "review", key } : { tab: "review" };
  }
  return { tab: decisionGateTabs[gate.id] };
}

/** Request body for the existing `POST /api/runs/:id/approve` endpoint. */
export interface DecisionApproveRequest {
  mode: "continue" | "accept";
  note?: string;
  acknowledgeOpenFindings?: boolean;
}

/**
 * Maps a card action to the existing approve payload: continue carries the
 * drafted note (one item, `file|title` fingerprint), accept acknowledges the
 * open findings only when there are any.
 */
export function decisionBriefActionRequest(brief: DecisionBrief, action: DecisionTone): DecisionApproveRequest {
  if (action === "accept") {
    const request: DecisionApproveRequest = { mode: "accept" };
    if (brief.remaining.length > 0) request.acknowledgeOpenFindings = true;
    return request;
  }
  return { mode: "continue", note: brief.recommendation.note };
}

export function continueConfirmMessage(title: string, note: string, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, "decision.continueConfirm", { title, note });
}

export function acceptConfirmMessage(title: string, remainingCount: number, locale: Locale = DEFAULT_LOCALE): string {
  return remainingCount > 0
    ? t(locale, "decision.acceptConfirmWithOpen", { title, count: remainingCount })
    : t(locale, "decision.acceptConfirm", { title });
}
