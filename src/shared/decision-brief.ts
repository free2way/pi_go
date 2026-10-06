/**
 * Decision Brief — pure decision logic (docs/22-decision-brief.md).
 *
 * When a run parks at `needs_human` the data needed to answer the operator's
 * only question — *can this delivery be accepted, or does it need more work?* —
 * is already in the database (findings, checks, diff, rounds). What was missing
 * was an aggregate view. This module is that aggregate's brain: it is pure
 * (no I/O, no model calls, deterministic) so the server can hand it
 * already-collected rows and the client can render its verdict unchanged.
 *
 * Four hard gates (any red ⇒ continue developing):
 *   1. checks      — every recorded check passed
 *   2. blocking    — no unresolved `critical`, and no AC/DoD-relevant
 *                    unresolved `high`
 *   3. scope       — the diff only touches source files (no generated/dirty
 *                    files) and stays inside the allowed paths (when given)
 *   4. acceptance  — every AC/DoD item maps to an implemented change or a test
 *
 * Conservative/fail-safe by construction: whenever the data does not let a gate
 * be decided it reports `unknown` (never a fabricated green/red); the AC matcher
 * refuses to guess — a possible-but-unproven match is `unknown`, never a false
 * "relevant"; and an unresolved `critical`/`high` is cleared only with explicit
 * out-of-scope proof (a concrete file outside a *provably complete* change set
 * that shares nothing with any criterion). Every ambiguous relevance verdict
 * therefore blocks, so a genuine high-severity defect is never silently dropped.
 *
 * Audit follow-up (truncated change set): the inline `run.diff` the server reads
 * can be a truncated copy of the run's real diff. A file that WAS changed but is
 * missing from such a partial list would look "outside the change set", so a
 * real high could be cleared. Completeness must therefore be *proven*: the
 * caller passes {@link DecisionBriefDiffProvenance}, and unless it says
 * `complete: true` the relevance/scope judgements degrade to `unknown`
 * (⇒ blocking) and never to `irrelevant`.
 */

import type { Finding } from "./types.js";
import { findingFingerprint, normalizeFindingFile } from "./finding-fingerprint.js";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n.js";

export type GateStatus = "green" | "red" | "unknown";
export type GateId = "checks" | "blocking" | "scope" | "acceptance";
export type DecisionAction = "continue" | "accept";
export type AcRelevance = "relevant" | "irrelevant" | "unknown";

/**
 * Why the change set the brief judged is (or is not) provably the run's whole
 * diff. `complete` is the only reason that permits clearing a finding as
 * "outside the change set".
 */
export type DiffSetCompleteness = "complete" | "truncated" | "partial" | "missing-metadata" | "absent";

/**
 * Provenance of the `diffFiles` list. A truncated inline diff (the pipeline
 * persists a bounded copy; the full text lives in a durable artifact) can omit
 * a file that WAS changed, so an unproven list must never be treated as the
 * complete change set.
 */
export interface DecisionBriefDiffProvenance {
  /** True only when `diffFiles` is provably the run's complete change set. */
  complete: boolean;
  /** Stable machine token; `complete === true` iff `reason === "complete"`. */
  reason: DiffSetCompleteness;
  /** Byte length of the inline diff the brief judged, when known. */
  inlineBytes?: number | null;
  /** Byte count of the full diff the pipeline recorded, when known. */
  recordedBytes?: number | null;
}

/** Operator-facing diff provenance echoed on the brief (docs/22 §6). */
export interface DecisionBriefDiffScope extends DecisionBriefDiffProvenance {
  detail: string;
  /** English rendering of `detail` (docs/24-i18n.md §9); additive. */
  detailEn?: string;
}

/**
 * Run context used *only* to rule relevance out (never to claim it). Without a
 * known — and provably complete — change set, an out-of-scope finding cannot be
 * proven out of scope, so the matcher stays conservative and reports `unknown`
 * (⇒ blocking).
 */
export interface AcRelevanceContext {
  /** The run's changed files. Absent/empty ⇒ the change set is unknown. */
  diffFiles?: string[] | null;
  /**
   * Whether `diffFiles` is provably the run's *complete* change set. Only an
   * explicit `true` permits clearing: a truncated inline diff can omit a changed
   * file and make a real finding look out of scope, so omitted/`false`/`null`
   * keeps the verdict at `unknown` (⇒ blocking).
   */
  diffComplete?: boolean | null;
}

export interface DecisionBriefFindingRef {
  id: string;
  key: string;
  severity: Finding["severity"];
  file: string | null;
  line: number | null;
  title: string;
}

export interface DecisionBriefGate {
  id: GateId;
  status: GateStatus;
  detail: string;
  /**
   * English rendering of `detail` (docs/24-i18n.md §9). Additive: `detail` keeps
   * the Chinese text byte-for-byte. Always populated by `buildDecisionBrief`;
   * optional so hand-built fixtures/older payloads stay valid.
   */
  detailEn?: string;
  /** Only the `blocking` gate carries its blocking findings (doc §6). */
  findings?: DecisionBriefFindingRef[];
}

export interface DecisionBriefStopReason {
  code: string;
  message: string;
  /**
   * English rendering of `message` when the recorded event carries one
   * (`meta.messageEn`). Absent for events written before this change and for
   * events whose text has no English variant — the client then renders
   * `message`. The stored `message` is never rewritten (audit fidelity).
   */
  messageEn?: string;
  /**
   * Locale the recorded stop event was generated in (`meta.locale`). Absent when
   * the event predates locale-aware generation, so a reader can tell which
   * language `message` is actually in.
   */
  locale?: Locale;
  meta: Record<string, unknown>;
}

export interface DecisionBriefRemainingItem {
  severity: Finding["severity"];
  key: string;
  streak: number;
  ac?: string;
  evidenceOk: boolean;
  /**
   * How (un)confidently the finding maps to the story's AC/DoD. `unknown` means
   * relevance could not be ruled out — for an unresolved critical/high that is
   * a blocking state, not a clear one. Used by the UI to distinguish
   * "blocking because clearly AC-relevant" from "blocking, relevance unproven".
   */
  relevance?: AcRelevance;
}

export interface DecisionBriefRecommendation {
  action: DecisionAction;
  note: string;
  /**
   * English rendering of `note` (docs/24-i18n.md §9). Additive: `note` stays the
   * Chinese text so existing callers are byte-identical. Always populated, so the
   * client can switch language without refetching.
   */
  noteEn?: string;
}

export interface DecisionBrief {
  /** Locale the brief was requested in (`zh` default); recorded for audit. */
  locale: Locale;
  stopReason: DecisionBriefStopReason;
  gates: DecisionBriefGate[];
  remaining: DecisionBriefRemainingItem[];
  recommendation: DecisionBriefRecommendation;
  /**
   * Why the change set behind the gates is (not) provably complete. Lets a
   * reader tell "cleared: proven outside the complete change set" from
   * "blocked: the change set may be truncated".
   */
  diff: DecisionBriefDiffScope;
}

/** One acceptance criterion / definition-of-done item, with its display label. */
export interface DecisionBriefCriterion {
  /** e.g. `AC#1` / `DoD#2`. */
  label: string;
  text: string;
}

/** Minimal finding shape accepted from `run_findings` + the run document. */
export interface DecisionBriefFindingInput {
  id?: string | null;
  stableKey?: string | null;
  severity?: string | null;
  resolved?: boolean | number | null;
  file?: string | null;
  line?: number | null;
  title?: string | null;
  evidence?: string | null;
  requiredChange?: string | null;
  consecutiveRounds?: number | null;
}

export interface DecisionBriefCheckInput {
  id?: string | null;
  name?: string | null;
  command?: string | null;
  status?: string | null;
  exitCode?: number | null;
}

export interface DecisionBriefEventInput {
  type?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface DecisionBriefInput {
  criteria?: DecisionBriefCriterion[] | null;
  findings?: DecisionBriefFindingInput[] | null;
  checks?: DecisionBriefCheckInput[] | null;
  diffFiles?: string[] | null;
  /**
   * Provenance of `diffFiles`. When omitted (or `complete !== true`) the change
   * set is not proven complete and the brief refuses to clear a finding as
   * "outside the change set" (fail-safe, audit follow-up).
   */
  diff?: DecisionBriefDiffProvenance | null;
  allowedPaths?: string[] | null;
  events?: DecisionBriefEventInput[] | null;
  /**
   * Locale the brief was requested in (docs/24-i18n.md §9). Additive and
   * optional: omitted/invalid reads as `zh`, so existing callers keep the exact
   * same output. It is recorded on the brief (and echoed from the stop event)
   * but never changes which text is generated — the brief always carries both
   * the Chinese field and its English `*En` counterpart.
   */
  locale?: Locale | null;
}

const SEVERITIES: ReadonlyArray<Finding["severity"]> = ["critical", "high", "medium", "low"];
const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Finding severities that always block a delivery when unresolved. */
export const blockingSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high"];

/** Files the scope gate always rejects in a diff (generated / dirty artefacts). */
const GENERATED_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.state(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)test-results(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/i,
  /(^|\/)(cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock)$/i,
  /\.tsbuildinfo$/i,
];

const VAGUE_EVIDENCE = /^(n\/?a|none|null|tbd|todo|unknown|待补充|待定|未知|无|没有|-{1,}|—|\?+|\.+)$/i;

/** ASCII→ASCII equivalents for Chinese/English punctuation, plus full-width space. */
const PUNCTUATION_EQUIVALENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[，、]/g, ","],
  [/。/g, "."],
  [/；/g, ";"],
  [/：/g, ":"],
  [/！/g, "!"],
  [/？/g, "?"],
  [/（/g, "("],
  [/）/g, ")"],
  [/【/g, "["],
  [/】/g, "]"],
  [/[「」『』“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/[—–]/g, "-"],
  [/…/g, "..."],
  [/·/g, " "],
  [/\u3000/g, " "],
];

/** Case/whitespace/punctuation-normalized text used by every matcher. */
export function normalizeBriefText(value: string | null | undefined): string {
  let text = String(value ?? "").toLowerCase();
  for (const [pattern, replacement] of PUNCTUATION_EQUIVALENTS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Meaningful tokens: path-like strings, ASCII words (≥3 chars) and CJK bigrams.
 * CJK has no word delimiters, so overlapping bigrams are the conservative unit
 * (two shared bigrams are required before a match is called "relevant").
 */
export function briefTokens(value: string | null | undefined): string[] {
  const text = normalizeBriefText(value);
  if (!text) return [];
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9_.@-]+(?:\/[a-z0-9_.@*-]+)+/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

function asCriterion(criterion: DecisionBriefCriterion | string): DecisionBriefCriterion {
  return typeof criterion === "string" ? { label: "", text: criterion } : criterion;
}

function findingMaterial(finding: DecisionBriefFindingInput): { text: string; file: string | null } {
  const file = typeof finding.file === "string" && finding.file.trim() && finding.file.trim() !== "<no-file>"
    ? finding.file
    : null;
  const text = [finding.file, finding.title, finding.requiredChange, finding.evidence]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ");
  return { text, file };
}

/** True when the finding's file is part of the run's change set (file or dir level). */
function isInChangedFiles(normalizedFile: string, changedFiles: ReadonlySet<string>): boolean {
  if (!normalizedFile || changedFiles.size === 0) return false;
  if (changedFiles.has(normalizedFile)) return true;
  for (const changed of changedFiles) {
    if (normalizedFile.startsWith(`${changed}/`) || changed.startsWith(`${normalizedFile}/`)) return true;
  }
  return false;
}

/**
 * True when a single criterion and the finding share a strong, non-accidental
 * signal. The context is used *only* to rule relevance out: strong signals are
 * all derived from the finding's own material vs. the criterion text, so making
 * the change set known can never turn a `relevant`/`unknown` into `irrelevant`
 * beyond the explicit out-of-scope proof below.
 */
function singleRelevance(
  finding: DecisionBriefFindingInput,
  criterion: DecisionBriefCriterion,
  changedFiles: ReadonlySet<string>,
  diffKnown: boolean,
  diffComplete: boolean,
): AcRelevance {
  const criterionText = normalizeBriefText(criterion.text);
  const { text: findingText, file } = findingMaterial(finding);
  if (!criterionText) return "unknown";
  if (!findingText) return "unknown";

  if (file) {
    const normalizedFile = normalizeFindingFile(file);
    if (normalizedFile !== "<no-file>" && criterionText.includes(normalizedFile)) return "relevant";
    const base = normalizedFile.split("/").pop() ?? "";
    // A distinctive file basename quoted in the criterion is a strong signal.
    if (base.length >= 5 && criterionText.includes(base)) return "relevant";
  }

  const criterionTokens = new Set(briefTokens(criterion.text));
  const findingTokens = new Set(briefTokens(findingText));
  const shared = [...criterionTokens].filter((token) => findingTokens.has(token));
  if (shared.some((token) => token.includes("/"))) return "relevant";
  const sharedCjk = shared.filter((token) => /^[\u4e00-\u9fff]{2}$/.test(token));
  if (sharedCjk.length >= 2) return "relevant";
  const sharedWords = shared.filter((token) => /^[a-z0-9]/.test(token));
  if (sharedWords.some((token) => token.length >= 6)) return "relevant";
  if (sharedWords.length >= 2) return "relevant";

  // No strong or partial lexical overlap. Default to `unknown` (⇒ blocking):
  // only clear a finding when the evidence that it is out of scope is strong
  // and explicit — a concrete file that is demonstrably *not* part of this
  // run's change set, a known *and provably complete* change set, and not a
  // single shared token with the criterion. Anything else (missing file,
  // unknown diff, incompletely known diff, weak overlap) stays `unknown`, so a
  // real high-severity defect is never silently cleared.
  const hasMaterial = Boolean(file) || (typeof finding.title === "string" && finding.title.trim().length >= 4);
  if (!hasMaterial) return "unknown";
  if (shared.length > 0) return "unknown";
  const concreteFile = file ? normalizeFindingFile(file) : "";
  if (!concreteFile || concreteFile === "<no-file>") return "unknown";
  if (!diffKnown) return "unknown";
  // Audit follow-up: a partial (truncated) change set can omit the file this
  // finding actually lives in, which would fake an out-of-scope proof. Only a
  // proven-complete change set may clear.
  if (!diffComplete) return "unknown";
  if (isInChangedFiles(concreteFile, changedFiles)) return "unknown";
  return "irrelevant";
}

function toCriteria(criteria: DecisionBriefCriterion[] | string[] | null | undefined): DecisionBriefCriterion[] {
  return (criteria ?? []).map(asCriterion).filter((criterion) => criterion.text.trim() !== "");
}

/** Shared empty change set used where relevance can only be `relevant`/`unknown`. */
const EMPTY_CHANGED_FILES: ReadonlySet<string> = new Set<string>();

/**
 * Conservatively classifies one finding against the story's AC/DoD:
 * - `relevant`   only on a strong signal (shared file path, distinctive
 *                keyword, or ≥2 shared meaningful tokens);
 * - `irrelevant` only with explicit out-of-scope proof: a concrete file outside
 *                a *known and provably complete* change set that shares nothing
 *                at all with the criterion (and, transitively, with every
 *                criterion);
 * - `unknown`    everything in between, including empty criteria, a finding
 *                without a file, an unknown/empty/truncated change set, or
 *                partial overlap — and `unknown` blocks an unresolved
 *                critical/high.
 */
export function acRelevance(
  finding: DecisionBriefFindingInput,
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
  context?: AcRelevanceContext | null,
): AcRelevance {
  const list = toCriteria(criteria);
  if (list.length === 0) return "unknown";
  const changedFiles = new Set(
    (context?.diffFiles ?? []).map(normalizeDiffPath).filter(Boolean),
  );
  const diffKnown = changedFiles.size > 0;
  const diffComplete = context?.diffComplete === true;
  let sawUnknown = false;
  for (const criterion of list) {
    const verdict = singleRelevance(finding, criterion, changedFiles, diffKnown, diffComplete);
    if (verdict === "relevant") return "relevant";
    if (verdict === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "irrelevant";
}

/** The first criterion a finding is clearly relevant to, if any. */
export function matchCriterion(
  finding: DecisionBriefFindingInput,
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
): DecisionBriefCriterion | undefined {
  for (const criterion of toCriteria(criteria)) {
    // Change-set context can only downgrade `irrelevant` → `unknown`, never
    // create a `relevant`, so it is not needed to find a strong match.
    if (singleRelevance(finding, criterion, EMPTY_CHANGED_FILES, false, false) === "relevant") return criterion;
  }
  return undefined;
}

/**
 * Evidence-sanity heuristic: does the finding cite plausible, non-empty
 * evidence? A `false` result flags a possible false positive (vague evidence /
 * no file / non-positive line) — it is never treated as a gate failure.
 */
export function evidenceSanity(finding: DecisionBriefFindingInput): boolean {
  const evidence = String(finding.evidence ?? "").trim();
  if (!evidence || evidence.length < 8 || VAGUE_EVIDENCE.test(evidence)) return false;
  const file = String(finding.file ?? "").trim();
  if (file && file !== "<no-file>" && !/^[\w.@-]+(?:[/\\][\w.@-]+)*(?:\.\w+)?$/.test(file)) return false;
  if (typeof finding.line === "number" && Number.isFinite(finding.line) && finding.line <= 0) return false;
  return true;
}

/**
 * Code-generated Decision Brief copy (docs/24-i18n.md §9).
 *
 * Every judgement string the brief renders is built from this table, so both
 * languages come from one place and can be audited side by side. The `zh` column
 * is byte-identical to the pre-i18n output: `gateChecks(checks)` with no locale
 * therefore returns exactly what it always did. `en` is rendered into the
 * additive `detailEn` / `noteEn` / `diff.detailEn` fields.
 */
interface BriefCopy {
  listSep: string;
  pathSep: string;
  checksNone: string;
  checksFailed: (count: number, labels: string) => string;
  checkItem: (name: string, command: string | undefined, exit: string) => string;
  checkNameFallback: string;
  checkExit: (exitCode: number) => string;
  checksPending: string;
  checksGreen: (count: number) => string;
  blockingPrefix: (summary: string) => string;
  blockingCritical: (count: number) => string;
  blockingHighs: (count: number, relevant: number, unresolved: number) => string;
  blockingIncomplete: string;
  blockingUnknownSeverity: (count: number) => string;
  blockingGreenIgnoredHighs: (count: number) => string;
  blockingGreen: string;
  scopeMissing: string;
  scopeEmpty: string;
  scopeGenerated: (files: string) => string;
  scopeOutside: (files: string) => string;
  scopeIncomplete: (count: number) => string;
  scopeGreen: (count: number) => string;
  acceptanceNoCriteriaNoDiff: string;
  acceptanceNoCriteria: string;
  acceptanceNoDiff: string;
  acceptanceNoChanges: (count: number) => string;
  acceptanceMissing: (count: number, labels: string) => string;
  acceptanceUnmapped: (count: number, labels: string) => string;
  acceptanceGreen: (count: number) => string;
  recoAcceptWithRemaining: (recorded: string) => string;
  recoAcceptPlain: string;
  recoMedium: (count: number) => string;
  recoLow: (count: number) => string;
  recoFalsePositives: (count: number) => string;
  recoPersisting: (rounds: number) => string;
  recoFixChecks: (detail: string) => string;
  recoPrimaryStreak: (key: string, streak: number) => string;
  recoPerRed: (key: string, extras: string) => string;
  recoPerRedExtras: (count: number) => string;
  recoRedGates: (labels: string) => string;
  recoUnknown: (labels: string) => string;
  recoUnknownNone: string;
  diffComplete: string;
  diffTruncated: string;
  diffPartial: string;
  diffMissingMetadata: string;
  diffAbsent: string;
}

const BRIEF_COPY_ZH: BriefCopy = {
  listSep: "；",
  pathSep: "、",
  checksNone: "没有检查记录，无法确认检查是否通过",
  checksFailed: (count, labels) => `${count} 项检查未通过：${labels}`,
  checkItem: (name, command, exit) => (command ? `${name}（${command}${exit}）` : `${name}${exit}`),
  checkNameFallback: "检查",
  checkExit: (exitCode) => `，exit ${exitCode}`,
  checksPending: "存在未结束的检查，无法确认检查结果",
  checksGreen: (count) => `${count} 项检查全部通过`,
  blockingPrefix: (summary) => `仍有阻断级问题未解决：${summary}`,
  blockingCritical: (count) => `${count} 个未解决 critical`,
  blockingHighs: (count, relevant, unresolved) =>
    `${count} 个未解决 high（${relevant} 个明确与 AC/DoD 相关，${unresolved} 个相关性无法排除）`,
  blockingIncomplete:
    "；改动清单不完整（inline diff 可能被截断），已按“相关性无法排除”处理，不得据此清除阻断项",
  blockingUnknownSeverity: (count) => `${count} 条未解决问题的严重级别无法识别，无法排除阻断项`,
  blockingGreenIgnoredHighs: (count) =>
    `无未解决 critical；${count} 个 high 有明确证据表明与本故事 AC/DoD 无关（文件不在完整改动范围内且无共享关键词）`,
  blockingGreen: "无未解决的 critical/high 问题",
  scopeMissing: "缺少 diff 文件清单，无法核对改动范围",
  scopeEmpty: "diff 文件清单为空，无法核对改动范围",
  scopeGenerated: (files) => `diff 含生成物/脏文件：${files}`,
  scopeOutside: (files) => `diff 超出允许路径：${files}`,
  scopeIncomplete: (count) =>
    `${count} 个已列出的改动文件均为源文件，但改动清单不完整（可能被截断），无法排除未列出的生成物/越界文件`,
  scopeGreen: (count) => `${count} 个改动文件均为源文件，未发现生成物/脏文件`,
  acceptanceNoCriteriaNoDiff: "无 AC/DoD 且缺少 diff，无法核对验收覆盖",
  acceptanceNoCriteria: "故事未定义 AC/DoD，无额外覆盖要求",
  acceptanceNoDiff: "缺少 diff 数据，无法核对验收覆盖",
  acceptanceNoChanges: (count) => `未发现任何代码变更，${count} 条 AC/DoD 无从核对`,
  acceptanceMissing: (count, labels) => `${count} 条 AC/DoD 指向的文件没有任何变更：${labels}`,
  acceptanceUnmapped: (count, labels) => `${count} 条 AC/DoD 无法自动对应到变更或测试，需人工核对：${labels}`,
  acceptanceGreen: (count) => `${count} 条 AC/DoD 均能对应到变更或测试`,
  recoAcceptWithRemaining: (recorded) => `四条硬门槛全绿，可接受交付。将记录的剩余项：${recorded}。`,
  recoAcceptPlain: "四条硬门槛全绿，无剩余问题，可接受交付。",
  recoMedium: (count) => `medium ${count} 条`,
  recoLow: (count) => `low ${count} 条`,
  recoFalsePositives: (count) => `疑似误报 ${count} 条`,
  recoPersisting: (rounds) =>
    `同一批阻断问题连续 ${rounds} 轮未减少，方向可能不对：建议人工明确修法，或接受并记为技术债。`,
  recoFixChecks: (detail) => `${detail}；请先修复检查再继续开发。`,
  recoPrimaryStreak: (key, streak) =>
    `优先修复 \`${key}\`（已返修 ${streak} 次未解决）；本次只改该点，不要改动其它文件。`,
  recoPerRed: (key, extras) => `按红项逐条修复：\`${key}\`${extras}；不要改动其它文件。`,
  recoPerRedExtras: (count) => (count > 1 ? ` 等 ${count} 项` : ""),
  recoRedGates: (labels) => `存在未通过的门槛（${labels}），建议继续开发。`,
  recoUnknown: (labels) => `数据不足（${labels}），无法确认可交付；建议继续开发或人工核对。`,
  recoUnknownNone: "无法确认可交付，建议继续开发。",
  diffComplete: "改动清单已证明完整（inline diff 与流水线记录的完整 diff 字节数一致）",
  diffTruncated: "inline diff 被流水线截断，改动清单可能不完整，无法据此排除相关性或越界文件",
  diffPartial: "inline diff 短于流水线记录的完整 diff 字节数，改动清单可能不完整",
  diffMissingMetadata: "缺少可核对的完整 diff 元数据，无法证明改动清单完整",
  diffAbsent: "没有 inline diff，无法确认改动范围",
};

const BRIEF_COPY_EN: BriefCopy = {
  listSep: "; ",
  pathSep: ", ",
  checksNone: "No check records; cannot confirm whether the checks passed",
  checksFailed: (count, labels) => `${count} check(s) failed: ${labels}`,
  checkItem: (name, command, exit) => (command ? `${name} (${command}${exit})` : `${name}${exit}`),
  checkNameFallback: "check",
  checkExit: (exitCode) => `, exit ${exitCode}`,
  checksPending: "Some checks have not finished; the result cannot be confirmed",
  checksGreen: (count) => `All ${count} check(s) passed`,
  blockingPrefix: (summary) => `Blocking findings remain unresolved: ${summary}`,
  blockingCritical: (count) => `${count} unresolved critical`,
  blockingHighs: (count, relevant, unresolved) =>
    `${count} unresolved high (${relevant} clearly relevant to AC/DoD, ${unresolved} with relevance that cannot be ruled out)`,
  blockingIncomplete:
    '; the change set is incomplete (the inline diff may be truncated), so these were treated as "relevance cannot be ruled out" and must not be used to clear blockers',
  blockingUnknownSeverity: (count) =>
    `${count} unresolved finding(s) have an unrecognized severity; blockers cannot be ruled out`,
  blockingGreenIgnoredHighs: (count) =>
    `No unresolved critical; ${count} high finding(s) are proven unrelated to this story's AC/DoD (file outside the complete change set and no shared keywords)`,
  blockingGreen: "No unresolved critical/high findings",
  scopeMissing: "No diff file list; the change scope cannot be verified",
  scopeEmpty: "The diff file list is empty; the change scope cannot be verified",
  scopeGenerated: (files) => `The diff contains generated/dirty files: ${files}`,
  scopeOutside: (files) => `The diff goes outside the allowed paths: ${files}`,
  scopeIncomplete: (count) =>
    `${count} listed changed file(s) are source files, but the change set is incomplete (it may be truncated); unlisted generated/out-of-scope files cannot be ruled out`,
  scopeGreen: (count) => `All ${count} changed file(s) are source files; no generated/dirty files found`,
  acceptanceNoCriteriaNoDiff: "No AC/DoD and no diff; acceptance coverage cannot be verified",
  acceptanceNoCriteria: "The story defines no AC/DoD; no extra coverage is required",
  acceptanceNoDiff: "No diff data; acceptance coverage cannot be verified",
  acceptanceNoChanges: (count) => `No code changes found; ${count} AC/DoD item(s) cannot be verified`,
  acceptanceMissing: (count, labels) => `${count} AC/DoD item(s) point at files that no change touches: ${labels}`,
  acceptanceUnmapped: (count, labels) =>
    `${count} AC/DoD item(s) cannot be mapped automatically to a change or a test; manual verification is required: ${labels}`,
  acceptanceGreen: (count) => `All ${count} AC/DoD item(s) map to a change or a test`,
  recoAcceptWithRemaining: (recorded) =>
    `All four hard gates are green; the delivery can be accepted. Recorded remaining items: ${recorded}.`,
  recoAcceptPlain: "All four hard gates are green; nothing remains; the delivery can be accepted.",
  recoMedium: (count) => `${count} medium`,
  recoLow: (count) => `${count} low`,
  recoFalsePositives: (count) => `${count} suspected false positive(s)`,
  recoPersisting: (rounds) =>
    `The same blocking batch has not decreased for ${rounds} consecutive rounds; the direction may be wrong — a human should state the exact fix, or accept and record it as technical debt.`,
  recoFixChecks: (detail) => `${detail}; fix the checks before continuing development.`,
  recoPrimaryStreak: (key, streak) =>
    `Fix \`${key}\` first (unresolved for ${streak} rounds); change only that item and do not touch other files.`,
  recoPerRed: (key, extras) => `Fix the red items one by one: \`${key}\`${extras}; do not touch other files.`,
  recoPerRedExtras: (count) => (count > 1 ? ` and ${count - 1} other item(s)` : ""),
  recoRedGates: (labels) => `Some gates are not passing (${labels}); continue development.`,
  recoUnknown: (labels) =>
    `Insufficient data (${labels}); the delivery cannot be confirmed as acceptable — continue development or verify manually.`,
  recoUnknownNone: "The delivery cannot be confirmed as acceptable; continue development.",
  diffComplete: "The change set is proven complete (the inline diff matches the pipeline's recorded full diff byte count)",
  diffTruncated:
    "The pipeline truncated the inline diff, so the change set may be incomplete; relevance or out-of-scope files cannot be ruled out from it",
  diffPartial: "The inline diff is shorter than the pipeline's recorded full diff byte count, so the change set may be incomplete",
  diffMissingMetadata: "The full-diff metadata needed to verify completeness is missing; the change set cannot be proven complete",
  diffAbsent: "No inline diff; the change scope cannot be confirmed",
};

/** `zh` unless the caller passes a supported locale. */
function asLocale(locale: Locale | null | undefined): Locale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/** `green` only when every recorded check passed; `unknown` with no check data. */
export function gateChecks(checks: DecisionBriefCheckInput[] | null | undefined): DecisionBriefGate {
  const list = checks ?? [];
  if (list.length === 0) {
    return { id: "checks", status: "unknown", detail: BRIEF_COPY_ZH.checksNone, detailEn: BRIEF_COPY_EN.checksNone };
  }
  const failed = list.filter((check) => String(check.status ?? "").toLowerCase() === "failed");
  if (failed.length > 0) {
    return {
      id: "checks",
      status: "red",
      detail: BRIEF_COPY_ZH.checksFailed(failed.length, failedCheckLabels(failed, BRIEF_COPY_ZH)),
      detailEn: BRIEF_COPY_EN.checksFailed(failed.length, failedCheckLabels(failed, BRIEF_COPY_EN)),
    };
  }
  const settled = list.every((check) => String(check.status ?? "").toLowerCase() === "passed");
  if (!settled) {
    return { id: "checks", status: "unknown", detail: BRIEF_COPY_ZH.checksPending, detailEn: BRIEF_COPY_EN.checksPending };
  }
  return {
    id: "checks",
    status: "green",
    detail: BRIEF_COPY_ZH.checksGreen(list.length),
    detailEn: BRIEF_COPY_EN.checksGreen(list.length),
  };
}

/** Renders the failed-check list in one language (`；` vs `; `, `（）` vs `()`). */
function failedCheckLabels(failed: DecisionBriefCheckInput[], copy: BriefCopy): string {
  return failed
    .map((check) => {
      const name = check.name?.trim() || check.id?.trim() || copy.checkNameFallback;
      const command = check.command?.trim();
      const exit = typeof check.exitCode === "number" ? copy.checkExit(check.exitCode) : "";
      return copy.checkItem(name, command, exit);
    })
    .join(copy.listSep);
}

function normalizeSeverity(value: unknown): Finding["severity"] | undefined {
  const severity = String(value ?? "").toLowerCase();
  return (SEVERITIES as ReadonlyArray<string>).includes(severity) ? (severity as Finding["severity"]) : undefined;
}

function toRef(finding: DecisionBriefFindingInput): DecisionBriefFindingRef {
  const severity = normalizeSeverity(finding.severity) ?? "low";
  return {
    id: String(finding.id ?? "").trim() || stableKeyOf(finding),
    key: stableKeyOf(finding),
    severity,
    file: typeof finding.file === "string" && finding.file.trim() ? finding.file : null,
    line: typeof finding.line === "number" && Number.isFinite(finding.line) ? finding.line : null,
    title: String(finding.title ?? "").trim(),
  };
}

function stableKeyOf(finding: DecisionBriefFindingInput): string {
  const key = String(finding.stableKey ?? "").trim();
  if (key) return key;
  return findingFingerprint({ file: finding.file ?? null, title: finding.title ?? null });
}

function isResolved(finding: DecisionBriefFindingInput): boolean {
  return finding.resolved === true || finding.resolved === 1;
}

/**
 * `green` when no unresolved `critical` and no AC/DoD-relevant unresolved
 * `high`. Fail-safe: an unresolved high is treated as blocking unless the
 * matcher holds explicit out-of-scope proof (a concrete file outside a *known
 * and provably complete* change set sharing nothing with any criterion).
 * `diffComplete` must be an explicit `true` to permit that clearing; omitted or
 * `false` keeps every would-be-cleared high blocking (`unknown`), because a
 * truncated change set can hide the file a real finding lives in. `unknown`
 * therefore blocks, and a genuine high whose wording merely shares no keywords
 * with the AC text is never silently cleared.
 */
export function gateBlocking(
  findings: DecisionBriefFindingInput[] | null | undefined,
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
  diffFiles?: string[] | null,
  diffComplete?: boolean | null,
): DecisionBriefGate {
  const complete = diffComplete === true;
  const open = (findings ?? []).filter((finding) => !isResolved(finding));
  const critical = open.filter((finding) => normalizeSeverity(finding.severity) === "critical");
  const highs = open.filter((finding) => normalizeSeverity(finding.severity) === "high");
  const relevanceOf = new Map<DecisionBriefFindingInput, AcRelevance>();
  for (const finding of highs) relevanceOf.set(finding, acRelevance(finding, criteria, { diffFiles, diffComplete: complete }));
  const blockingHighs = highs.filter((finding) => relevanceOf.get(finding) !== "irrelevant");
  const relevantHighs = blockingHighs.filter((finding) => relevanceOf.get(finding) === "relevant").length;
  const unresolvedHighs = blockingHighs.length - relevantHighs;
  const indeterminate = open.filter((finding) => normalizeSeverity(finding.severity) === undefined);
  const blocking = [...critical, ...blockingHighs];

  if (blocking.length > 0) {
    return {
      id: "blocking",
      status: "red",
      detail: blockingDetail(BRIEF_COPY_ZH, critical.length, blockingHighs.length, relevantHighs, unresolvedHighs, complete),
      detailEn: blockingDetail(BRIEF_COPY_EN, critical.length, blockingHighs.length, relevantHighs, unresolvedHighs, complete),
      findings: blocking.map(toRef),
    };
  }
  if (indeterminate.length > 0) {
    return {
      id: "blocking",
      status: "unknown",
      detail: BRIEF_COPY_ZH.blockingUnknownSeverity(indeterminate.length),
      detailEn: BRIEF_COPY_EN.blockingUnknownSeverity(indeterminate.length),
      findings: indeterminate.map(toRef),
    };
  }
  const ignoredHighs = highs.length;
  return {
    id: "blocking",
    status: "green",
    detail: ignoredHighs > 0 ? BRIEF_COPY_ZH.blockingGreenIgnoredHighs(ignoredHighs) : BRIEF_COPY_ZH.blockingGreen,
    detailEn: ignoredHighs > 0 ? BRIEF_COPY_EN.blockingGreenIgnoredHighs(ignoredHighs) : BRIEF_COPY_EN.blockingGreen,
    findings: [],
  };
}

/**
 * Renders the `blocking` gate's red detail in one language. Audit follow-up: the
 * incomplete-change-set note says *why* an out-of-scope-looking high was not
 * cleared, so a reader can tell this from a missing/unmapped-AC block.
 */
function blockingDetail(
  copy: BriefCopy,
  criticalCount: number,
  highCount: number,
  relevantHighs: number,
  unresolvedHighs: number,
  complete: boolean,
): string {
  const summary = [
    criticalCount ? copy.blockingCritical(criticalCount) : "",
    highCount ? copy.blockingHighs(highCount, relevantHighs, unresolvedHighs) : "",
  ].filter(Boolean).join(copy.listSep);
  const incompleteNote = !complete && unresolvedHighs > 0 ? copy.blockingIncomplete : "";
  return `${copy.blockingPrefix(summary)}${incompleteNote}`;
}

/** Normalizes a diff path for scope/comparison. */
function normalizeDiffPath(value: string): string {
  let path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function isInsideAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((root) => {
    const normalizedRoot = normalizeDiffPath(root).replace(/\/+$/, "");
    if (!normalizedRoot) return false;
    return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
  });
}

/**
 * `red` when the diff contains a generated/dirty file or a file outside the
 * allowed paths; `green` when the file list is clean (and, when allowed paths
 * are supplied, entirely inside them); `unknown` when there is no file list to
 * check against *or* the list is not provably complete (`diffComplete !== true`)
 * — a truncated inline diff can hide a generated/out-of-scope file. A concrete
 * offending file found in a partial list still yields `red` (that evidence is
 * sound regardless of completeness).
 */
export function gateScope(
  diffFiles: string[] | null | undefined,
  allowedPaths?: string[] | null,
  diffComplete?: boolean | null,
): DecisionBriefGate {
  if (diffFiles === null || diffFiles === undefined) {
    return { id: "scope", status: "unknown", detail: BRIEF_COPY_ZH.scopeMissing, detailEn: BRIEF_COPY_EN.scopeMissing };
  }
  const files = [...new Set(diffFiles.map(normalizeDiffPath).filter(Boolean))];
  if (files.length === 0) {
    return { id: "scope", status: "unknown", detail: BRIEF_COPY_ZH.scopeEmpty, detailEn: BRIEF_COPY_EN.scopeEmpty };
  }
  const generated = files.filter(isGeneratedFile);
  if (generated.length > 0) {
    return {
      id: "scope",
      status: "red",
      detail: BRIEF_COPY_ZH.scopeGenerated(pathList(generated, BRIEF_COPY_ZH)),
      detailEn: BRIEF_COPY_EN.scopeGenerated(pathList(generated, BRIEF_COPY_EN)),
    };
  }
  const allowed = (allowedPaths ?? []).map(normalizeDiffPath).filter(Boolean);
  if (allowed.length > 0) {
    const outside = files.filter((file) => !isInsideAllowed(file, allowed));
    if (outside.length > 0) {
      return {
        id: "scope",
        status: "red",
        detail: BRIEF_COPY_ZH.scopeOutside(pathList(outside, BRIEF_COPY_ZH)),
        detailEn: BRIEF_COPY_EN.scopeOutside(pathList(outside, BRIEF_COPY_EN)),
      };
    }
  }
  if (diffComplete !== true) {
    return {
      id: "scope",
      status: "unknown",
      detail: BRIEF_COPY_ZH.scopeIncomplete(files.length),
      detailEn: BRIEF_COPY_EN.scopeIncomplete(files.length),
    };
  }
  return {
    id: "scope",
    status: "green",
    detail: BRIEF_COPY_ZH.scopeGreen(files.length),
    detailEn: BRIEF_COPY_EN.scopeGreen(files.length),
  };
}

/** First six offending paths in one language (`、` vs `, `), with an ellipsis. */
function pathList(files: string[], copy: BriefCopy): string {
  return `${files.slice(0, 6).join(copy.pathSep)}${files.length > 6 ? " …" : ""}`;
}

/** File-path-looking tokens named directly in a criterion's text. */
function criterionPaths(criterion: DecisionBriefCriterion): string[] {
  const text = normalizeBriefText(criterion.text);
  const paths = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9_.@-]+(?:\/[a-z0-9_.@*-]+)+/g)) paths.add(match[0]);
  return [...paths];
}

/** Whether a single AC/DoD item maps to a diff file or a check. */
function criterionCovered(
  criterion: DecisionBriefCriterion,
  diffFiles: string[],
  checks: DecisionBriefCheckInput[],
): boolean {
  for (const file of diffFiles) {
    if (singleRelevance({ file, title: file, evidence: file }, criterion, EMPTY_CHANGED_FILES, false, false) === "relevant") return true;
  }
  for (const check of checks) {
    const text = [check.name, check.command].filter((value): value is string => Boolean(value && value.trim())).join(" ");
    if (!text) continue;
    if (singleRelevance({ file: null, title: text, requiredChange: text, evidence: text }, criterion, EMPTY_CHANGED_FILES, false, false) === "relevant") return true;
  }
  return false;
}

/**
 * `green` when every AC/DoD item maps to an implemented change (diff file) or a
 * test/check; `red` when a criterion names a file that no change touches, or the
 * diff implements nothing at all; `unknown` when a criterion cannot be mapped
 * lexically (needs a human) or there is nothing to verify against. A story with
 * no AC/DoD is vacuously covered.
 *
 * Deliberately not gated on change-set completeness: coverage needs *positive*
 * evidence, so a partial list can only under-count coverage (a false red /
 * unknown, which blocks) and never fabricate a green.
 */
export function gateAcceptance(
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
  diffFiles: string[] | null | undefined,
  checks?: DecisionBriefCheckInput[] | null,
): DecisionBriefGate {
  const list = toCriteria(criteria);
  if (list.length === 0) {
    if (diffFiles === null || diffFiles === undefined) {
      return {
        id: "acceptance",
        status: "unknown",
        detail: BRIEF_COPY_ZH.acceptanceNoCriteriaNoDiff,
        detailEn: BRIEF_COPY_EN.acceptanceNoCriteriaNoDiff,
      };
    }
    return {
      id: "acceptance",
      status: "green",
      detail: BRIEF_COPY_ZH.acceptanceNoCriteria,
      detailEn: BRIEF_COPY_EN.acceptanceNoCriteria,
    };
  }
  if (diffFiles === null || diffFiles === undefined) {
    return {
      id: "acceptance",
      status: "unknown",
      detail: BRIEF_COPY_ZH.acceptanceNoDiff,
      detailEn: BRIEF_COPY_EN.acceptanceNoDiff,
    };
  }
  const files = [...new Set(diffFiles.map(normalizeDiffPath).filter(Boolean))];
  const checkList = checks ?? [];
  if (files.length === 0) {
    return {
      id: "acceptance",
      status: "red",
      detail: BRIEF_COPY_ZH.acceptanceNoChanges(list.length),
      detailEn: BRIEF_COPY_EN.acceptanceNoChanges(list.length),
    };
  }
  const missing: DecisionBriefCriterion[] = [];
  const unmapped: DecisionBriefCriterion[] = [];
  for (const criterion of list) {
    if (criterionCovered(criterion, files, checkList)) continue;
    // A criterion that names a file no change touches is a definite miss.
    if (criterionPaths(criterion).length > 0) missing.push(criterion);
    else unmapped.push(criterion);
  }
  if (missing.length > 0) {
    return {
      id: "acceptance",
      status: "red",
      detail: BRIEF_COPY_ZH.acceptanceMissing(missing.length, criterionLabels(missing, BRIEF_COPY_ZH)),
      detailEn: BRIEF_COPY_EN.acceptanceMissing(missing.length, criterionLabels(missing, BRIEF_COPY_EN)),
    };
  }
  if (unmapped.length > 0) {
    return {
      id: "acceptance",
      status: "unknown",
      detail: BRIEF_COPY_ZH.acceptanceUnmapped(unmapped.length, criterionLabels(unmapped, BRIEF_COPY_ZH)),
      detailEn: BRIEF_COPY_EN.acceptanceUnmapped(unmapped.length, criterionLabels(unmapped, BRIEF_COPY_EN)),
    };
  }
  return {
    id: "acceptance",
    status: "green",
    detail: BRIEF_COPY_ZH.acceptanceGreen(list.length),
    detailEn: BRIEF_COPY_EN.acceptanceGreen(list.length),
  };
}

/** `AC#1、DoD#2` in one language. */
function criterionLabels(items: DecisionBriefCriterion[], copy: BriefCopy): string {
  return items.map((item) => item.label || item.text).join(copy.pathSep);
}

/** Event type → stop code, preserving the existing guard/needs_human vocabulary. */
const STOP_REASON_CODES: Readonly<Record<string, string>> = {
  "run.needs_human": "max_review_rounds",
  "review.not_converging": "review_not_converging",
  "review.severe_finding_repeated": "severe_finding_repeated",
  "run.completion_blocked": "completion_guard",
  "checks.blocked_retry_review": "checks_failed",
  "run.deadline_exceeded": "deadline_exceeded",
  "run.budget_exhausted": "budget_exhausted",
  "review.provider_error": "review_provider_error",
  "review.invalid_protocol": "review_invalid_protocol",
  "review.snapshot_failed": "review_snapshot_failed",
  "review.snapshot_diverged": "review_snapshot_diverged",
  "review.changes_requested": "review_changes_requested",
  "run.cancel_requested": "cancelled",
  "run.cancelled": "cancelled",
};

/** Meta keys too large to echo back in the brief (findings/diff are separate). */
const HEAVY_META_KEYS = new Set(["findings", "diff", "checks", "plan"]);

function slimMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (HEAVY_META_KEYS.has(key)) continue;
    slim[key] = value;
  }
  return slim;
}

/**
 * Maps the run's terminal/guard event to a stable stop code. The latest
 * recognized stop event wins; no recognized event ⇒ `unknown` (never a crash).
 */
export function stopReasonFrom(events: DecisionBriefEventInput[] | null | undefined): DecisionBriefStopReason {
  const list = events ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    const type = String(event?.type ?? "").trim();
    if (!type) continue;
    let code = STOP_REASON_CODES[type];
    if (!code && type.startsWith("guard.")) code = "guard";
    if (!code) continue;
    const meta = slimMeta(event?.meta);
    // Locale-aware events record the language they were written in and the
    // English variant (`messageEn`) so a reader can render either; both are
    // additive and absent on events written before docs/24-i18n.md §9.
    return {
      code,
      message: String(event?.message ?? "").trim(),
      ...(typeof meta.messageEn === "string" && meta.messageEn.trim() ? { messageEn: meta.messageEn } : {}),
      ...(isLocale(meta.locale) ? { locale: meta.locale } : {}),
      meta,
    };
  }
  return { code: "unknown", message: "", meta: {} };
}

function fingerprintLabel(item: DecisionBriefRemainingItem): string {
  return item.key;
}

/**
 * Streak → recommended action (doc §5). Accept only when all four gates are
 * green; otherwise continue, with a one-item draft note that names the
 * `file|title` fingerprint and the "不要改动其它文件" boundary. Persisting
 * blocking findings (streak ≥ 3) additionally warn that the direction is
 * probably wrong (streak ≥ 2 is the "fix this one first" case).
 */
export function recommendDecision(
  gates: DecisionBriefGate[],
  remaining: DecisionBriefRemainingItem[],
): DecisionBriefRecommendation {
  const allGreen = gates.length > 0 && gates.every((gate) => gate.status === "green");
  return {
    action: allGreen ? "accept" : "continue",
    note: recommendNote(BRIEF_COPY_ZH, gates, remaining, false),
    // English variant of the same note (docs/24-i18n.md §9). The red `checks`
    // gate detail embedded here reads the gate's own English text when present.
    noteEn: recommendNote(BRIEF_COPY_EN, gates, remaining, true),
  };
}

function recommendNote(
  copy: BriefCopy,
  gates: DecisionBriefGate[],
  remaining: DecisionBriefRemainingItem[],
  english: boolean,
): string {
  const red = gates.filter((gate) => gate.status === "red");
  const unknown = gates.filter((gate) => gate.status === "unknown");
  const allGreen = gates.length > 0 && gates.every((gate) => gate.status === "green");

  const blocking = remaining.filter((item) => blockingSeverities.includes(item.severity));
  const pool = blocking.length > 0 ? blocking : remaining;

  if (allGreen) {
    const medium = remaining.filter((item) => item.severity === "medium").length;
    const low = remaining.filter((item) => item.severity === "low").length;
    const falsePositives = remaining.filter((item) => !item.evidenceOk).length;
    const recorded = [
      medium ? copy.recoMedium(medium) : "",
      low ? copy.recoLow(low) : "",
      falsePositives ? copy.recoFalsePositives(falsePositives) : "",
    ].filter(Boolean);
    return recorded.length > 0
      ? copy.recoAcceptWithRemaining(recorded.join(copy.pathSep))
      : copy.recoAcceptPlain;
  }

  const parts: string[] = [];
  const persisting = pool.filter((item) => item.streak >= 3);
  if (persisting.length > 0) {
    const rounds = Math.max(...persisting.map((item) => item.streak));
    parts.push(copy.recoPersisting(rounds));
  }

  const checksGate = red.find((gate) => gate.id === "checks");
  if (checksGate) parts.push(copy.recoFixChecks(english ? checksGate.detailEn ?? checksGate.detail : checksGate.detail));

  const primary = [...pool].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.streak - a.streak || a.key.localeCompare(b.key),
  )[0];
  if (primary && primary.streak >= 2) {
    parts.push(copy.recoPrimaryStreak(fingerprintLabel(primary), primary.streak));
  } else if (primary && red.some((gate) => gate.id === "blocking")) {
    parts.push(copy.recoPerRed(fingerprintLabel(primary), copy.recoPerRedExtras(pool.length)));
  } else if (!checksGate && red.length > 0) {
    parts.push(copy.recoRedGates(red.map((gate) => gate.id).join(copy.pathSep)));
  }

  if (parts.length === 0) {
    const unknownLabels = unknown.map((gate) => gate.id).join(copy.pathSep);
    parts.push(unknownLabels ? copy.recoUnknown(unknownLabels) : copy.recoUnknownNone);
  }
  return parts.join(" ");
}

function remainingItemOf(
  finding: DecisionBriefFindingInput,
  criteria: DecisionBriefCriterion[],
  diffFiles: string[] | null | undefined,
  diffComplete: boolean,
): DecisionBriefRemainingItem {
  const relevance = acRelevance(finding, criteria, { diffFiles, diffComplete });
  const item: DecisionBriefRemainingItem = {
    severity: normalizeSeverity(finding.severity) ?? "low",
    key: stableKeyOf(finding),
    streak: typeof finding.consecutiveRounds === "number" && Number.isFinite(finding.consecutiveRounds)
      ? Math.max(0, Math.floor(finding.consecutiveRounds))
      : 0,
    evidenceOk: evidenceSanity(finding),
    relevance,
  };
  const criterion = matchCriterion(finding, criteria);
  if (criterion?.label) item.ac = criterion.label;
  return item;
}

/**
 * Operator-facing explanation of why the change set is (not) provably complete.
 * Kept in one place so the scope gate, the blocking gate and the API all tell
 * the same story.
 */
export function diffScopeDetail(reason: DiffSetCompleteness): string {
  return diffScopeDetailIn(BRIEF_COPY_ZH, reason);
}

/** English rendering of {@link diffScopeDetail} (docs/24-i18n.md §9). */
function diffScopeDetailIn(copy: BriefCopy, reason: DiffSetCompleteness): string {
  switch (reason) {
    case "complete":
      return copy.diffComplete;
    case "truncated":
      return copy.diffTruncated;
    case "partial":
      return copy.diffPartial;
    case "missing-metadata":
      return copy.diffMissingMetadata;
    default:
      return copy.diffAbsent;
  }
}

/**
 * Normalizes the caller-supplied provenance. Fail-safe: anything other than an
 * explicit `complete: true` yields `complete: false`, so an omitted/partial
 * change set can never be used to clear a finding.
 */
function normalizeDiffProvenance(input: DecisionBriefInput): DecisionBriefDiffScope {
  const raw = input.diff ?? null;
  const inlineBytes = raw?.inlineBytes ?? null;
  const recordedBytes = raw?.recordedBytes ?? null;
  if (raw?.complete === true) {
    return {
      complete: true,
      reason: "complete",
      inlineBytes,
      recordedBytes,
      detail: diffScopeDetailIn(BRIEF_COPY_ZH, "complete"),
      detailEn: diffScopeDetailIn(BRIEF_COPY_EN, "complete"),
    };
  }
  const hasFiles = (input.diffFiles ?? []).some((file) => typeof file === "string" && file.trim() !== "");
  const reason: DiffSetCompleteness = raw?.reason && raw.reason !== "complete"
    ? raw.reason
    : hasFiles
      ? "missing-metadata"
      : "absent";
  return {
    complete: false,
    reason,
    inlineBytes,
    recordedBytes,
    detail: diffScopeDetailIn(BRIEF_COPY_ZH, reason),
    detailEn: diffScopeDetailIn(BRIEF_COPY_EN, reason),
  };
}

/**
 * Aggregates a run's already-collected rows into the Decision Brief (doc §6).
 * Deterministic and total: every malformed/missing field degrades to `unknown`
 * or a default instead of throwing. The change set is only trusted as complete
 * when `input.diff.complete === true` (audit follow-up), so a truncated diff
 * can never clear a blocking finding.
 */
export function buildDecisionBrief(input: DecisionBriefInput): DecisionBrief {
  const criteria = toCriteria(input.criteria);
  const findings = input.findings ?? [];
  const checks = input.checks ?? [];
  const diff = normalizeDiffProvenance(input);
  const diffComplete = diff.complete;
  const blockingGate: DecisionBriefGate = input.findings === null || input.findings === undefined
    ? {
        id: "blocking",
        status: "unknown",
        detail: "缺少审核问题数据，无法确认是否存在阻断项",
        detailEn: "No review finding data; cannot confirm whether blockers exist",
        findings: [],
      }
    : gateBlocking(findings, criteria, input.diffFiles, diffComplete);
  const gates: DecisionBriefGate[] = [
    gateChecks(checks),
    blockingGate,
    gateScope(input.diffFiles, input.allowedPaths, diffComplete),
    gateAcceptance(criteria, input.diffFiles, checks),
  ];

  const remaining = findings
    .filter((finding) => !isResolved(finding))
    .map((finding) => remainingItemOf(finding, criteria, input.diffFiles, diffComplete))
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.streak - a.streak || a.key.localeCompare(b.key),
    );

  return {
    locale: asLocale(input.locale),
    stopReason: stopReasonFrom(input.events),
    gates,
    remaining,
    recommendation: recommendDecision(gates, remaining),
    diff,
  };
}

/**
 * Extracts the changed file list from a unified `git diff`. Reads `diff --git`,
 * `---`/`+++`, and rename/copy headers; `/dev/null` is dropped and the `a/`/`b/`
 * prefixes are stripped.
 */
export function diffFilePaths(diffText: string | null | undefined): string[] {
  const files = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    let value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "/dev/null") return;
    value = value.replace(/^[ab]\//, "");
    if (value) files.add(value);
  };
  for (const line of String(diffText ?? "").split("\n")) {
    const gitHeader = /^diff --git (.+) (.+)$/.exec(line);
    if (gitHeader) {
      add(gitHeader[1]);
      add(gitHeader[2]);
      continue;
    }
    const plus = /^\+\+\+ (.+)$/.exec(line);
    if (plus) {
      add(plus[1]);
      continue;
    }
    const minus = /^--- (.+)$/.exec(line);
    if (minus) {
      add(minus[1]);
      continue;
    }
    const rename = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (rename) add(rename[1]);
  }
  return [...files].sort();
}
