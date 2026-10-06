/**
 * Decision Brief — server aggregation (docs/22-decision-brief.md §3/§6).
 *
 * Reads only existing tables/events for one run, shapes them into the pure
 * function's input, and delegates every judgement to
 * `src/shared/decision-brief.ts`. No model calls, no new persistence, and a
 * bounded, fixed set of queries (no full event log is ever loaded: the stop
 * reason only needs the tail, and findings/checks are one row per item).
 */

import {
  buildDecisionBrief,
  diffFilePaths,
  type DecisionBrief,
  type DecisionBriefCheckInput,
  type DecisionBriefCriterion,
  type DecisionBriefEventInput,
  type DecisionBriefFindingInput,
  type DecisionBriefInput,
} from "../shared/decision-brief.js";
import { findingFingerprint } from "../shared/finding-fingerprint.js";
import type { Run } from "../shared/types.js";
import type { Queryable } from "./db.js";

/**
 * Tail window of `run_events` used for stop-reason resolution. Stop events are
 * terminal, so the last few hundred rows always contain the deciding one while
 * keeping the read bounded on long runs.
 */
export const DECISION_BRIEF_EVENT_LIMIT = 200;

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseMeta(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isResolved(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * Collects the run's existing rows into the pure function's input.
 *
 * `run_findings` supplies the durable streak/stable key; the run document is
 * consulted for the fields the table does not store (`evidence`,
 * `requiredChange`). When the projection is empty (legacy/demo runs) the
 * document findings are used directly. Malformed JSON/meta degrades to an empty
 * value instead of throwing.
 */
export async function collectDecisionBriefInput(db: Queryable, run: Run): Promise<DecisionBriefInput> {
  const [eventRows, findingRows, checkRows, storyRows] = await Promise.all([
    db.query(
      `SELECT type, message, meta_json FROM run_events WHERE run_id = $1 ORDER BY seq DESC LIMIT ${DECISION_BRIEF_EVENT_LIMIT}`,
      [run.id],
    ),
    db.query(
      `SELECT finding_id, severity, file, line, title, resolved, consecutive_rounds, stable_key
         FROM run_findings WHERE run_id = $1 ORDER BY finding_id ASC`,
      [run.id],
    ),
    db.query(
      "SELECT check_id, name, command, status, exit_code FROM run_checks WHERE run_id = $1 ORDER BY check_id ASC",
      [run.id],
    ),
    db.query(
      `SELECT s.acceptance_criteria_json, s.definition_of_done_json
         FROM story_runs sr JOIN agile_stories s ON s.id = sr.story_id
        WHERE sr.run_id = $1 LIMIT 1`,
      [run.id],
    ),
  ]);

  // The query reads newest-first (bounded by seq); stop-reason resolution walks
  // chronologically, so restore ascending order.
  const events: DecisionBriefEventInput[] = (eventRows.rows as Array<Record<string, unknown>>)
    .reverse()
    .map((row) => ({ type: str(row.type) ?? "", message: str(row.message) ?? "", meta: parseMeta(row.meta_json) }));

  const documentFindings = run.findings ?? [];
  const byId = new Map(documentFindings.map((finding) => [finding.id, finding]));
  const byKey = new Map(documentFindings.map((finding) => [finding.fingerprint ?? findingFingerprint(finding), finding]));

  const findings: DecisionBriefFindingInput[] = (findingRows.rows as Array<Record<string, unknown>>).map((row) => {
    const id = str(row.finding_id) ?? "";
    const stableKey = str(row.stable_key);
    const document = byId.get(id) ?? (stableKey ? byKey.get(stableKey) : undefined);
    const file = str(row.file) ?? document?.file ?? null;
    const title = str(row.title) ?? document?.title ?? "";
    return {
      id,
      stableKey: stableKey ?? document?.fingerprint ?? findingFingerprint({ file, title }),
      severity: str(row.severity) ?? document?.severity ?? null,
      resolved: isResolved(row.resolved),
      file,
      line: num(row.line) ?? document?.line ?? null,
      title,
      evidence: document?.evidence ?? "",
      requiredChange: document?.requiredChange ?? "",
      consecutiveRounds: num(row.consecutive_rounds) ?? document?.consecutiveRounds ?? 0,
    };
  });
  // Legacy rows that never reached the projection still have document findings.
  if (findings.length === 0) {
    for (const finding of documentFindings) {
      findings.push({
        id: finding.id,
        stableKey: finding.fingerprint ?? findingFingerprint(finding),
        severity: finding.severity,
        resolved: finding.resolved,
        file: finding.file,
        line: finding.line,
        title: finding.title,
        evidence: finding.evidence,
        requiredChange: finding.requiredChange,
        consecutiveRounds: finding.consecutiveRounds ?? 0,
      });
    }
  }

  const projectedChecks: DecisionBriefCheckInput[] = (checkRows.rows as Array<Record<string, unknown>>).map((row) => ({
    id: str(row.check_id) ?? "",
    name: str(row.name) ?? "",
    command: str(row.command) ?? "",
    status: str(row.status) ?? "",
    exitCode: num(row.exit_code) ?? null,
  }));
  const checks = projectedChecks.length > 0
    ? projectedChecks
    : (run.checks ?? []).map((check) => ({
        id: check.id,
        name: check.name,
        command: check.command,
        status: check.status,
        exitCode: check.exitCode ?? null,
      }));

  const criteria: DecisionBriefCriterion[] = [];
  const story = storyRows.rows[0] as Record<string, unknown> | undefined;
  if (story) {
    parseStringArray(story.acceptance_criteria_json).forEach((text, index) => criteria.push({ label: `AC#${index + 1}`, text }));
    parseStringArray(story.definition_of_done_json).forEach((text, index) => criteria.push({ label: `DoD#${index + 1}`, text }));
  } else if (run.acceptanceCriteria?.trim()) {
    run.acceptanceCriteria
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((text, index) => criteria.push({ label: `AC#${index + 1}`, text }));
  }

  return {
    criteria,
    findings,
    checks,
    diffFiles: run.diff && run.diff.trim() ? diffFilePaths(run.diff) : [],
    // No explicit allowed-path constraint is recorded on a run yet; generators
    // and dirty artefacts are still rejected by the scope gate.
    allowedPaths: null,
    events,
  };
}

/** Owner-scoped aggregation entry point used by the run-detail route. */
export async function readDecisionBrief(db: Queryable, run: Run): Promise<DecisionBrief> {
  return buildDecisionBrief(await collectDecisionBriefInput(db, run));
}
