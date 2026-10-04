import { createHash } from "node:crypto";
import type { AcceptanceSnapshot, CheckResult, Finding, RunUsage } from "../shared/types.js";

/**
 * B2 — acceptance snapshot. Accepting a delivery must leave a durable, auditable
 * record of exactly what was accepted: the findings that were resolved and the
 * ones that remained (with severities), the diff artifact identity, the checks
 * summary, the model usage and the accepting operator + note. The snapshot is a
 * pure function of the run, so it is reproducible and unit-testable.
 */

export type { AcceptanceSnapshot };

/** Minimal, defensive view of a run needed to build the snapshot. */
export interface AcceptanceRunInput {
  findings?: ReadonlyArray<Pick<Finding, "id" | "severity" | "resolved">> | null;
  checks?: ReadonlyArray<Pick<CheckResult, "status">> | null;
  usage?: Pick<RunUsage, "inputTokens" | "outputTokens" | "estimatedCost"> | null;
  modelCalls?: number | null;
  diff?: string | null;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function summarizeChecks(checks: ReadonlyArray<Pick<CheckResult, "status">> | null | undefined) {
  const list = Array.isArray(checks) ? checks : [];
  return {
    total: list.length,
    passed: list.filter((check) => check.status === "passed").length,
    failed: list.filter((check) => check.status === "failed").length,
  };
}

/**
 * Resolves the diff identity: prefer the artifact metadata, otherwise hash the
 * run's inline diff. `null` values mean the identity is genuinely unknown, never
 * a fabricated zero.
 */
function resolveDiff(input: {
  artifact?: { artifactId?: string; sha256?: string | null; bytes?: number | null } | undefined;
  runDiff?: string | null | undefined;
}): AcceptanceSnapshot["diff"] {
  if (input.artifact) {
    return {
      artifactId: input.artifact.artifactId ?? "diff",
      sha256: input.artifact.sha256 ?? null,
      bytes: typeof input.artifact.bytes === "number" && Number.isFinite(input.artifact.bytes) ? input.artifact.bytes : null,
    };
  }
  if (typeof input.runDiff === "string" && input.runDiff.length > 0) {
    return {
      artifactId: "diff",
      sha256: createHash("sha256").update(input.runDiff, "utf8").digest("hex"),
      bytes: Buffer.byteLength(input.runDiff, "utf8"),
    };
  }
  return { artifactId: null, sha256: null, bytes: null };
}

export function buildAcceptanceSnapshot(input: {
  run: AcceptanceRunInput;
  acceptedAt: string;
  acceptedBy: string;
  note?: string | null;
  acknowledgedOpenFindings?: boolean;
  artifact?: { artifactId?: string; sha256?: string | null; bytes?: number | null } | undefined;
}): AcceptanceSnapshot {
  const findings = Array.isArray(input.run.findings) ? input.run.findings : [];
  const resolved = findings.filter((finding) => finding.resolved);
  const remaining = findings.filter((finding) => !finding.resolved);
  return {
    acceptedAt: input.acceptedAt,
    acceptedBy: input.acceptedBy,
    note: input.note?.trim() ? input.note.trim() : null,
    acknowledgedOpenFindings: input.acknowledgedOpenFindings === true,
    findings: {
      resolved: { count: resolved.length, ids: resolved.map((finding) => finding.id) },
      remaining: {
        count: remaining.length,
        items: remaining.map((finding) => ({ id: finding.id, severity: finding.severity })),
      },
    },
    diff: resolveDiff({ artifact: input.artifact, runDiff: input.run.diff }),
    checks: summarizeChecks(input.run.checks),
    usage: {
      inputTokens: finite(input.run.usage?.inputTokens),
      outputTokens: finite(input.run.usage?.outputTokens),
      estimatedCost: finite(input.run.usage?.estimatedCost),
      modelCalls: finite(input.run.modelCalls),
    },
  };
}
