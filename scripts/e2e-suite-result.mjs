/**
 * E2E suite verdict for the acceptance gate (P1 audit fix, v0.27).
 *
 * Background: the browser suite self-skips (missing Chromium, unreachable
 * `/api/health`) and several docs/05 §13 acceptance scenarios are `fixme`
 * until a live environment exists. Playwright therefore exits 0 with zero
 * scenarios executed, and a gate that only looks at the exit code would report
 * a false "acceptance PASS". This module turns the Playwright JSON report into
 * a verdict that cannot be fooled that way:
 *
 *   1. `executed === 0` is always a FAIL — an all-skipped/`fixme` run is not
 *      acceptance evidence. The operator override can never waive this.
 *   2. Every scenario in `REQUIRED_E2E_SCENARIOS` must be present in the report
 *      and must actually execute. A `skipped` / `fixme` / `todo` required
 *      scenario is a FAIL that names the scenario, unless the explicit,
 *      documented override below is set.
 *   3. A required scenario missing from the report (deleted/renamed/never
 *      collected) is a FAIL, so removing coverage cannot look like passing.
 *   4. The verdict always carries executed/passed/failed/skipped counts and the
 *      override reason, so a human reading CI output is never misled.
 *
 * Operator override (strictly parsed, default OFF):
 *   PI_E2E_ALLOW_REQUIRED_SKIPS=1            nothing else enables it
 *   PI_E2E_ALLOW_REQUIRED_SKIPS_REASON=...   mandatory, non-empty, printed
 * An unrecognised value ("true", "yes", "0", …) is a FAIL: a misconfigured
 * escape hatch must not silently change the gate's meaning.
 *
 * Pure decision logic lives in `evaluateE2eSuite` / `parseRequiredSkipOverride`
 * so it can be unit-tested with synthetic Playwright reports
 * (`scripts/e2e-suite-result.test.mjs`, run by `npm run test:scripts`). The
 * spawning wrapper `runE2eStep` takes injectable `spawn`/`readReport` seams.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var consumed by the Playwright json reporter to choose its output file. */
export const E2E_REPORT_FILE_ENV = "PLAYWRIGHT_JSON_OUTPUT_NAME";
/** Opt-in switch that waives required-scenario skips. Off unless exactly "1". */
export const ALLOW_REQUIRED_SKIPS_ENV = "PI_E2E_ALLOW_REQUIRED_SKIPS";
/** Mandatory, human-readable justification printed whenever the switch is on. */
export const ALLOW_REQUIRED_SKIPS_REASON_ENV = "PI_E2E_ALLOW_REQUIRED_SKIPS_REASON";

/** Command-line reporters used by the gate: list for humans, json for the verdict. */
export const E2E_GATE_REPORTER_ARGS = ["--reporter=list", "--reporter=json"];

/**
 * Scenarios the acceptance gate requires to actually execute.
 *
 * `file` is matched against the report's spec file (suffix match) and `id` must
 * remain the ASCII prefix of the test title, e.g. a test titled
 * `E2E-04 fixture-parallel-app：…` satisfies the `E2E-04` entry. Keep the id
 * prefix when re-wording a title, and add an entry here for any new docs/05 §13
 * scenario; deleting a spec without deleting its entry makes the gate FAIL with
 * "missing from the Playwright report".
 */
export const REQUIRED_E2E_SCENARIOS = Object.freeze([
  { id: "E2E-01a", file: "acceptance.spec.ts", summary: "单 Agent 完整闭环（本地演示）" },
  { id: "E2E-01b", file: "acceptance.spec.ts", summary: "单 Agent 完整闭环（真实 Provider + 人工 Approve）" },
  { id: "E2E-02", file: "acceptance.spec.ts", summary: "检查失败自动返修" },
  { id: "E2E-03", file: "acceptance.spec.ts", summary: "审核退回自动返修" },
  { id: "E2E-04", file: "acceptance.spec.ts", summary: "并行 Sub Agent" },
  { id: "E2E-05", file: "acceptance.spec.ts", summary: "Provider 故障不浪费开发成本" },
  { id: "E2E-06", file: "acceptance.spec.ts", summary: "Worker 崩溃恢复" },
  { id: "E2E-07", file: "acceptance.spec.ts", summary: "预算停止" },
  { id: "E2E-08", file: "acceptance.spec.ts", summary: "恶意仓库隔离" },
]);

/** Playwright test statuses that mean "the scenario really ran". */
const EXECUTED_STATUSES = new Set(["expected", "unexpected", "flaky"]);
/** Annotation types that explain why a scenario did not run. */
const SKIP_ANNOTATION_TYPES = new Set(["fixme", "todo", "skip"]);

/** Strip ANSI SGR escapes so skip reasons are readable in plain CI logs. */
function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** First non-empty line of a (possibly multi-line, ANSI-coloured) message, truncated. */
function firstLine(value, max = 200) {
  const clean = stripAnsi(value)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Parse the override strictly. Returns `{ enabled, reason, error }`; `error` is
 * set (and the gate must FAIL) whenever the variable is present but unusable.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function parseRequiredSkipOverride(env = process.env) {
  const raw = env[ALLOW_REQUIRED_SKIPS_ENV];
  if (raw === undefined || raw === "") return { enabled: false, reason: "", error: undefined };
  if (raw !== "1") {
    return {
      enabled: false,
      reason: "",
      error: `${ALLOW_REQUIRED_SKIPS_ENV}=${JSON.stringify(raw)} is not recognised — only the exact value "1" waives required-scenario skips (default: off)`,
    };
  }
  const reason = String(env[ALLOW_REQUIRED_SKIPS_REASON_ENV] ?? "").trim();
  if (!reason) {
    return {
      enabled: false,
      reason: "",
      error: `PI_E2E_ALLOW_REQUIRED_SKIPS=1 requires a documented, non-empty ${ALLOW_REQUIRED_SKIPS_REASON_ENV}`,
    };
  }
  return { enabled: true, reason, error: undefined };
}

/**
 * Flatten the Playwright JSON report into one entry per scenario (spec), with
 * the status that matters for gating. A spec that has test entries for several
 * projects counts once and is "executed" as soon as one entry really ran.
 *
 * @param {any} report parsed Playwright JSON report
 */
export function collectSpecs(report) {
  /** @type {Array<any>} */
  const specs = [];
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) specs.push(spec);
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);

  return specs.map((spec) => {
    const tests = Array.isArray(spec?.tests) ? spec.tests : [];
    const statuses = tests.map((test) => String(test?.status ?? "unknown"));
    const annotations = tests.flatMap((test) => (Array.isArray(test?.annotations) ? test.annotations : []));
    const ran = statuses.some((status) => EXECUTED_STATUSES.has(status));
    const status = ran
      ? statuses.includes("unexpected")
        ? "failed"
        : statuses.includes("flaky")
          ? "flaky"
          : "passed"
      : "skipped";
    const marker = annotations.find((annotation) => SKIP_ANNOTATION_TYPES.has(annotation?.type));
    return {
      file: String(spec?.file ?? ""),
      title: String(spec?.title ?? ""),
      project: tests[0]?.projectName ? String(tests[0].projectName) : undefined,
      status,
      kind: status === "skipped" ? String(marker?.type ?? "skipped") : undefined,
      reason: marker ? firstLine(marker.description ?? "") : undefined,
    };
  });
}

/** True when a report spec satisfies a required-scenario entry. */
function matchesRequired(spec, entry) {
  const fileMatches = spec.file === entry.file || spec.file.endsWith(`/${entry.file}`);
  return fileMatches && spec.title.startsWith(entry.id);
}

/**
 * Decide whether the E2E run counts as acceptance evidence.
 *
 * @param {any} report parsed Playwright JSON report
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function evaluateE2eSuite(report, options = {}) {
  const env = options.env ?? process.env;
  const override = parseRequiredSkipOverride(env);
  const specs = collectSpecs(report);

  const counts = {
    total: specs.length,
    executed: specs.filter((spec) => spec.status !== "skipped").length,
    passed: specs.filter((spec) => spec.status === "passed").length,
    failed: specs.filter((spec) => spec.status === "failed").length,
    flaky: specs.filter((spec) => spec.status === "flaky").length,
    skipped: specs.filter((spec) => spec.status === "skipped").length,
  };

  /** @type {Array<{ id: string, kind: string, reason: string, file: string }>} */
  const requiredSkipped = [];
  /** @type {string[]} */
  const missingRequired = [];
  for (const entry of REQUIRED_E2E_SCENARIOS) {
    const spec = specs.find((candidate) => matchesRequired(candidate, entry));
    if (!spec) {
      missingRequired.push(entry.id);
      continue;
    }
    if (spec.status === "skipped") {
      requiredSkipped.push({ id: entry.id, kind: spec.kind ?? "skipped", reason: spec.reason ?? "", file: spec.file });
    }
  }

  /** @type {string[]} */
  const failures = [];
  if (override.error) failures.push(override.error);
  if (counts.executed === 0) {
    failures.push(
      "the E2E suite executed 0 scenarios — an all-skipped/fixme suite is not acceptance evidence (the operator override cannot waive this)",
    );
  }
  if (counts.failed > 0) failures.push(`${counts.failed} E2E scenario(s) FAILED`);
  if (missingRequired.length > 0) {
    failures.push(
      `required scenario(s) missing from the Playwright report: ${missingRequired.join(", ")} (deleted, renamed or never collected)`,
    );
  }
  if (requiredSkipped.length > 0 && !override.enabled) {
    failures.push(
      `required scenario(s) did not execute: ${requiredSkipped.map((entry) => `${entry.id} [${entry.kind}]`).join(", ")} — enable them in a live environment (PI_E2E_LIVE=1) or set ${ALLOW_REQUIRED_SKIPS_ENV}=1 with ${ALLOW_REQUIRED_SKIPS_REASON_ENV} to accept the deviation deliberately`,
    );
  }

  /** @type {string[]} */
  const lines = [];
  const flakyNote = counts.flaky > 0 ? ` flaky=${counts.flaky}` : "";
  lines.push(`E2E suite: executed=${counts.executed} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}${flakyNote} (total=${counts.total})`);
  lines.push(
    `E2E required scenarios: ${REQUIRED_E2E_SCENARIOS.length - missingRequired.length}/${REQUIRED_E2E_SCENARIOS.length} present, ${requiredSkipped.length} not executed${missingRequired.length > 0 ? `, ${missingRequired.length} missing` : ""}`,
  );
  for (const failed of specs.filter((spec) => spec.status === "failed")) {
    lines.push(`  - FAILED: ${failed.file} › ${failed.title}`);
  }
  for (const entry of requiredSkipped) {
    lines.push(`  - required NOT executed: ${entry.id} [${entry.kind}]${entry.reason ? ` — ${entry.reason}` : ""}`);
  }
  for (const id of missingRequired) lines.push(`  - required MISSING from report: ${id}`);
  if (override.enabled) {
    lines.push(
      `  - OVERRIDE ${ALLOW_REQUIRED_SKIPS_ENV}=1 — required-scenario skips waived${requiredSkipped.length > 0 ? ` (${requiredSkipped.map((entry) => entry.id).join(", ")})` : ""}; reason: ${override.reason}`,
    );
  } else if (env[ALLOW_REQUIRED_SKIPS_ENV] !== undefined && env[ALLOW_REQUIRED_SKIPS_ENV] !== "") {
    lines.push(`  - OVERRIDE rejected: ${override.error}`);
  }
  lines.push(`E2E verdict: ${failures.length === 0 ? "PASS" : "FAIL"}${failures.length > 0 ? ` — ${failures.join(" | ")}` : ""}`);

  const detailParts = [`executed=${counts.executed} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}`];
  if (counts.flaky > 0) detailParts.push(`flaky=${counts.flaky}`);
  if (override.enabled) {
    detailParts.push(
      `override ${ALLOW_REQUIRED_SKIPS_ENV}=1 (reason: ${override.reason})${requiredSkipped.length > 0 ? ` waiving ${requiredSkipped.map((entry) => entry.id).join(", ")}` : ""}`,
    );
  } else if (override.error) {
    detailParts.push(override.error);
  }
  if (failures.length > 0) detailParts.push(failures.join(" | "));

  return {
    ok: failures.length === 0,
    counts,
    requiredSkipped,
    missingRequired,
    override,
    failures,
    specs,
    lines,
    detail: detailParts.join("; "),
  };
}

/** Read + parse the Playwright JSON report written by the json reporter. */
export function readPlaywrightReport(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Run the Playwright suite for a gate step and grade it with `evaluateE2eSuite`.
 *
 * The suite is always invoked with a machine-readable json report (plus the
 * human `list` reporter); the report is what the verdict is based on, never the
 * exit code alone. Missing/unreadable report = FAIL, even at exit 0.
 *
 * @param {{ id: string, label: string, command: string, args?: string[], env?: Record<string, string>, requiredReason?: string }} step
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, spawn?: Function, readReport?: Function, reportDir?: string, log?: (...args: any[]) => void }} [options]
 */
export function runE2eStep(step, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const readReport = options.readReport ?? readPlaywrightReport;
  const log = options.log ?? console.log;

  if (step.requiredReason) {
    // The gate normally fails this before reaching the runner; keep the
    // invariant here too so a required step can never be "executed" blind.
    return { ok: false, detail: `REQUIRED, not skippable: ${step.requiredReason}` };
  }

  const reportDir = options.reportDir ?? mkdtempSync(join(tmpdir(), "pigo-e2e-report-"));
  const reportPath = join(reportDir, "playwright-report.json");

  log(`\n[acceptance-gate] ▶ ${step.label} (${E2E_GATE_REPORTER_ARGS.join(" ")}; machine report: ${reportPath})`);
  const startedAt = Date.now();
  const result = spawn(step.command, [...(step.args ?? []), "--", ...E2E_GATE_REPORTER_ARGS], {
    cwd,
    stdio: "inherit",
    env: { ...env, ...(step.env ?? {}), [E2E_REPORT_FILE_ENV]: reportPath },
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result?.error) return { ok: false, detail: `could not spawn: ${result.error.message}` };

  let report;
  let readError;
  try {
    report = readReport(reportPath);
  } catch (error) {
    readError = error;
  }
  if (!report) {
    const reason = `no readable Playwright JSON report at ${reportPath} (${readError?.message ?? "missing"})`;
    if (result?.status !== 0) return { ok: false, detail: `exit ${result.status} and ${reason}` };
    return { ok: false, detail: `the suite exited 0 but wrote ${reason} — refusing to accept unverifiable "evidence"` };
  }

  const verdict = evaluateE2eSuite(report, { env });
  for (const line of verdict.lines) log(`[acceptance-gate] ${line}`);
  log(`[acceptance-gate] Playwright JSON report: ${reportPath}`);

  if (result?.status !== 0) return { ok: false, detail: `exit ${result.status} (${seconds}s) — ${verdict.detail}`, verdict };
  return { ok: verdict.ok, detail: `${verdict.detail} (${seconds}s)`, verdict };
}
