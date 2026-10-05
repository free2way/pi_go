import type { Finding, Run, RunEvent } from "./types";
import { findingsForRound } from "./chat";

/**
 * Per-round workflow status for the topology (`工作流拓扑`).
 *
 * The rework branches already carried a round label, but nothing told the
 * operator where that round actually stands. This module derives a compact,
 * per-round status purely from the persisted run events so the topology can
 * render a coloured badge on every round marker / `rework-<round>` branch.
 *
 * Only real event types emitted by the worker (`src/worker/index.ts`) and the
 * demo runner are recognised — nothing is invented here. Unknown or missing data
 * degrades to `planned` with zero counts instead of throwing.
 */
export type RoundWorkflowStatus =
  /** `review.approved` — the round passed independent review. */
  | "approved"
  /** `review.changes_requested` — the reviewer sent the round back. */
  | "changes_requested"
  /** deadline / recovery / failed-resume without a terminal review verdict. */
  | "interrupted"
  /** `review.*` activity, no verdict yet. */
  | "reviewing"
  /** `checks.*` activity, no verdict yet. */
  | "checking"
  /** developer / agent / plan activity. */
  | "developing"
  /** no stage signal yet (e.g. the round only exists on the run snapshot). */
  | "planned";

export type RoundStatusTone = "green" | "amber" | "red" | "blue" | "grey";

export interface RoundStatus {
  round: number;
  status: RoundWorkflowStatus;
  /** Deterministic check results recorded for this round. */
  checks: { passed: number; failed: number };
  /** Findings attributed to this round, joined across events + run. */
  findings: { total: number; resolved: number };
  /** Timestamp of the round's first event, when one exists. */
  startedAt?: string;
  /** Timestamp of the terminal review verdict, when the round has one. */
  finishedAt?: string;
}

/** Chinese label + semantic colour shared by every round badge in the UI. */
export const roundStatusMeta: Record<RoundWorkflowStatus, { label: string; tone: RoundStatusTone }> = {
  approved: { label: "审核通过", tone: "green" },
  changes_requested: { label: "已退回返修", tone: "amber" },
  interrupted: { label: "中止/超时", tone: "red" },
  reviewing: { label: "审核中", tone: "blue" },
  checking: { label: "检查中", tone: "blue" },
  developing: { label: "开发中", tone: "blue" },
  planned: { label: "已规划", tone: "grey" },
};

/** Compact tooltip: `检查 通过 3/失败 0 · 发现 1 项（已解决 0）`. */
export function roundStatusTooltip(status: RoundStatus): string {
  return `检查 通过 ${status.checks.passed}/失败 ${status.checks.failed} · 发现 ${status.findings.total} 项（已解决 ${status.findings.resolved}）`;
}

const TERMINAL_REVIEW_TYPES = new Set(["review.approved", "review.changes_requested"]);

/**
 * Interruption signals. A round that hit the run deadline, was recovered by a
 * restarted worker, or failed to resume shows as `interrupted` — but only when
 * no terminal review verdict was recorded for the same round.
 */
function isInterruptEvent(event: RunEvent): boolean {
  return event.type === "run.deadline_exceeded"
    || event.type.startsWith("run.recovery")
    || event.type === "run.resume_failed";
}

/** Chat channel carried by a `chat.message` event, falling back to the source. */
function chatChannel(event: RunEvent): string | undefined {
  const chat = event.meta?.chat as { channel?: unknown } | undefined;
  if (chat && typeof chat.channel === "string") return chat.channel;
  if (event.type === "chat.message") return event.source;
  return undefined;
}

/** `handoff` messages are the reviewer's structured return transcript. */
function isReviewChat(event: RunEvent): boolean {
  const channel = chatChannel(event);
  return channel === "reviewer" || channel === "handoff";
}

function isDevelopmentEvent(event: RunEvent): boolean {
  const type = event.type;
  return type === "round.started"
    || type === "run.resumed"
    || type === "checkpoint.development_restored"
    || type.startsWith("developer.")
    || type.startsWith("agent.")
    || type.startsWith("plan.")
    || type.startsWith("planner.")
    || type.startsWith("subagent")
    || type.startsWith("tool")
    || chatChannel(event) === "developer";
}

/**
 * Status precedence within one round:
 * approved > changes_requested > interrupted > reviewing > checking > developing > planned.
 */
function statusFromRoundEvents(own: RunEvent[]): RoundWorkflowStatus {
  if (own.some((event) => event.type === "review.approved")) return "approved";
  if (own.some((event) => event.type === "review.changes_requested")) return "changes_requested";
  if (own.some(isInterruptEvent)) return "interrupted";
  if (own.some((event) => event.type.startsWith("review.") || isReviewChat(event))) return "reviewing";
  if (own.some((event) => event.type.startsWith("checks.") || chatChannel(event) === "checks")) return "checking";
  if (own.some(isDevelopmentEvent)) return "developing";
  return "planned";
}

interface CheckLike { status?: unknown }

/** Deterministic check counts from the latest check snapshot recorded in the round. */
function checkCounts(own: RunEvent[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const event of own) {
    const checks = Array.isArray(event.meta?.checks) ? (event.meta.checks as CheckLike[]) : undefined;
    if (checks) {
      passed = checks.filter((item) => item?.status === "passed").length;
      failed = checks.filter((item) => item?.status === "failed").length;
    } else if (event.type === "checks.returned" && event.meta?.checkPassed === false) {
      // Checkpoint-restored runs omit the result array but still record failure.
      passed = 0;
      failed = 1;
    }
  }
  return { passed, failed };
}

function findingKey(finding: Finding): string {
  return finding.fingerprint ?? finding.id ?? `${finding.title}|${finding.file ?? ""}|${finding.line ?? ""}`;
}

function isFindingLike(value: unknown): value is Finding {
  return Boolean(value) && typeof value === "object" && typeof (value as Finding).title === "string";
}

function collectFindings(own: RunEvent[], run: Run | undefined, round: number): Map<string, Finding> {
  const found = new Map<string, Finding>();
  const add = (candidate: unknown) => {
    if (!isFindingLike(candidate)) return;
    const finding = candidate;
    const key = findingKey(finding);
    const existing = found.get(key);
    if (!existing) {
      found.set(key, finding);
    } else if (finding.resolved) {
      // A later snapshot resolving the same finding wins.
      found.set(key, { ...existing, resolved: true });
    }
  };
  for (const event of own) {
    if (Array.isArray(event.meta?.findings)) (event.meta.findings as unknown[]).forEach(add);
    const chat = event.meta?.chat as { findings?: unknown } | undefined;
    if (Array.isArray(chat?.findings)) (chat.findings as unknown[]).forEach(add);
  }
  // Stable identity from the run snapshot fills in rounds whose events predate
  // structured findings on the event meta.
  if (run) for (const finding of findingsForRound(run.findings ?? [], round)) add(finding);
  return found;
}

function roundStatusFor(round: number, events: RunEvent[], run: Run | undefined): RoundStatus {
  const own = events.filter((event) => event.round === round);
  const status = statusFromRoundEvents(own);
  const checks = checkCounts(own);
  const findings = collectFindings(own, run, round);
  let resolved = 0;
  for (const finding of findings.values()) if (finding.resolved) resolved += 1;
  const first = own[0];
  const terminal = [...own].reverse().find((event) => TERMINAL_REVIEW_TYPES.has(event.type));
  const result: RoundStatus = {
    round,
    status,
    checks,
    findings: { total: findings.size, resolved },
  };
  if (first?.at) result.startedAt = first.at;
  if (terminal?.at) result.finishedAt = terminal.at;
  return result;
}

/**
 * Per-round status for the topology, sorted ascending by round.
 *
 * Rounds come from the events themselves plus the run snapshot's `round` (a
 * round may exist on the run before its first event lands, and a stale snapshot
 * must still render a `planned` marker). Never throws on missing/partial data.
 */
export function roundStatuses(events: RunEvent[], run?: Run): RoundStatus[] {
  const rounds = new Set<number>();
  for (const event of events) {
    if (Number.isFinite(event.round)) rounds.add(event.round);
  }
  if (run && Number.isFinite(run.round) && run.round > 0) rounds.add(run.round);
  return [...rounds]
    .sort((a, b) => a - b)
    .map((round) => roundStatusFor(round, events, run));
}

/**
 * The authoritative marker for the live pipeline. Later rounds override the
 * status of earlier ones while a round is still open (in progress), so the
 * current round — the highest round present — is what the pipeline badge shows.
 * Returns `undefined` for an empty list.
 */
export function currentRoundStatus(statuses: RoundStatus[]): RoundStatus | undefined {
  return statuses.length ? statuses[statuses.length - 1] : undefined;
}

/** Badge payload for a `rework-<round>` branch. */
export interface BranchStatus {
  /** Status of the round the branch leads into; absent when there are no rounds. */
  status?: RoundStatus;
  /** Tooltip matching `status` (counts of the round whose status is shown). */
  tooltip?: string;
}

/**
 * Status for a `rework-<returnRound>` branch badge.
 *
 * A branch leaves the returned round and feeds the repair round it opens, so the
 * badge follows the *target* round — normally `returnRound + 1` — instead of the
 * returned round's terminal `已退回返修`. Sparse rounds resolve to the next
 * greater round present; when no later round exists yet the latest/current
 * status is reused so an in-flight repair shows 开发中/检查中/审核中. The returned
 * `tooltip` always describes the round whose status is shown.
 */
export function branchStatus(statuses: RoundStatus[], returnRound: number): BranchStatus {
  let target: RoundStatus | undefined;
  for (const status of statuses) {
    if (status.round <= returnRound) continue;
    if (!target || status.round < target.round) target = status;
  }
  const resolved = target ?? currentRoundStatus(statuses);
  return resolved ? { status: resolved, tooltip: roundStatusTooltip(resolved) } : {};
}
