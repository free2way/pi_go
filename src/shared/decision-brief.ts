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
 * out-of-scope proof (a concrete file outside a known change set that shares
 * nothing with any criterion). Every ambiguous relevance verdict therefore
 * blocks, so a genuine high-severity defect is never silently dropped.
 */

import type { Finding } from "./types.js";
import { findingFingerprint, normalizeFindingFile } from "./finding-fingerprint.js";

export type GateStatus = "green" | "red" | "unknown";
export type GateId = "checks" | "blocking" | "scope" | "acceptance";
export type DecisionAction = "continue" | "accept";
export type AcRelevance = "relevant" | "irrelevant" | "unknown";

/**
 * Run context used *only* to rule relevance out (never to claim it). Without a
 * known change set an out-of-scope finding cannot be proven out of scope, so the
 * matcher stays conservative and reports `unknown` (⇒ blocking).
 */
export interface AcRelevanceContext {
  /** The run's changed files. Absent/empty ⇒ the change set is unknown. */
  diffFiles?: string[] | null;
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
  /** Only the `blocking` gate carries its blocking findings (doc §6). */
  findings?: DecisionBriefFindingRef[];
}

export interface DecisionBriefStopReason {
  code: string;
  message: string;
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
}

export interface DecisionBrief {
  stopReason: DecisionBriefStopReason;
  gates: DecisionBriefGate[];
  remaining: DecisionBriefRemainingItem[];
  recommendation: DecisionBriefRecommendation;
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
  allowedPaths?: string[] | null;
  events?: DecisionBriefEventInput[] | null;
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
  // run's change set, a known change set, and not a single shared token with
  // the criterion. Anything else (missing file, unknown diff, weak overlap)
  // stays `unknown`, so a real high-severity defect is never silently cleared.
  const hasMaterial = Boolean(file) || (typeof finding.title === "string" && finding.title.trim().length >= 4);
  if (!hasMaterial) return "unknown";
  if (shared.length > 0) return "unknown";
  const concreteFile = file ? normalizeFindingFile(file) : "";
  if (!concreteFile || concreteFile === "<no-file>") return "unknown";
  if (!diffKnown) return "unknown";
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
 *                a *known* change set that shares nothing at all with the
 *                criterion (and, transitively, with every criterion);
 * - `unknown`    everything in between, including empty criteria, a finding
 *                without a file, an unknown/empty change set, or partial
 *                overlap — and `unknown` blocks an unresolved critical/high.
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
  let sawUnknown = false;
  for (const criterion of list) {
    const verdict = singleRelevance(finding, criterion, changedFiles, diffKnown);
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
    if (singleRelevance(finding, criterion, EMPTY_CHANGED_FILES, false) === "relevant") return criterion;
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

/** `green` only when every recorded check passed; `unknown` with no check data. */
export function gateChecks(checks: DecisionBriefCheckInput[] | null | undefined): DecisionBriefGate {
  const list = checks ?? [];
  if (list.length === 0) {
    return { id: "checks", status: "unknown", detail: "没有检查记录，无法确认检查是否通过" };
  }
  const failed = list.filter((check) => String(check.status ?? "").toLowerCase() === "failed");
  if (failed.length > 0) {
    const labels = failed
      .map((check) => {
        const name = check.name?.trim() || check.id?.trim() || "检查";
        const command = check.command?.trim();
        const exit = typeof check.exitCode === "number" ? `，exit ${check.exitCode}` : "";
        return command ? `${name}（${command}${exit}）` : `${name}${exit}`;
      })
      .join("；");
    return { id: "checks", status: "red", detail: `${failed.length} 项检查未通过：${labels}` };
  }
  const settled = list.every((check) => String(check.status ?? "").toLowerCase() === "passed");
  if (!settled) {
    return { id: "checks", status: "unknown", detail: "存在未结束的检查，无法确认检查结果" };
  }
  return { id: "checks", status: "green", detail: `${list.length} 项检查全部通过` };
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
 * matcher holds explicit out-of-scope proof (a concrete file outside a known
 * change set sharing nothing with any criterion). `unknown` therefore blocks,
 * and a genuine high whose wording merely shares no keywords with the AC text
 * is never silently cleared.
 */
export function gateBlocking(
  findings: DecisionBriefFindingInput[] | null | undefined,
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
  diffFiles?: string[] | null,
): DecisionBriefGate {
  const open = (findings ?? []).filter((finding) => !isResolved(finding));
  const critical = open.filter((finding) => normalizeSeverity(finding.severity) === "critical");
  const highs = open.filter((finding) => normalizeSeverity(finding.severity) === "high");
  const relevanceOf = new Map<DecisionBriefFindingInput, AcRelevance>();
  for (const finding of highs) relevanceOf.set(finding, acRelevance(finding, criteria, { diffFiles }));
  const blockingHighs = highs.filter((finding) => relevanceOf.get(finding) !== "irrelevant");
  const relevantHighs = blockingHighs.filter((finding) => relevanceOf.get(finding) === "relevant").length;
  const unresolvedHighs = blockingHighs.length - relevantHighs;
  const indeterminate = open.filter((finding) => normalizeSeverity(finding.severity) === undefined);
  const blocking = [...critical, ...blockingHighs];

  if (blocking.length > 0) {
    const summary = [
      critical.length ? `${critical.length} 个未解决 critical` : "",
      blockingHighs.length
        ? `${blockingHighs.length} 个未解决 high（${relevantHighs} 个明确与 AC/DoD 相关，${unresolvedHighs} 个相关性无法排除）`
        : "",
    ].filter(Boolean).join("；");
    return {
      id: "blocking",
      status: "red",
      detail: `仍有阻断级问题未解决：${summary}`,
      findings: blocking.map(toRef),
    };
  }
  if (indeterminate.length > 0) {
    return {
      id: "blocking",
      status: "unknown",
      detail: `${indeterminate.length} 条未解决问题的严重级别无法识别，无法排除阻断项`,
      findings: indeterminate.map(toRef),
    };
  }
  const ignoredHighs = highs.length;
  return {
    id: "blocking",
    status: "green",
    detail: ignoredHighs > 0
      ? `无未解决 critical；${ignoredHighs} 个 high 有明确证据表明与本故事 AC/DoD 无关（文件不在改动范围内且无共享关键词）`
      : "无未解决的 critical/high 问题",
    findings: [],
  };
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
 * check against.
 */
export function gateScope(
  diffFiles: string[] | null | undefined,
  allowedPaths?: string[] | null,
): DecisionBriefGate {
  if (diffFiles === null || diffFiles === undefined) {
    return { id: "scope", status: "unknown", detail: "缺少 diff 文件清单，无法核对改动范围" };
  }
  const files = [...new Set(diffFiles.map(normalizeDiffPath).filter(Boolean))];
  if (files.length === 0) {
    return { id: "scope", status: "unknown", detail: "diff 文件清单为空，无法核对改动范围" };
  }
  const generated = files.filter(isGeneratedFile);
  if (generated.length > 0) {
    return {
      id: "scope",
      status: "red",
      detail: `diff 含生成物/脏文件：${generated.slice(0, 6).join("、")}${generated.length > 6 ? " …" : ""}`,
    };
  }
  const allowed = (allowedPaths ?? []).map(normalizeDiffPath).filter(Boolean);
  if (allowed.length > 0) {
    const outside = files.filter((file) => !isInsideAllowed(file, allowed));
    if (outside.length > 0) {
      return {
        id: "scope",
        status: "red",
        detail: `diff 超出允许路径：${outside.slice(0, 6).join("、")}${outside.length > 6 ? " …" : ""}`,
      };
    }
  }
  return { id: "scope", status: "green", detail: `${files.length} 个改动文件均为源文件，未发现生成物/脏文件` };
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
    if (singleRelevance({ file, title: file, evidence: file }, criterion, EMPTY_CHANGED_FILES, false) === "relevant") return true;
  }
  for (const check of checks) {
    const text = [check.name, check.command].filter((value): value is string => Boolean(value && value.trim())).join(" ");
    if (!text) continue;
    if (singleRelevance({ file: null, title: text, requiredChange: text, evidence: text }, criterion, EMPTY_CHANGED_FILES, false) === "relevant") return true;
  }
  return false;
}

/**
 * `green` when every AC/DoD item maps to an implemented change (diff file) or a
 * test/check; `red` when a criterion names a file that no change touches, or the
 * diff implements nothing at all; `unknown` when a criterion cannot be mapped
 * lexically (needs a human) or there is nothing to verify against. A story with
 * no AC/DoD is vacuously covered.
 */
export function gateAcceptance(
  criteria: DecisionBriefCriterion[] | string[] | null | undefined,
  diffFiles: string[] | null | undefined,
  checks?: DecisionBriefCheckInput[] | null,
): DecisionBriefGate {
  const list = toCriteria(criteria);
  if (list.length === 0) {
    if (diffFiles === null || diffFiles === undefined) {
      return { id: "acceptance", status: "unknown", detail: "无 AC/DoD 且缺少 diff，无法核对验收覆盖" };
    }
    return { id: "acceptance", status: "green", detail: "故事未定义 AC/DoD，无额外覆盖要求" };
  }
  if (diffFiles === null || diffFiles === undefined) {
    return { id: "acceptance", status: "unknown", detail: "缺少 diff 数据，无法核对验收覆盖" };
  }
  const files = [...new Set(diffFiles.map(normalizeDiffPath).filter(Boolean))];
  const checkList = checks ?? [];
  if (files.length === 0) {
    return { id: "acceptance", status: "red", detail: `未发现任何代码变更，${list.length} 条 AC/DoD 无从核对` };
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
      detail: `${missing.length} 条 AC/DoD 指向的文件没有任何变更：${missing.map((item) => item.label || item.text).join("、")}`,
    };
  }
  if (unmapped.length > 0) {
    return {
      id: "acceptance",
      status: "unknown",
      detail: `${unmapped.length} 条 AC/DoD 无法自动对应到变更或测试，需人工核对：${unmapped.map((item) => item.label || item.text).join("、")}`,
    };
  }
  return { id: "acceptance", status: "green", detail: `${list.length} 条 AC/DoD 均能对应到变更或测试` };
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
    return {
      code,
      message: String(event?.message ?? "").trim(),
      meta: slimMeta(event?.meta),
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
      medium ? `medium ${medium} 条` : "",
      low ? `low ${low} 条` : "",
      falsePositives ? `疑似误报 ${falsePositives} 条` : "",
    ].filter(Boolean);
    return {
      action: "accept",
      note: recorded.length > 0
        ? `四条硬门槛全绿，可接受交付。将记录的剩余项：${recorded.join("、")}。`
        : "四条硬门槛全绿，无剩余问题，可接受交付。",
    };
  }

  const parts: string[] = [];
  const persisting = pool.filter((item) => item.streak >= 3);
  if (persisting.length > 0) {
    const rounds = Math.max(...persisting.map((item) => item.streak));
    parts.push(`同一批阻断问题连续 ${rounds} 轮未减少，方向可能不对：建议人工明确修法，或接受并记为技术债。`);
  }

  const checksGate = red.find((gate) => gate.id === "checks");
  if (checksGate) parts.push(`${checksGate.detail}；请先修复检查再继续开发。`);

  const primary = [...pool].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.streak - a.streak || a.key.localeCompare(b.key),
  )[0];
  if (primary && primary.streak >= 2) {
    parts.push(`优先修复 \`${fingerprintLabel(primary)}\`（已返修 ${primary.streak} 次未解决）；本次只改该点，不要改动其它文件。`);
  } else if (primary && red.some((gate) => gate.id === "blocking")) {
    const extras = pool.length > 1 ? ` 等 ${pool.length} 项` : "";
    parts.push(`按红项逐条修复：\`${fingerprintLabel(primary)}\`${extras}；不要改动其它文件。`);
  } else if (!checksGate && red.length > 0) {
    parts.push(`存在未通过的门槛（${red.map((gate) => gate.id).join("、")}），建议继续开发。`);
  }

  if (parts.length === 0) {
    const unknownLabels = unknown.map((gate) => gate.id).join("、");
    parts.push(unknownLabels
      ? `数据不足（${unknownLabels}），无法确认可交付；建议继续开发或人工核对。`
      : "无法确认可交付，建议继续开发。");
  }
  return { action: "continue", note: parts.join(" ") };
}

function remainingItemOf(
  finding: DecisionBriefFindingInput,
  criteria: DecisionBriefCriterion[],
  diffFiles?: string[] | null,
): DecisionBriefRemainingItem {
  const relevance = acRelevance(finding, criteria, { diffFiles });
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
 * Aggregates a run's already-collected rows into the Decision Brief (doc §6).
 * Deterministic and total: every malformed/missing field degrades to `unknown`
 * or a default instead of throwing.
 */
export function buildDecisionBrief(input: DecisionBriefInput): DecisionBrief {
  const criteria = toCriteria(input.criteria);
  const findings = input.findings ?? [];
  const checks = input.checks ?? [];
  const blockingGate: DecisionBriefGate = input.findings === null || input.findings === undefined
    ? { id: "blocking", status: "unknown", detail: "缺少审核问题数据，无法确认是否存在阻断项", findings: [] }
    : gateBlocking(findings, criteria, input.diffFiles);
  const gates: DecisionBriefGate[] = [
    gateChecks(checks),
    blockingGate,
    gateScope(input.diffFiles, input.allowedPaths),
    gateAcceptance(criteria, input.diffFiles, checks),
  ];

  const remaining = findings
    .filter((finding) => !isResolved(finding))
    .map((finding) => remainingItemOf(finding, criteria, input.diffFiles))
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.streak - a.streak || a.key.localeCompare(b.key),
    );

  return {
    stopReason: stopReasonFrom(input.events),
    gates,
    remaining,
    recommendation: recommendDecision(gates, remaining),
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
