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

export type DecisionNavTab = "checks" | "review" | "diff";
export type DecisionGateId = DecisionBrief["gates"][number]["id"];

export const decisionGateLabels: Record<DecisionGateId, string> = {
  checks: "检查",
  blocking: "阻断问题",
  scope: "范围",
  acceptance: "验收覆盖",
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

export function decisionBriefHeading(brief: DecisionBrief): string {
  return decisionBriefTone(brief) === "accept" ? "决策摘要 · 可以接受交付" : "决策摘要 · 建议继续开发";
}

/** The anchor next to the run title is expanded only for a terminal run. */
export function decisionBriefExpanded(state: string, collapsed: boolean, terminalStates: readonly string[]): boolean {
  return terminalStates.includes(state) && !collapsed;
}

export interface DecisionRemainingGroup {
  label: string;
  items: DecisionBrief["remaining"];
}

/** Groups remaining findings by their mapped AC/DoD label, preserving order. */
export function groupRemainingByAc(remaining: DecisionBrief["remaining"]): DecisionRemainingGroup[] {
  const groups = new Map<string, DecisionBrief["remaining"]>();
  for (const item of remaining) {
    const label = item.ac ?? "未映射到 AC";
    const list = groups.get(label);
    if (list) list.push(item);
    else groups.set(label, [item]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
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

export function continueConfirmMessage(title: string, note: string): string {
  return `继续开发「${title}」？\n\n将带上建议备注：\n${note}`;
}

export function acceptConfirmMessage(title: string, remainingCount: number): string {
  return `${remainingCount > 0 ? `仍有 ${remainingCount} 条未解决意见，将记录为已知接受。\n\n` : ""}确认接受「${title}」的交付？`;
}
