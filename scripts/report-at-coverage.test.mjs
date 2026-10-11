/**
 * Unit tests for the Jev acceptance citation report (`report:at-coverage`).
 *
 * Run with `node --test` (`npm run test:scripts`). The CLI body is guarded, so
 * importing the module only exposes the pure helpers and `runAtCoverageReport`
 * with an injectable doc/file set.
 *
 * Every AT id in this file is assembled at runtime (`at("001")`), so this test
 * can never be mistaken for a citation of that case by `report:at-coverage`
 * itself — the scanner only sees the literal source text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectAtCoverage,
  parseAcceptanceCases,
  readRepoInputs,
  renderAtCoverage,
  runAtCoverageReport,
} from "./report-at-coverage.mjs";

/** Build an AT id without emitting a literal the scanner would match. */
const at = (digits) => `AT-JEV-${digits}`;

const MARKDOWN = [
  `#### ${at("001")} · 默认关闭`,
  `#### ${at("002")} · 显式 off`,
  `### ${at("090")} · 配置回滚`,
  "## 14. 需求追踪矩阵",
  "| 设计要求 | 覆盖 |",
  "| --- | --- |",
  `| 默认关闭 | ${at("001")}～005、090～093 |`,
].join("\n");

const FILES = {
  "src/server/x.test.ts": `it("[${at("001")}] does the thing", () => {});`,
  "scripts/y.test.mjs": `// ${at("090")} rollback\n`,
  "tests/e2e/z.spec.ts": `// cites a case that is not in the doc: ${at("999")}\n`,
};

test("parseAcceptanceCases reads ###/#### headings and ignores prose ranges", () => {
  const cases = parseAcceptanceCases(MARKDOWN);
  assert.deepEqual(
    cases.map((entry) => entry.id),
    [at("001"), at("002"), at("090")],
  );
  assert.equal(cases[0].title, "默认关闭");
  assert.equal(cases[2].title, "配置回滚");
});

test("readRepoInputs loads the configured acceptance document and citation files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pigo-at-coverage-"));
  try {
    mkdirSync(path.join(root, "docs"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "docs", "27-jev-decision-engine-acceptance.md"), MARKDOWN);
    writeFileSync(path.join(root, "src", "feature.test.ts"), FILES["src/server/x.test.ts"]);

    const input = readRepoInputs(root);
    assert.equal(input.markdown, MARKDOWN);
    assert.equal(input.files["src/feature.test.ts"], FILES["src/server/x.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectAtCoverage classifies cited / uncited / unknown", () => {
  const report = collectAtCoverage({ markdown: MARKDOWN, files: FILES });
  assert.deepEqual(
    report.cited.map((entry) => entry.id),
    [at("001"), at("090")],
  );
  assert.deepEqual(report.cited[0].files, ["src/server/x.test.ts"]);
  assert.deepEqual(
    report.uncited.map((entry) => entry.id),
    [at("002")],
  );
  assert.deepEqual(report.unknown, [{ id: at("999"), files: ["tests/e2e/z.spec.ts"] }]);
});

test("renderAtCoverage prints the three states and the honest summary line", () => {
  const report = collectAtCoverage({ markdown: MARKDOWN, files: FILES });
  const text = renderAtCoverage(report).join("\n");
  assert.ok(text.includes("citation-level check only"));
  assert.ok(text.includes("cited (2):"));
  assert.ok(text.includes("uncited (1):"));
  assert.ok(text.includes("cited ids missing from the doc (1):"));
  assert.ok(text.includes("[at-coverage] 3 cases: 2 cited, 1 uncited (review-level check; citation ≠ proof)"));
});

test("runAtCoverageReport exits 0 by default and 1 with --strict when uncited remain", () => {
  const log = () => {};
  const lenient = runAtCoverageReport({ argv: [], input: { markdown: MARKDOWN, files: FILES }, log });
  assert.equal(lenient.exitCode, 0);

  const strict = runAtCoverageReport({ argv: ["--strict"], input: { markdown: MARKDOWN, files: FILES }, log });
  assert.equal(strict.exitCode, 1);
  assert.ok(strict.lines.join("\n").includes("--strict: 1 uncited case(s) — exiting 1."));
});

test("runAtCoverageReport with --strict still exits 0 when everything is cited", () => {
  const files = {
    ...FILES,
    "src/server/y.test.ts": `it("[${at("002")}] off", () => {});`,
  };
  const result = runAtCoverageReport({ argv: ["--strict"], input: { markdown: MARKDOWN, files }, log: () => {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.uncited.length, 0);
});

test("runAtCoverageReport --json emits a machine-readable payload", () => {
  const lines = [];
  const result = runAtCoverageReport({
    argv: ["--json"],
    input: { markdown: MARKDOWN, files: FILES },
    log: (line) => lines.push(line),
  });
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.total, 3);
  assert.equal(payload.cited.length, 2);
  assert.equal(payload.uncited.length, 1);
  assert.equal(payload.unknown.length, 1);
  assert.equal(result.exitCode, 0);
});
