/**
 * Reviewer input slimming (cost/latency, incident `run_e7c565d6335a4bc7`).
 *
 * The reviewer prompt embedded the whole diff (≈60 KB observed, up to 3.4 MB by
 * design) and lockfiles/build outputs dominated both the tokens and the latency
 * (234–692 s per round). The reviewer still must be able to reason about the
 * change, so this module never silently drops anything: it applies a
 * deterministic per-file and total byte budget, excludes obvious noise, and
 * always emits a manifest describing exactly what was excluded or trimmed.
 */

export type ReviewExclusionReason = "lockfile" | "build-output" | "dependency" | "binary" | "total-budget";

export interface ReviewFileStat {
  path: string;
  added: number;
  removed: number;
  hunks: number;
  /** Bytes of the file's emitted (possibly trimmed) block. */
  bytes: number;
  included: boolean;
  excludedReason?: ReviewExclusionReason;
  trimmed: boolean;
  /** Added/removed lines omitted by the per-file cap. */
  trimmedAdded: number;
  trimmedRemoved: number;
  /** Hunks omitted by the per-file cap. */
  trimmedHunks: number;
}

export interface ReviewInputLimits {
  /** Per-file cap for a single file's diff text. */
  fileDiffBytes: number;
  /** Cap for the whole emitted diff section. */
  totalDiffBytes: number;
}

export interface ReviewInputResult {
  /** Diff text handed to the reviewer (byte-identical to the input when nothing was cut). */
  text: string;
  /** Per-file stats, in original diff order. */
  files: ReviewFileStat[];
  originalBytes: number;
  includedBytes: number;
  /** True when any file was excluded or trimmed (the input changed). */
  trimmed: boolean;
}

export const defaultFileDiffBytes = 40_000;
export const defaultTotalDiffBytes = 200_000;

function strictPositiveInt(raw: string | undefined, fallback: number): number {
  const value = String(raw ?? "").trim();
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Strict parsers for `PI_REVIEW_FILE_DIFF_BYTES` (default 40 000) and
 * `PI_REVIEW_TOTAL_DIFF_BYTES` (default 200 000). Junk/zero/negative values fall
 * back to the defaults instead of disabling the budget.
 */
export function reviewInputLimits(env: NodeJS.ProcessEnv = process.env): ReviewInputLimits {
  return {
    fileDiffBytes: strictPositiveInt(env.PI_REVIEW_FILE_DIFF_BYTES, defaultFileDiffBytes),
    totalDiffBytes: strictPositiveInt(env.PI_REVIEW_TOTAL_DIFF_BYTES, defaultTotalDiffBytes),
  };
}

interface ParsedFile {
  path: string;
  block: string;
  header: string;
  hunks: string[];
  added: number;
  removed: number;
  bytes: number;
  binary: boolean;
}

const binaryMarker = /^(Binary files |GIT binary patch$)/;

function countHunkLines(hunk: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.split("\n")) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function cleanPath(value: string): string | null {
  let path = value.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path.startsWith("b/") || path.startsWith("a/")) path = path.slice(2);
  return path === "" || path === "/dev/null" ? null : path;
}

function decodePath(line: string): string | null {
  return cleanPath(line.slice(4));
}

function extractPath(lines: string[]): string {
  const plus = lines.find((line) => line.startsWith("+++ "));
  const minus = lines.find((line) => line.startsWith("--- "));
  const fromPlus = plus ? decodePath(plus) : null;
  if (fromPlus) return fromPlus;
  const fromMinus = minus ? decodePath(minus) : null;
  if (fromMinus) return fromMinus;
  const git = lines.find((line) => line.startsWith("diff --git "));
  if (git) {
    const parts = git.slice("diff --git ".length).split(" ");
    const candidate = cleanPath(parts[parts.length - 1] ?? "");
    if (candidate) return candidate;
  }
  return "<unknown>";
}

function parseBlock(lines: string[]): ParsedFile {
  const binary = lines.some((line) => binaryMarker.test(line) || line.includes("\u0000"));
  let firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) firstHunk = lines.length;
  const header = lines.slice(0, firstHunk).join("\n");
  const groups: string[][] = [];
  for (let index = firstHunk; index < lines.length; index += 1) {
    if (lines[index].startsWith("@@")) groups.push([lines[index]]);
    else if (groups.length > 0) groups[groups.length - 1].push(lines[index]);
  }
  const hunks = groups.map((group) => group.join("\n"));
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const counts = countHunkLines(hunk);
    added += counts.added;
    removed += counts.removed;
  }
  const block = lines.join("\n");
  return { path: extractPath(lines), block, header, hunks, added, removed, bytes: byteLength(block), binary };
}

/** Splits a unified diff into leading preamble + per-file blocks. */
export function splitDiff(diff: string): { preamble: string; files: ParsedFile[] } {
  const lines = diff.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (starts.length === 0) {
    // Plain `--- a/x` / `+++ b/x` diffs (no git header).
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (lines[index].startsWith("--- ") && lines[index + 1].startsWith("+++ ")) starts.push(index);
    }
  }
  if (starts.length === 0) return { preamble: diff, files: [] };
  const preamble = starts[0] > 0 ? `${lines.slice(0, starts[0]).join("\n")}\n` : "";
  const files = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    return parseBlock(lines.slice(start, end));
  });
  return { preamble, files };
}

/** Noise that should not reach the reviewer unless the task explicitly targets it. */
export function reviewExclusionReason(path: string, binary: boolean): ReviewExclusionReason | undefined {
  if (binary) return "binary";
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (
    base === "package-lock.json" ||
    base === "npm-shrinkwrap.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base.endsWith(".lock")
  ) {
    return "lockfile";
  }
  if (lower.startsWith("dist/") || lower.startsWith("build/")) return "build-output";
  if (lower.startsWith("node_modules/") || lower.includes("/node_modules/")) return "dependency";
  return undefined;
}

interface AssembledFile {
  text: string;
  trimmed: boolean;
  trimmedAdded: number;
  trimmedRemoved: number;
  trimmedHunks: number;
}

/** First hunks that fit the per-file cap, plus an explicit omission marker. */
function assembleWithinBudget(file: ParsedFile, cap: number): AssembledFile {
  if (file.hunks.length === 0) {
    return { text: file.block, trimmed: false, trimmedAdded: 0, trimmedRemoved: 0, trimmedHunks: 0 };
  }
  let text = file.header;
  let currentBytes = byteLength(text);
  let included = 0;
  for (const hunk of file.hunks) {
    const candidate = currentBytes + 1 + byteLength(hunk);
    if (candidate > cap) break;
    text = `${text}\n${hunk}`;
    currentBytes = candidate;
    included += 1;
  }
  if (included === file.hunks.length) {
    return { text, trimmed: false, trimmedAdded: 0, trimmedRemoved: 0, trimmedHunks: 0 };
  }
  const omitted = file.hunks.slice(included);
  let trimmedAdded = 0;
  let trimmedRemoved = 0;
  for (const hunk of omitted) {
    const counts = countHunkLines(hunk);
    trimmedAdded += counts.added;
    trimmedRemoved += counts.removed;
  }
  const marker = `... [trimmed: +${trimmedAdded}/-${trimmedRemoved} lines, ${omitted.length} hunks omitted]`;
  return {
    text: `${text}\n${marker}`,
    trimmed: true,
    trimmedAdded,
    trimmedRemoved,
    trimmedHunks: omitted.length,
  };
}

function formatManifest(
  stats: ReviewFileStat[],
  originalBytes: number,
  includedBytes: number,
  limits: ReviewInputLimits,
): string {
  const included = stats.filter((stat) => stat.included).length;
  const excluded = stats.filter((stat) => !stat.included).length;
  const trimmed = stats.filter((stat) => stat.included && stat.trimmed).length;
  const lines = [
    "",
    "[PiGO review input manifest]",
    `- files: ${stats.length} (included ${included}, excluded ${excluded}, trimmed ${trimmed})`,
  ];
  for (const stat of stats) {
    const flag = stat.included
      ? stat.trimmed
        ? "included, trimmed"
        : "included"
      : `excluded: ${stat.excludedReason ?? "unknown"}`;
    const trim = stat.trimmed
      ? ` [trimmed +${stat.trimmedAdded}/-${stat.trimmedRemoved} lines, ${stat.trimmedHunks} hunks omitted]`
      : "";
    lines.push(`  - ${stat.path} (${flag}) +${stat.added}/-${stat.removed}${trim}`);
  }
  lines.push(
    `[review input trimmed] original ${originalBytes} bytes -> ${includedBytes} bytes (limits: per-file ${limits.fileDiffBytes}, total ${limits.totalDiffBytes})`,
  );
  return lines.join("\n");
}

/**
 * Applies the reviewer input budget. Deterministic: files keep their original
 * order in the output, the total-budget selection keeps the largest files first
 * (ties broken by path), and a manifest always documents exclusions/trimming.
 * When nothing needs cutting, the input is returned byte-identical.
 */
export function buildReviewDiff(diff: string, limits: ReviewInputLimits = reviewInputLimits()): ReviewInputResult {
  const originalBytes = byteLength(diff);
  const { preamble, files } = splitDiff(diff);
  const stats: ReviewFileStat[] = [];
  const included: Array<{ order: number; text: string; stat: ReviewFileStat }> = [];
  let changed = false;

  files.forEach((file, order) => {
    const reason = reviewExclusionReason(file.path, file.binary);
    const stat: ReviewFileStat = {
      path: file.path,
      added: file.added,
      removed: file.removed,
      hunks: file.hunks.length,
      bytes: file.bytes,
      included: false,
      trimmed: false,
      trimmedAdded: 0,
      trimmedRemoved: 0,
      trimmedHunks: 0,
    };
    if (reason) {
      stat.excludedReason = reason;
      changed = true;
      stats.push(stat);
      return;
    }
    const assembled = assembleWithinBudget(file, limits.fileDiffBytes);
    stat.included = true;
    stat.trimmed = assembled.trimmed;
    stat.trimmedAdded = assembled.trimmedAdded;
    stat.trimmedRemoved = assembled.trimmedRemoved;
    stat.trimmedHunks = assembled.trimmedHunks;
    stat.bytes = byteLength(assembled.text);
    if (assembled.trimmed) changed = true;
    stats.push(stat);
    included.push({ order, text: assembled.text, stat });
  });

  // Total budget: keep the largest files first (deterministic), then restore the
  // original order for output. Anything dropped is reported as `total-budget`.
  // The manifest is metadata appended to the emitted text, so reserve room for it
  // (plus slack) to keep the whole reviewer input under the total budget.
  const includedTotal = included.reduce((sum, item) => sum + item.stat.bytes, 0);
  if (includedTotal > limits.totalDiffBytes) {
    changed = true;
    const reserve = byteLength(formatManifest(stats, originalBytes, 0, limits)) + 64;
    const bodyBudget = Math.max(0, limits.totalDiffBytes - reserve);
    const bySize = [...included].sort(
      (a, b) => b.stat.bytes - a.stat.bytes || a.stat.path.localeCompare(b.stat.path),
    );
    let cumulative = 0;
    const keep = new Set<number>();
    for (const item of bySize) {
      if (cumulative + item.stat.bytes <= bodyBudget) {
        cumulative += item.stat.bytes;
        keep.add(item.order);
      }
    }
    for (const item of included) {
      if (!keep.has(item.order)) {
        item.stat.included = false;
        item.stat.excludedReason = "total-budget";
      }
    }
  }

  if (!changed) {
    return { text: diff, files: stats, originalBytes, includedBytes: originalBytes, trimmed: false };
  }

  const emitted = included
    .filter((item) => item.stat.included)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.text);
  const body = `${preamble}${emitted.join("\n")}`;
  const includedBytes = byteLength(body);
  const text = `${body}${body.endsWith("\n") || body === "" ? "" : "\n"}${formatManifest(stats, originalBytes, includedBytes, limits)}`;
  return { text, files: stats, originalBytes, includedBytes, trimmed: true };
}
