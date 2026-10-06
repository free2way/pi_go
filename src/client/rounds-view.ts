import type { Finding, RoundSummary } from "../shared/types";
import type { RoundStatus, RoundWorkflowStatus } from "../shared/round-status";
import { findingsForRound, summarizeFindings, type ReworkBranchDetail } from "../shared/chat";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";

/** Catalog key for each per-round workflow status (labels live in the catalog). */
const ROUND_STATUS_KEYS: Record<RoundWorkflowStatus, MessageKey> = {
  approved: "roundStatus.approved",
  changes_requested: "roundStatus.changes_requested",
  interrupted: "roundStatus.interrupted",
  reviewing: "roundStatus.reviewing",
  checking: "roundStatus.checking",
  developing: "roundStatus.developing",
  planned: "roundStatus.planned",
};

/** Locale-neutral status label key, so shared/round-status stays text-free. */
export function roundStatusKey(status: RoundWorkflowStatus): MessageKey {
  return ROUND_STATUS_KEYS[status] ?? "roundStatus.planned";
}

export function roundStatusLabel(status: RoundWorkflowStatus, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, roundStatusKey(status));
}

/** Localized version of `roundStatusTooltip` (checks/findings counts). */
export function roundStatusTooltipText(status: RoundStatus, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, "roundStatus.tooltip", {
    passed: status.checks.passed,
    failed: status.checks.failed,
    total: status.findings.total,
    resolved: status.findings.resolved,
  });
}

/**
 * 拓扑轮次模型 — client-side shaping of the server's per-round summaries.
 *
 * The topology's branches and per-round badges used to be derived purely from
 * the client's buffered events. On a long run that buffer is capped, so older
 * `review.changes_requested` rounds vanished from the graph. These pure helpers
 * make `GET /api/runs/:id/rounds` the source of truth, while keeping the live
 * stage of an in-flight round (the summary only carries terminal verdicts) and
 * degrading to the event-derived model when the endpoint is unavailable.
 */

/** Non-terminal stages the summary cannot carry but the event window can. */
const LIVE_STATUSES: ReadonlySet<RoundWorkflowStatus> = new Set(["reviewing", "checking", "developing"]);

/**
 * One summary → one `RoundStatus`. Terminal verdicts and `interrupted` always
 * come from the summary; for a round without a verdict the live event-derived
 * stage is reused (so 审核中/检查中/开发中 still render), else `planned`.
 */
export function roundStatusFromSummary(summary: RoundSummary, eventStatus?: RoundStatus): RoundStatus {
  const status: RoundWorkflowStatus =
    summary.verdict === "approved"
      ? "approved"
      : summary.verdict === "changes_requested"
        ? "changes_requested"
        : summary.interrupted
          ? "interrupted"
          : eventStatus && LIVE_STATUSES.has(eventStatus.status)
            ? eventStatus.status
            : "planned";
  const result: RoundStatus = {
    round: summary.round,
    status,
    checks: {
      passed: summary.checks?.passed ?? 0,
      failed: summary.checks?.failed ?? 0,
    },
    findings: {
      total: summary.findings?.total ?? 0,
      resolved: summary.findings?.resolved ?? 0,
    },
  };
  if (summary.startedAt) result.startedAt = summary.startedAt;
  if (summary.finishedAt) result.finishedAt = summary.finishedAt;
  return result;
}

/**
 * Merges the server summaries (authoritative round set + verdicts/counts) with
 * the event-derived statuses. A round the endpoint has already covered always
 * keeps its summary data; a round that only exists in the event window (e.g. one
 * that started after the fetch) is appended so the pipeline stays current.
 */
export function roundStatusesFromSummaries(summaries: RoundSummary[], eventStatuses: RoundStatus[] = []): RoundStatus[] {
  const eventsByRound = new Map(eventStatuses.map((status) => [status.round, status]));
  const merged = new Map<number, RoundStatus>();
  for (const summary of summaries) {
    if (merged.has(summary.round)) continue;
    merged.set(summary.round, roundStatusFromSummary(summary, eventsByRound.get(summary.round)));
  }
  for (const status of eventStatuses) {
    if (merged.has(status.round)) continue;
    merged.set(status.round, status);
  }
  return [...merged.values()].sort((a, b) => a.round - b.round);
}

/**
 * Rounds that must render a rework branch: every round whose summary carries a
 * `changes_requested` verdict. `extraRounds` (the event-derived returns) are
 * unioned in so a return newer than the last fetch is not lost.
 */
export function reworkRoundsFromSummaries(summaries: RoundSummary[], extraRounds: number[] = []): number[] {
  const rounds = new Set<number>(extraRounds);
  for (const summary of summaries) {
    if (summary.verdict === "changes_requested") rounds.add(summary.round);
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * One `ReworkDetail` entry per rendered return round. When the server summary
 * carries the return `reason` it wins over the (possibly windowed-out) event;
 * findings still come from the run snapshot so the panel keeps its structured
 * list.
 */
export function reworkBranchDetailsFromSummaries(
  summaries: RoundSummary[],
  findings: Finding[] = [],
  fallbackDetails: ReworkBranchDetail[] = [],
  locale: Locale = DEFAULT_LOCALE,
): ReworkBranchDetail[] {
  const byRound = new Map(fallbackDetails.map((detail) => [detail.round, detail]));
  const rounds = reworkRoundsFromSummaries(summaries, fallbackDetails.map((detail) => detail.round));
  return rounds.map((round) => {
    const summary = summaries.find((candidate) => candidate.round === round && candidate.verdict === "changes_requested");
    const eventDetail = byRound.get(round);
    const roundFindings = findingsForRound(findings, round);
    const effective = roundFindings.length > 0 ? roundFindings : (eventDetail?.findings ?? []);
    const reason = summary?.reason?.trim() ? summary.reason : (eventDetail?.reason || t(locale, "rework.noReason"));
    const at = eventDetail?.at ?? summary?.finishedAt;
    return {
      round,
      reason,
      ...(at ? { at } : {}),
      findings: effective,
      summary: summarizeFindings(effective),
    };
  });
}

/** Selects the server summary as the round-status source of truth, or the event model when absent. */
export function resolveRoundStatuses(
  summaries: RoundSummary[] | undefined,
  eventStatuses: RoundStatus[],
): RoundStatus[] {
  return summaries ? roundStatusesFromSummaries(summaries, eventStatuses) : eventStatuses;
}

/** Selects the server summary as the branch source of truth, or the event model when absent. */
export function resolveReworkRounds(summaries: RoundSummary[] | undefined, eventRounds: number[]): number[] {
  return summaries ? reworkRoundsFromSummaries(summaries, eventRounds) : eventRounds;
}
