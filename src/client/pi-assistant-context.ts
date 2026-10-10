import type { PiAssistantContext, PiAssistantPage } from "../shared/pi-assistant";
import type { Run } from "../shared/types";

export function buildPiAssistantContext(page: PiAssistantPage, run?: Run): PiAssistantContext {
  if (page !== "run" || !run) return { page };
  return {
    page,
    run: {
      id: run.id,
      title: run.title,
      state: run.state,
      round: run.round,
      maxRounds: run.maxRounds,
      repository: run.repository,
      summary: run.summary,
      developer: run.developer,
      reviewer: run.reviewer,
      checks: run.checks.slice(0, 8).map((check) => ({
        name: check.name,
        status: check.status,
        ...(typeof check.exitCode === "number" ? { exitCode: check.exitCode } : {}),
      })),
      findings: run.findings.slice(0, 12).map((finding) => ({
        severity: finding.severity,
        title: finding.title,
        resolved: finding.resolved,
      })),
      mergeStatus: run.merge ? "merged" : run.mergePending ? "pending" : "not_merged",
      ...(run.release ? { release: { status: run.release.status, environment: run.release.environment } } : {}),
    },
  };
}
