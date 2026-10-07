#!/usr/bin/env node
/**
 * `npm run report:at-coverage` — citation-level traceability for the Jev
 * acceptance cases in `docs/27-jev-decision-engine-acceptance.md`.
 *
 * What this IS: it answers "does any test file mention this AT id?" by scanning
 * the acceptance doc for `AT-JEV-xxx` headings and grepping the test suites
 * (`src/**\/*.test.ts(x)`, `tests/e2e/**`, `tests/live/**`,
 * `scripts/*.test.mjs`) for references.
 *
 * What this is NOT: a coverage proof. An AT id appearing in a test title means
 * *someone claimed a test maps to it*, not that the behaviour in §7 is actually
 * asserted. Treat a `cited` row as "has a pointer", and an `uncited` row as
 * "nobody even claimed coverage" — the honest signal this report is for.
 *
 * Exit code: 0 by default (a report must not block CI). `--strict` exits 1 when
 * any case is uncited, for an opt-in release gate. `--json` prints a
 * machine-readable report.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The acceptance doc whose §7/§12 headings define the case set. */
export const ACCEPTANCE_DOC = "docs/27-jev-decision-engine-acceptance.md";

/** Matches a case heading: `#### AT-JEV-001 · Default off` (also `###` for §12). */
export const CASE_HEADING = /^#{3,4}\s+(AT-JEV-\d{3})\s*·\s*(.+?)\s*$/;

/** Any AT id reference inside a test file. */
export const AT_ID = /AT-JEV-\d{3}/g;

const SRC_DIRS = ["src"];
const TEST_DIRS = ["tests/e2e", "tests/live", "tests/perf"];
const SCRIPT_DIR = "scripts";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "test-results"]);

/** Parse the acceptance doc into an ordered list of `{ id, title }`. */
export function parseAcceptanceCases(markdown) {
  const cases = [];
  const seen = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = CASE_HEADING.exec(line);
    if (!match) continue;
    const [, id, title] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    cases.push({ id, title });
  }
  return cases;
}

function walk(root, predicate, out) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, predicate, out);
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
}

/**
 * Resolve the test files to scan, relative to the repo root. `src/**` is limited
 * to vitest test files; the `tests/**` suites and `scripts/*.test.mjs` are
 * taken whole.
 */
export function listCitationFiles(root) {
  const files = [];
  for (const dir of SRC_DIRS) {
    walk(path.join(root, dir), (file) => /\.test\.tsx?$/.test(file), files);
  }
  for (const dir of TEST_DIRS) {
    walk(path.join(root, dir), () => true, files);
  }
  walk(path.join(root, SCRIPT_DIR), (file) => /\.test\.mjs$/.test(file), files);
  return files.map((file) => path.relative(root, file)).sort();
}

/**
 * Classify every doc case as cited/uncited and surface ids cited by tests but
 * absent from the doc (defensive: normally zero).
 *
 * @param {{ markdown: string, files: Record<string, string> }} input
 */
export function collectAtCoverage({ markdown, files }) {
  const cases = parseAcceptanceCases(markdown);
  const docIds = new Set(cases.map((entry) => entry.id));
  const citations = new Map();
  const unknown = new Map();

  for (const [file, content] of Object.entries(files)) {
    const matches = content.match(AT_ID);
    if (!matches) continue;
    for (const id of new Set(matches)) {
      const bucket = docIds.has(id) ? citations : unknown;
      if (!bucket.has(id)) bucket.set(id, []);
      bucket.get(id).push(file);
    }
  }

  const cited = [];
  const uncited = [];
  for (const entry of cases) {
    const found = citations.get(entry.id);
    if (found) cited.push({ ...entry, files: [...new Set(found)].sort() });
    else uncited.push(entry);
  }

  return {
    cases,
    cited,
    uncited,
    unknown: [...unknown.entries()].map(([id, found]) => ({ id, files: [...new Set(found)].sort() })),
  };
}

/** Human-readable report body (one line per statement, `[at-coverage]` prefixed). */
export function renderAtCoverage(report, { strict = false } = {}) {
  const lines = [];
  const total = report.cases.length;
  lines.push(`[at-coverage] Jev acceptance traceability — ${ACCEPTANCE_DOC}`);
  lines.push(
    "[at-coverage] NOTE: citation-level check only. An AT id in a test title means a",
  );
  lines.push(
    "[at-coverage]       test claims that mapping; it does NOT prove the behaviour.",
  );

  lines.push(`[at-coverage] cited (${report.cited.length}):`);
  for (const entry of report.cited) {
    lines.push(`  ${entry.id}  ${entry.title}`);
    for (const file of entry.files) lines.push(`      - ${file}`);
  }

  lines.push(`[at-coverage] uncited (${report.uncited.length}):`);
  for (const entry of report.uncited) {
    lines.push(`  ${entry.id}  ${entry.title}`);
  }

  lines.push(`[at-coverage] cited ids missing from the doc (${report.unknown.length}):`);
  for (const entry of report.unknown) {
    lines.push(`  ${entry.id}  <- ${entry.files.join(", ")}`);
  }

  lines.push(
    `[at-coverage] ${total} cases: ${report.cited.length} cited, ${report.uncited.length} uncited (review-level check; citation ≠ proof)`,
  );
  if (strict && report.uncited.length > 0) {
    lines.push(`[at-coverage] --strict: ${report.uncited.length} uncited case(s) — exiting 1.`);
  }
  return lines;
}

/** Read the doc and every test file under `root`. */
export function readRepoInputs(root) {
  const markdown = readFileSync(path.join(root, ACCEPTANCE_DOC), "utf8");
  const files = {};
  for (const relative of listCitationFiles(root)) {
    files[relative] = readFileSync(path.join(root, relative), "utf8");
  }
  return { markdown, files };
}

/**
 * CLI body. Returns `{ exitCode, report, lines }`; prints unless `quiet`.
 * `input` (doc markdown + file map) can be injected for tests.
 */
export function runAtCoverageReport(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const log = options.log ?? ((line) => console.log(line));
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const root = options.cwd ?? path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { markdown, files } = options.input ?? readRepoInputs(root);
  const report = collectAtCoverage({ markdown, files });

  if (json) {
    const payload = {
      doc: ACCEPTANCE_DOC,
      total: report.cases.length,
      cited: report.cited,
      uncited: report.uncited,
      unknown: report.unknown,
    };
    const lines = [JSON.stringify(payload, null, 2)];
    for (const line of lines) log(line);
    return { exitCode: strict && report.uncited.length > 0 ? 1 : 0, report, lines };
  }

  const lines = renderAtCoverage(report, { strict });
  for (const line of lines) log(line);
  return { exitCode: strict && report.uncited.length > 0 ? 1 : 0, report, lines };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`at-coverage — Jev acceptance case citation report

Usage:
  npm run report:at-coverage             # print the cited/uncited table (exit 0)
  npm run report:at-coverage -- --strict # exit 1 when any case is uncited
  npm run report:at-coverage -- --json   # machine-readable report

This is a reference-level check: an AT id being mentioned by a test does not
prove the behaviour behind it is verified.`);
    process.exit(0);
  }
  const { exitCode } = runAtCoverageReport({ argv });
  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
