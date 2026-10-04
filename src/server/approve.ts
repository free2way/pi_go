import type { Finding } from "../shared/types.js";

/**
 * RUN-006 follow-up: the approve route used to conflate two distinct operator
 * intents. Clicking "approve" on a run that stopped at `needs_human` with open
 * review findings silently completed the run and accepted every finding. The
 * plan helpers below split the decision into an explicit, pure function so the
 * route stays a thin adapter and the semantics are unit-testable.
 */
export type ApproveMode = "continue" | "accept";

/** Optional body of `POST /api/runs/:id/approve`. */
export interface ApproveRequest {
  mode?: ApproveMode;
  note?: string;
  acknowledgeOpenFindings?: boolean;
}

/** Count + stable ids of the findings that are still open (unresolved). */
export interface OpenFindingsSummary {
  count: number;
  ids: string[];
}

export type ApprovePlan =
  | {
      decision: "continue";
      mode: "continue";
      /** Back to development for another round; never completes. */
      targetState: "developing";
      openFindings: OpenFindingsSummary;
    }
  | {
      decision: "accept";
      mode: "accept";
      targetState: "completed";
      openFindings: OpenFindingsSummary;
      /** True when the operator explicitly accepted still-open findings. */
      acknowledged: boolean;
    }
  | {
      decision: "conflict";
      status: 409;
      code: "OPEN_FINDINGS";
      message: string;
      openFindings: OpenFindingsSummary;
    };

/** Open = not resolved yet. Defensive against older snapshots without findings. */
export function summarizeOpenFindings(
  findings: ReadonlyArray<Pick<Finding, "id" | "resolved">> | null | undefined,
): OpenFindingsSummary {
  const open = (findings ?? []).filter((finding) => !finding.resolved);
  return { count: open.length, ids: open.map((finding) => finding.id) };
}

/**
 * Decides what an approve request means. `mode` defaults to `"accept"` for
 * backward compatibility, but accepting a run that still has open findings now
 * requires an explicit `acknowledgeOpenFindings: true`; otherwise the caller
 * (route) must answer 409 OPEN_FINDINGS and leave the run at needs_human.
 *
 * `mode: "continue"` never completes and never requires acknowledgement: it
 * sends the run back to development for another round.
 */
export function planApprove(input: {
  mode?: ApproveMode;
  acknowledgeOpenFindings?: boolean;
  findings?: ReadonlyArray<Pick<Finding, "id" | "resolved">> | null;
}): ApprovePlan {
  const mode: ApproveMode = input.mode ?? "accept";
  const openFindings = summarizeOpenFindings(input.findings);

  if (mode === "continue") {
    return { decision: "continue", mode: "continue", targetState: "developing", openFindings };
  }

  const acknowledged = input.acknowledgeOpenFindings === true;
  if (openFindings.count > 0 && !acknowledged) {
    return {
      decision: "conflict",
      status: 409,
      code: "OPEN_FINDINGS",
      message: `还有 ${openFindings.count} 条未解决意见，需确认接受后才能完成交付`,
      openFindings,
    };
  }

  return {
    decision: "accept",
    mode: "accept",
    targetState: "completed",
    openFindings,
    acknowledged: openFindings.count > 0 && acknowledged,
  };
}

/**
 * Audit metadata attached to the `run.approved` event. `continue` records the
 * round's open-finding count; `accept` records exactly which open findings the
 * operator accepted (`{count, ids}`) so a later audit can tell whether a
 * delivery was accepted with known-unresolved findings.
 */
export function approveEventMeta(
  plan: Extract<ApprovePlan, { decision: "continue" | "accept" }>,
  approvedBy: string,
): Record<string, unknown> {
  if (plan.decision === "continue") {
    return {
      approvedBy,
      mode: "continue",
      openFindingsCount: plan.openFindings.count,
      openFindings: plan.openFindings,
    };
  }
  return {
    approvedBy,
    mode: "accept",
    acceptedOpenFindings: plan.openFindings,
  };
}
