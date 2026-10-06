/**
 * Review-triage request builder (docs/26 §9.2/§9.3).
 *
 * Projects a run into the MINIMAL redacted state and the four fixed questions
 * per finding. Runs server-side; source, diffs, logs, environment variables,
 * credentials and absolute host paths never leave this module. The stable
 * `key`/`streak` come from the same projection the Decision Brief uses
 * (`findingFingerprint` / `consecutiveRounds`), so the two views agree.
 *
 * Findings beyond `maxFindings` are split into independent batches; a batch that
 * still exceeds the payload budget is split again, and a single finding that
 * cannot fit is reported as rejected rather than truncated. Batches share no
 * state and are evaluated independently, so one failing batch cannot affect the
 * review pipeline (or the other batches).
 */

import { diffFilePaths } from "../../shared/decision-brief.js";
import { findingFingerprint } from "../../shared/finding-fingerprint.js";
import type { Finding, Run } from "../../shared/types.js";
import { DECISION_ENGINE_DEFAULTS } from "./config.js";
import {
  checkPayloadLimits,
  redactExcerpt,
  redactText,
  sha256Hex,
  stateHash,
  type PayloadLimits,
  type PayloadMeasurement,
} from "./redaction.js";
import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionEvaluation,
  DecisionMode,
  DecisionQuestion,
  DecisionRequest,
  FallbackReason,
} from "./types.js";

export const REVIEW_TRIAGE_KIND = "review_triage" as const;
export const REVIEW_TRIAGE_POLICY_VERSION = "review-triage-v1";
/** Run UI locale the projection records (there is no per-run locale field). */
export const DEFAULT_REVIEW_LOCALE = "zh-CN";
export const TASK_SUMMARY_MAX_CHARS = 600;
export const AC_MAX_ITEMS = 50;
export const AC_MAX_CHARS = 300;
export const TITLE_MAX_CHARS = 200;
export const EXCERPT_CHARS = 300;

/**
 * Marker the worker appends when it had to shrink the inline diff. Duplicated
 * as a literal on purpose, exactly like `src/server/decision-brief.ts` does:
 * this module must stay free of the worker's filesystem/crypto imports.
 */
export const INLINE_DIFF_TRUNCATION_MARKER = "# [PiGO] inline diff truncated";

export const QUESTION_SUFFIXES = ["requirement_relevant", "security_impact", "human_urgency", "retry_value"] as const;
export type QuestionSuffix = (typeof QUESTION_SUFFIXES)[number];

export const SECURITY_IMPACT_OPTIONS = ["none", "possible", "material"] as const;
export const HUMAN_URGENCY_OPTIONS = ["normal", "soon", "immediate"] as const;

/** Ordered low→high retry-value levels (Jev: 2..10). */
export const RETRY_VALUE_LEVELS: ReadonlyArray<{ value: string; description: string }> = [
  { value: "none", description: "Automated retry has no expected value for this finding." },
  { value: "low", description: "A retry might help but is unlikely to resolve the finding." },
  { value: "medium", description: "A retry is plausibly worth one more attempt." },
  { value: "high", description: "A retry is likely to resolve the finding." },
];

/** Static, versioned question templates. Content never depends on the findings. */
export const REVIEW_TRIAGE_QUESTION_TEMPLATES: Record<QuestionSuffix, DecisionQuestion> = {
  requirement_relevant: {
    type: "probability",
    prompt: "Does this finding directly affect an acceptance criterion (AC/DoD) of the task?",
    trueMeaning: "The finding directly affects a stated acceptance criterion or definition of done.",
    falseMeaning: "The finding does not directly affect any stated acceptance criterion.",
  },
  security_impact: {
    type: "choice",
    prompt: "What is the potential security impact of this finding?",
    options: [...SECURITY_IMPACT_OPTIONS],
  },
  human_urgency: {
    type: "choice",
    prompt: "How urgent is human attention for this finding?",
    options: [...HUMAN_URGENCY_OPTIONS],
  },
  retry_value: {
    type: "score",
    prompt: "What is the expected value of continuing automated repair for this finding?",
    levels: RETRY_VALUE_LEVELS.map((level) => ({ ...level })),
  },
};

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface ReviewTriageInput {
  run: Run;
  mode: DecisionMode;
  policyVersion: string;
  maxFindings: number;
  evaluationId: string;
  timeoutMs: number;
}

export interface ReviewTriageFinding {
  key: string;
  severity: Finding["severity"];
  file: string | null;
  title: string;
  evidenceExcerpt: string;
  requiredChangeExcerpt: string;
  streak: number;
}

export interface ReviewTriageState {
  run: {
    round: number;
    locale: string;
    taskSummary: string;
    acceptanceCriteria: string[];
  };
  checks: { allPassed: boolean; failedNames: string[] };
  change: { files: string[]; addedLines: number; deletedLines: number; diffComplete: boolean };
  findings: ReviewTriageFinding[];
}

/** Stable identity for a finding, matching the Decision Brief projection. */
export function findingStableKey(finding: Finding): string {
  const fingerprint = String(finding.fingerprint ?? "").trim();
  if (fingerprint) return fingerprint;
  return findingFingerprint({ file: finding.file ?? null, title: finding.title ?? null });
}

/** Safe, stable, collision-resistant question-id prefix derived from the key. */
export function findingQuestionPrefix(stableKey: string): string {
  return `f_${sha256Hex(stableKey).slice(0, 12)}`;
}

/** Stable program-generated question id: `<prefix>_<suffix>`. */
export function findingQuestionId(stableKey: string, suffix: QuestionSuffix): string {
  return `${findingQuestionPrefix(stableKey)}_${suffix}`;
}

/**
 * Strips absolute host prefixes and normalizes separators. An absolute path
 * keeps only its last two segments, so a machine layout can never leak.
 */
export function sanitizeFindingFile(file: string | null | undefined): string | null {
  if (file === null || file === undefined) return null;
  let value = String(file).trim().replace(/\\/g, "/");
  if (!value) return null;
  const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  value = value.replace(/^[A-Za-z]:/, "").replace(/^\.?\//, "");
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const kept = absolute && segments.length > 3 ? segments.slice(-3) : segments;
  return redactText(kept.join("/"));
}

/** Line/file statistics for the persisted diff — sizes only, never content. */
export function diffChangeStats(diff: string | null | undefined): ReviewTriageState["change"] {
  const text = String(diff ?? "");
  const files = diffFilePaths(text)
    .map((file) => sanitizeFindingFile(file))
    .filter((file): file is string => Boolean(file));
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) addedLines += 1;
    else if (line.startsWith("-")) deletedLines += 1;
  }
  // The inline diff carries an explicit truncation marker; without one (and with
  // actual content) completeness is the best available pure-function signal.
  const diffComplete = text.trim().length > 0 && !text.includes(INLINE_DIFF_TRUNCATION_MARKER);
  return { files, addedLines, deletedLines, diffComplete };
}

/** Unresolved findings in a stable order (severity, then stable key). */
export function selectReviewFindings(run: Run): Finding[] {
  return (run.findings ?? [])
    .filter((finding) => !finding.resolved)
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || findingStableKey(a).localeCompare(findingStableKey(b)));
}

function taskSummaryOf(run: Run): string {
  const summary = redactExcerpt(run.task?.trim() ? run.task : run.title, TASK_SUMMARY_MAX_CHARS);
  return summary;
}

function acceptanceCriteriaOf(run: Run): string[] {
  const text = String(run.acceptanceCriteria ?? "");
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, AC_MAX_ITEMS)
    .map((line) => redactExcerpt(line, AC_MAX_CHARS));
}

function checksOf(run: Run): ReviewTriageState["checks"] {
  const checks = run.checks ?? [];
  const failedNames = checks
    .filter((check) => check.status === "failed")
    .map((check) => redactExcerpt(check.name, TITLE_MAX_CHARS));
  return { allPassed: checks.length > 0 && checks.every((check) => check.status === "passed"), failedNames };
}

function findingProjection(finding: Finding): ReviewTriageFinding {
  const streak = typeof finding.consecutiveRounds === "number" && Number.isFinite(finding.consecutiveRounds)
    ? Math.max(0, Math.floor(finding.consecutiveRounds))
    : 0;
  return {
    key: findingStableKey(finding),
    severity: finding.severity,
    file: sanitizeFindingFile(finding.file),
    title: redactExcerpt(finding.title, TITLE_MAX_CHARS),
    evidenceExcerpt: redactExcerpt(finding.evidence, EXCERPT_CHARS),
    requiredChangeExcerpt: redactExcerpt(finding.requiredChange, EXCERPT_CHARS),
    streak,
  };
}

/** Builds the minimal allowlisted, redacted state for a set of findings. */
export function buildReviewTriageState(run: Run, findings: Finding[] = selectReviewFindings(run)): ReviewTriageState {
  return {
    run: {
      round: Number.isFinite(run.round) ? run.round : 0,
      locale: DEFAULT_REVIEW_LOCALE,
      taskSummary: taskSummaryOf(run),
      acceptanceCriteria: acceptanceCriteriaOf(run),
    },
    checks: checksOf(run),
    change: diffChangeStats(run.diff),
    findings: findings.map(findingProjection),
  };
}

/** The four fixed questions for a set of findings (stable ids, cloned templates). */
export function buildReviewTriageQuestions(findings: Finding[]): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const finding of findings) {
    const key = findingStableKey(finding);
    for (const suffix of QUESTION_SUFFIXES) {
      const template = REVIEW_TRIAGE_QUESTION_TEMPLATES[suffix];
      questions[findingQuestionId(key, suffix)] =
        template.type === "score"
          ? { type: "score", prompt: template.prompt, levels: template.levels.map((level) => ({ ...level })) }
          : template.type === "choice"
            ? { type: "choice", prompt: template.prompt, options: [...template.options] }
            : { type: "probability", prompt: template.prompt, trueMeaning: template.trueMeaning, falseMeaning: template.falseMeaning };
    }
  }
  return questions;
}

export interface ReviewTriageBatch {
  evaluationId: string;
  request: DecisionRequest;
  /** False when even the single-finding payload exceeds the caps (never sent). */
  withinLimits: boolean;
  reason?: "payload_rejected";
  detail?: string;
  measurement: PayloadMeasurement;
  findingKeys: string[];
}

export type ReviewTriageLimits = Partial<PayloadLimits>;

interface Fitting {
  findings: Finding[];
  withinLimits: boolean;
  detail?: string;
}

/**
 * Recursively splits a chunk until each part fits the payload budget. A single
 * finding that cannot fit is kept as an over-limit part (reported, never sent,
 * never truncated).
 */
function fitFindings(findings: Finding[], limits: PayloadLimits, run: Run): Fitting[] {
  const state = buildReviewTriageState(run, findings);
  const questions = buildReviewTriageQuestions(findings);
  const check = checkPayloadLimits(state, questions, limits);
  if (check.ok) return [{ findings, withinLimits: true }];
  if (findings.length <= 1) return [{ findings, withinLimits: false, detail: check.detail }];
  const mid = Math.ceil(findings.length / 2);
  return [
    ...fitFindings(findings.slice(0, mid), limits, run),
    ...fitFindings(findings.slice(mid), limits, run),
  ];
}

function buildRequest(input: {
  run: Run;
  findings: Finding[];
  mode: DecisionMode;
  policyVersion: string;
  evaluationId: string;
  timeoutMs: number;
}): DecisionRequest {
  const state = buildReviewTriageState(input.run, input.findings);
  const questions = buildReviewTriageQuestions(input.findings);
  return {
    evaluationId: input.evaluationId,
    runId: input.run.id,
    kind: REVIEW_TRIAGE_KIND,
    mode: input.mode,
    policyVersion: input.policyVersion,
    stateHash: stateHash(state),
    state,
    questions,
    timeoutMs: input.timeoutMs,
  };
}

/**
 * Splits a run's unresolved findings into independent, payload-safe batches.
 * Order is preserved (severity, then stable key). `maxFindings` bounds each
 * initial chunk; the token/byte caps bound each final batch.
 */
export function buildReviewTriageBatches(input: ReviewTriageInput, limits: ReviewTriageLimits = {}): ReviewTriageBatch[] {
  const policy = {
    maxTokens: limits.maxTokens ?? DECISION_ENGINE_DEFAULTS.maxStateTokens,
    maxBytes: limits.maxBytes ?? DECISION_ENGINE_DEFAULTS.maxStateBytes,
  };
  const allFindings = selectReviewFindings(input.run);
  const chunkSize = Math.max(1, Math.floor(input.maxFindings));
  const chunks: Finding[][] = [];
  for (let index = 0; index < allFindings.length; index += chunkSize) {
    chunks.push(allFindings.slice(index, index + chunkSize));
  }
  if (chunks.length === 0) chunks.push([]);

  const fittings: Fitting[] = [];
  for (const chunk of chunks) {
    fittings.push(...fitFindings(chunk, policy, input.run));
  }

  const multiple = fittings.length > 1;
  return fittings.map((fitting, index) => {
    const evaluationId = multiple ? `${input.evaluationId}-b${String(index + 1).padStart(2, "0")}` : input.evaluationId;
    const request = buildRequest({ ...input, findings: fitting.findings, evaluationId });
    const check = checkPayloadLimits(request.state, request.questions, policy);
    return {
      evaluationId,
      request,
      withinLimits: fitting.withinLimits && check.ok,
      reason: fitting.withinLimits && check.ok ? undefined : "payload_rejected",
      detail: fitting.withinLimits && check.ok ? undefined : fitting.detail ?? (!check.ok ? check.detail : undefined),
      measurement: check.measurement,
      findingKeys: fitting.findings.map(findingStableKey),
    };
  });
}

/**
 * Frozen entry point: the first (and, when everything fits, only) batch request.
 * Callers that need full coverage of a large finding set use
 * {@link buildReviewTriageBatches} so nothing is silently dropped.
 */
export function buildReviewTriageRequest(input: ReviewTriageInput): DecisionRequest {
  return buildReviewTriageBatches(input)[0].request;
}

export interface ReviewTriageRunResult {
  outcomes: Array<{ evaluationId: string; evaluation: DecisionEvaluation }>;
  answers: DecisionAnswer[];
  failures: Array<{ evaluationId: string; reason: FallbackReason }>;
  /** Over-limit batches that were never dispatched. */
  skipped: string[];
}

/**
 * Evaluates batches independently. A failing/skipped batch is recorded and the
 * remaining batches still run — the review pipeline never depends on any single
 * decision call.
 */
export async function runReviewTriageBatches(input: {
  batches: ReviewTriageBatch[];
  engine: DecisionEngine;
  signal?: AbortSignal;
}): Promise<ReviewTriageRunResult> {
  const result: ReviewTriageRunResult = { outcomes: [], answers: [], failures: [], skipped: [] };
  for (const batch of input.batches) {
    if (!batch.withinLimits) {
      result.skipped.push(batch.evaluationId);
      result.failures.push({ evaluationId: batch.evaluationId, reason: "payload_rejected" });
      continue;
    }
    try {
      const evaluation = await input.engine.evaluate(batch.request, input.signal);
      result.outcomes.push({ evaluationId: batch.evaluationId, evaluation });
      if (evaluation.status === "completed") {
        result.answers.push(...evaluation.answers);
      } else {
        result.failures.push({ evaluationId: batch.evaluationId, reason: evaluation.fallbackReason ?? "unknown" });
      }
    } catch {
      // The engine contract forbids throwing; if it ever does, one batch must not
      // take the others (or the review pipeline) down with it.
      result.failures.push({ evaluationId: batch.evaluationId, reason: "unknown" });
    }
  }
  return result;
}
