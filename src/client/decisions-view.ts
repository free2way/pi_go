/**
 * Decision-audit panel — client view helpers (docs/26 §8.2).
 *
 * The panel component stays a thin presentational shell; every mapping from a
 * `DecisionAuditProjection` to labels/tones/rows is a pure function here so it is
 * unit-testable without a DOM harness (the repo has no jsdom/testing-library
 * setup, matching `budget-roles-view.ts` / `decision-brief-view.ts`).
 *
 * Two rules are load-bearing:
 *
 *  - **Cost** follows AT-JEV-062: a missing/non-finite `estimatedCostUsd` renders
 *    as the shared "unknown" wording, NEVER `$0.000`. An explicit `0` is a real
 *    value and renders as `$0.0000`.
 *  - **`stateManifest` is never rendered**: it can be large and can carry code
 *    snippets from the state. Only a stable, numeric summary (question count and
 *    estimated state tokens) is surfaced.
 */

import type {
  DecisionAuditAnswer,
  DecisionAuditAnswerType,
  DecisionAuditKind,
  DecisionAuditMode,
  DecisionAuditProjection,
  DecisionAuditStatus,
} from "../shared/decision-audit";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";
import type { DecisionEngineStatus } from "./api";

/** Visual tone, reusing the `model-verify` / `budget` semantic colours. */
export type DecisionTone = "ok" | "warn" | "error" | "muted";

export const DECISION_STATUS_KEYS: Record<DecisionAuditStatus, MessageKey> = {
  completed: "decisions.status.completed",
  fallback: "decisions.status.fallback",
  rejected: "decisions.status.rejected",
  disabled: "decisions.status.disabled",
};

export const DECISION_MODE_KEYS: Record<DecisionAuditMode, MessageKey> = {
  off: "decisions.mode.off",
  shadow: "decisions.mode.shadow",
  assist: "decisions.mode.assist",
  enforce: "decisions.mode.enforce",
};

export const DECISION_KIND_KEYS: Record<DecisionAuditKind, MessageKey> = {
  review_triage: "decisions.kind.review_triage",
  human_queue: "decisions.kind.human_queue",
  planner_route: "decisions.kind.planner_route",
  failure_route: "decisions.kind.failure_route",
  ci_risk: "decisions.kind.ci_risk",
};

export const DECISION_ANSWER_TYPE_KEYS: Record<DecisionAuditAnswerType, MessageKey> = {
  probability: "decisions.answerType.probability",
  choice: "decisions.answerType.choice",
  score: "decisions.answerType.score",
};

/** Status label + tone. A non-green status is never silently rendered as OK. */
export function decisionStatusMeta(status: DecisionAuditStatus, locale: Locale = DEFAULT_LOCALE): { label: string; tone: DecisionTone } {
  const tone: DecisionTone = status === "completed" ? "ok" : status === "rejected" ? "error" : status === "disabled" ? "muted" : "warn";
  return { label: t(locale, DECISION_STATUS_KEYS[status]), tone };
}

export function decisionModeLabel(mode: DecisionAuditMode, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, DECISION_MODE_KEYS[mode]);
}

export function decisionKindLabel(kind: DecisionAuditKind, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, DECISION_KIND_KEYS[kind]);
}

/** `path/to/file.ts:12` — keeps the tail so the file name stays readable. */
export function truncateId(id: string, max = 24): string {
  if (id.length <= max) return id;
  return `${id.slice(0, max)}…`;
}

/** Short hash for display (e.g. first 12 hex chars); full value stays available. */
export function hashShort(hash: string, length = 12): string {
  if (hash.length <= length) return hash;
  return `${hash.slice(0, length)}…`;
}

export interface DecisionModelLine {
  requested: string;
  resolved?: string;
  /** The requested alias resolved to a different version (AT-JEV-081 drift). */
  drifted: boolean;
  /** `requested → resolved`, or just `requested` when nothing was resolved. */
  text: string;
}

/**
 * The model line. The arrow is shown only when the provider reported a resolved
 * version; `drifted` flags an alias that now resolves elsewhere so the UI can
 * tint it instead of hiding the change behind an identical-looking id.
 */
export function decisionModelLine(projection: Pick<DecisionAuditProjection, "requestedModel" | "resolvedModel">): DecisionModelLine {
  const requested = projection.requestedModel;
  const resolved = projection.resolvedModel?.trim() ? projection.resolvedModel : undefined;
  return {
    requested,
    ...(resolved ? { resolved } : {}),
    drifted: resolved !== undefined && resolved !== requested,
    text: resolved ? `${requested} → ${resolved}` : requested,
  };
}

/** Finite ratios render at 3 decimals; a missing/non-finite value renders `—`. */
export function formatRatio(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";
}

export function decisionLatencyLabel(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return "—";
  return latencyMs < 1000 ? `${Math.round(latencyMs)} ms` : `${(latencyMs / 1000).toFixed(1)} s`;
}

/**
 * AT-JEV-062 cost classification for a single evaluation. `undefined`/NaN/±Inf
 * means "unknown" — the projection omits the field whenever the price could not
 * be computed, so it must never be coerced to `$0.000`.
 */
export type DecisionCostDisplay = { kind: "unknown" } | { kind: "priced"; amount: number };

export function decisionCostDisplay(projection: Pick<DecisionAuditProjection, "estimatedCostUsd">): DecisionCostDisplay {
  const value = projection.estimatedCostUsd;
  if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "unknown" };
  return { kind: "priced", amount: value };
}

/** The COST cell text: unknown wording, or `$x.xxxx` (4 decimals). */
export function decisionCostLabel(projection: Pick<DecisionAuditProjection, "estimatedCostUsd">, locale: Locale = DEFAULT_LOCALE): string {
  const display = decisionCostDisplay(projection);
  return display.kind === "unknown" ? t(locale, "budget.costUnknown") : `$${display.amount.toFixed(4)}`;
}

/** Input/output tokens line, or `undefined` when the provider reported neither. */
export function decisionTokensLabel(projection: Pick<DecisionAuditProjection, "inputTokens" | "outputTokens">, locale: Locale = DEFAULT_LOCALE): string | undefined {
  const input = projection.inputTokens;
  const output = projection.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  return t(locale, "decisions.tokens", { input: input ?? "—", output: output ?? "—" });
}

export interface DecisionAnswerMetric {
  label: string;
  value: string;
}

export interface DecisionAnswerView {
  /** Truncated for the table cell. */
  questionId: string;
  /** Untruncated, for a `title` tooltip. */
  fullQuestionId: string;
  type: DecisionAuditAnswerType;
  typeLabel: string;
  value: string;
  /** Type-specific metrics: probability/certainty, confidence, weighted score. */
  metrics: DecisionAnswerMetric[];
}

/**
 * One answer row. Probability carries `probability` + local `certainty`;
 * choice/score carry provider `confidence` (score also the `weightedScore`).
 * The full `probabilities` distribution is intentionally not rendered — the
 * summary contract only asks for value + the distinguishing metric.
 */
export function decisionAnswerView(answer: DecisionAuditAnswer, locale: Locale = DEFAULT_LOCALE): DecisionAnswerView {
  const metrics: DecisionAnswerMetric[] = [];
  if (answer.type === "probability") {
    metrics.push({ label: t(locale, "decisions.probability"), value: formatRatio(answer.probability) });
    metrics.push({ label: t(locale, "decisions.certainty"), value: formatRatio(answer.certainty) });
  } else {
    if (answer.type === "score") metrics.push({ label: t(locale, "decisions.weightedScore"), value: formatRatio(answer.weightedScore) });
    metrics.push({ label: t(locale, "decisions.confidence"), value: formatRatio(answer.confidence) });
  }
  return {
    questionId: truncateId(answer.questionId),
    fullQuestionId: answer.questionId,
    type: answer.type,
    typeLabel: t(locale, DECISION_ANSWER_TYPE_KEYS[answer.type]),
    value: String(answer.value),
    metrics,
  };
}

/** Stable, numeric summary of `stateManifest` (never its raw content). */
export interface DecisionManifestSummary {
  questionCount?: number;
  stateTokens?: number;
  fieldCount?: number;
}

export function decisionManifestSummary(projection: Pick<DecisionAuditProjection, "stateManifest">): DecisionManifestSummary {
  const manifest = projection.stateManifest ?? {};
  const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const questionCount = asNumber(manifest.questionCount);
  const stateTokens = asNumber(manifest.stateTokens);
  const fields = manifest.fields;
  return {
    ...(questionCount !== undefined ? { questionCount } : {}),
    ...(stateTokens !== undefined ? { stateTokens } : {}),
    ...(Array.isArray(fields) ? { fieldCount: fields.length } : {}),
  };
}

/** Human summary line for the manifest counts, or `undefined` when unknown. */
export function decisionManifestLabel(summary: DecisionManifestSummary, locale: Locale = DEFAULT_LOCALE): string | undefined {
  const parts: string[] = [];
  if (summary.questionCount !== undefined) parts.push(t(locale, "decisions.manifestQuestions", { count: summary.questionCount }));
  if (summary.stateTokens !== undefined) parts.push(t(locale, "decisions.manifestTokens", { tokens: summary.stateTokens }));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface DecisionCardView {
  status: { label: string; tone: DecisionTone };
  kindLabel: string;
  modeLabel: string;
  provider: string;
  model: DecisionModelLine;
  createdAt: string;
  policyVersion: string;
  stateHash: string;
  stateHashShort: string;
  questionSchemaHash: string;
  questionSchemaHashShort: string;
  appliedOutcome?: string;
  fallbackReason?: string;
  detail?: string;
  latencyLabel: string;
  tokensLabel?: string;
  costLabel: string;
  costKind: DecisionCostDisplay["kind"];
  answers: DecisionAnswerView[];
  manifest: DecisionManifestSummary;
  manifestLabel?: string;
}

/** The full render model for one evaluation card. */
export function decisionCardView(projection: DecisionAuditProjection, locale: Locale = DEFAULT_LOCALE): DecisionCardView {
  const cost = decisionCostDisplay(projection);
  const manifest = decisionManifestSummary(projection);
  const tokensLabel = decisionTokensLabel(projection, locale);
  const manifestLabel = decisionManifestLabel(manifest, locale);
  return {
    status: decisionStatusMeta(projection.status, locale),
    kindLabel: decisionKindLabel(projection.kind, locale),
    modeLabel: decisionModeLabel(projection.mode, locale),
    provider: projection.provider,
    model: decisionModelLine(projection),
    createdAt: projection.createdAt,
    policyVersion: projection.policyVersion,
    stateHash: projection.stateHash,
    stateHashShort: hashShort(projection.stateHash),
    questionSchemaHash: projection.questionSchemaHash,
    questionSchemaHashShort: hashShort(projection.questionSchemaHash),
    ...(projection.appliedOutcome ? { appliedOutcome: projection.appliedOutcome } : {}),
    ...(projection.fallbackReason ? { fallbackReason: projection.fallbackReason } : {}),
    ...(projection.detail ? { detail: projection.detail } : {}),
    latencyLabel: decisionLatencyLabel(projection.latencyMs),
    ...(tokensLabel ? { tokensLabel } : {}),
    costLabel: decisionCostLabel(projection, locale),
    costKind: cost.kind,
    answers: projection.answers.map((answer) => decisionAnswerView(answer, locale)),
    manifest,
    ...(manifestLabel ? { manifestLabel } : {}),
  };
}

/** Whether the deployment's decision engine can explain a missing/thin audit. */
export type DecisionEngineHealth = "disabled" | "unconfigured" | "ready" | "unknown";

export interface DecisionEngineNotice {
  engine: DecisionEngineStatus["engine"] | "unknown";
  mode: DecisionEngineStatus["mode"] | "unknown";
  /** True only when the deployment reports `PI_DECISION_ENGINE=jev`. */
  enabled: boolean;
  health: DecisionEngineHealth;
  /** `决策平面：引擎 X · 模式 Y`, identical wording to the models page. */
  state: string;
  /**
   * Why there may be no decisions. The wording is the models page's, not new:
   * the disabled/unconfigured/ready cases reuse its catalog keys verbatim.
   */
  hint: string;
}

/**
 * docs/26 §11: distinguishes "the deployment has not enabled the engine" from
 * "enabled but no credential resolves" (`configured === false`) using the same
 * copy as the models & credentials page — the panel must never invent a
 * different wording for the same state.
 */
export function decisionEngineNotice(decision: DecisionEngineStatus | undefined, locale: Locale = DEFAULT_LOCALE): DecisionEngineNotice {
  const engine = decision?.engine ?? "unknown";
  const mode = decision?.mode ?? "unknown";
  const enabled = decision?.engine === "jev";
  const health: DecisionEngineHealth = !decision ? "unknown" : !enabled ? "disabled" : decision.configured ? "ready" : "unconfigured";
  const hint = health === "ready"
    ? t(locale, "models.decisionEngineEnabledHint")
    : health === "unconfigured"
      ? t(locale, "provider.credentialMissing")
      : t(locale, "models.decisionEngineDisabledHint");
  return {
    engine,
    mode,
    enabled,
    health,
    state: t(locale, "models.decisionEngineState", { engine, mode }),
    hint,
  };
}
