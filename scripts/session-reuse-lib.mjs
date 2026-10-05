/**
 * Sprint 2 session-reuse report — pure aggregation + formatting.
 *
 * `scripts/session-reuse-report.mjs` is a thin CLI over this module. Keeping the
 * config parsing, per-run aggregation and table rendering dependency-free means
 * they can be unit-tested with fixtures (see `scripts/session-reuse-lib.test.mjs`,
 * run by `npm run test:scripts`; vitest only collects `src/**`).
 *
 * Why this exists: the pinned Pi CLI has no RPC/daemon mode, so "reuse" means
 * passing the same `--session-id` (developer/integrator/sub-agent across repair
 * rounds) or `--no-session` (planner, and every reviewer round). This report
 * measures the benefit of that reuse from data a deployment already recorded:
 *
 *   - the run document's additive `sessions: RunSessionSummary[]`, and/or
 *   - the worker's `session.metrics` events (one per invocation, carrying the
 *     round/role/session plus tokens, duration and — on new workers — cost).
 *
 * Everything here is read-only and never touches credentials beyond the
 * connection string the caller must supply to connect.
 */

/** Event type emitted by `runPiWithRetry` for every instrumented Pi invocation. */
export const SESSION_EVENT_TYPE = "session.metrics";

/**
 * Parse `PI_REPORT_BASE_URL`-mode config. The dev email is sent as the
 * `x-pigo-dev-email` header (see `src/server/auth.ts`); it is not a secret.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, mode: "db", databaseUrl: string, target: string, email?: undefined }
 *   | { ok: true, mode: "api", baseUrl: string, target: string, email: string }
 *   | { ok: false, error: string }}
 */
export function parseReportConfig(env = process.env) {
  const databaseUrl = trim(env.PI_DATABASE_URL) || trim(env.DATABASE_URL);
  if (databaseUrl) {
    return { ok: true, mode: "db", databaseUrl, target: describeDatabaseTarget(databaseUrl) };
  }
  const baseUrl = trim(env.PI_REPORT_BASE_URL);
  if (baseUrl) {
    const email = trim(env.PI_REPORT_EMAIL) || trim(env.PI_DEV_EMAIL) || "developer@localhost";
    return { ok: true, mode: "api", baseUrl, target: baseUrl, email };
  }
  return {
    ok: false,
    error:
      "no data source configured — set PI_DATABASE_URL (or DATABASE_URL) to read a deployment database, " +
      "or PI_REPORT_BASE_URL (+ PI_REPORT_EMAIL) to query the HTTP API. Refusing to run without one.",
  };
}

/**
 * Human-readable database target for the script banner. Deliberately drops the
 * credentials: a connection string never reaches stdout/stderr/logs.
 *
 * @param {string} url
 */
export function describeDatabaseTarget(url) {
  try {
    const parsed = new URL(String(url));
    const database = parsed.pathname.replace(/^\//, "") || "(unknown)";
    return `${database} @ ${parsed.host}`;
  } catch {
    return "(unparseable connection string)";
  }
}

function trim(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toInt(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toNumber(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteCost(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Cost recorded on a `session.metrics` event, if the worker reported one. */
function eventCost(meta) {
  return finiteCost(meta.estimatedCost) ?? finiteCost(meta.cost) ?? null;
}

/**
 * One `session.metrics` event → one table row. Returns undefined when the event
 * is not a well-formed session metric (unknown events are skipped, not guessed).
 *
 * @param {{ round?: unknown, type?: unknown, meta?: Record<string, unknown> }} event
 */
export function normalizeSessionEvent(event) {
  if (!event || event.type !== SESSION_EVENT_TYPE) return undefined;
  const meta = event.meta && typeof event.meta === "object" ? event.meta : {};
  const sessionId = trim(meta.sessionId);
  if (!sessionId) return undefined;
  const round = toInt(event.round ?? meta.round, 1);
  return {
    round: round >= 1 ? round : 1,
    rounds: [round >= 1 ? round : 1],
    role: trim(meta.role) || "unknown",
    sessionId,
    resumed: meta.resumed === true,
    durationMs: toNumber(meta.durationMs),
    inputTokens: toNumber(meta.inputTokens),
    outputTokens: toNumber(meta.outputTokens),
    cacheReadTokens: toNumber(meta.cacheReadTokens),
    cacheWriteTokens: toNumber(meta.cacheWriteTokens),
    modelCalls: toNumber(meta.modelCalls),
    cost: eventCost(meta),
    source: "events",
  };
}

/** One `RunSessionSummary` (aggregated across its rounds) → one table row. */
function summaryRow(summary) {
  const sessionId = trim(summary?.sessionId);
  if (!sessionId) return undefined;
  const rounds = Array.isArray(summary.rounds) && summary.rounds.length > 0
    ? [...new Set(summary.rounds.map((round) => toInt(round, 1)).filter((round) => round >= 1))].sort((a, b) => a - b)
    : [1];
  return {
    round: rounds[0],
    rounds,
    role: trim(summary.role) || "unknown",
    sessionId,
    resumed: summary.resumed === true,
    durationMs: toNumber(summary.durationMs),
    inputTokens: toNumber(summary.inputTokens),
    outputTokens: toNumber(summary.outputTokens),
    cacheReadTokens: toNumber(summary.cacheReadTokens),
    cacheWriteTokens: toNumber(summary.cacheWriteTokens),
    modelCalls: toNumber(summary.modelCalls),
    cost: null,
    source: "sessions",
  };
}

function rowKey(row) {
  return `${row.round}|${row.role}|${row.sessionId}`;
}

/** Collapse repeated calls of the same round/role/session into one row. */
function mergeRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...row, rounds: [...row.rounds] });
      continue;
    }
    current.rounds = [...new Set([...current.rounds, ...row.rounds])].sort((a, b) => a - b);
    current.resumed = current.resumed || row.resumed;
    current.durationMs += row.durationMs;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.cacheWriteTokens += row.cacheWriteTokens;
    current.modelCalls += row.modelCalls;
    if (current.cost !== null || row.cost !== null) current.cost = (current.cost ?? 0) + (row.cost ?? 0);
  }
  return [...merged.values()].sort((a, b) => a.round - b.round || a.role.localeCompare(b.role) || a.sessionId.localeCompare(b.sessionId));
}

/**
 * Attribute cost to every row.
 *
 *   - `session-events`: at least one row carries provider-reported cost; missing
 *     rows count as 0 (a partial basis is reported as such).
 *   - `run-total`: no per-session cost exists, so the run's authoritative
 *     `usage.estimatedCost` is allocated across rows by token share. Clearly an
 *     allocation, never presented as measured per-session cost.
 *   - `unavailable`: neither exists; cost columns render as `n/a`.
 */
function assignCosts(rows, runTotalCost) {
  const hasReported = rows.some((row) => typeof row.cost === "number");
  if (hasReported) {
    // A row without its own cost counts as 0 so the totals stay computable; the
    // partial basis is reported explicitly instead of silently passing as exact.
    const complete = rows.every((row) => typeof row.cost === "number");
    return {
      basis: complete ? "session-events" : "session-events-partial",
      rows: rows.map((row) => ({ ...row, cost: row.cost ?? 0 })),
    };
  }
  const totalTokens = rows.reduce((sum, row) => sum + rowTokens(row), 0);
  if (runTotalCost > 0 && totalTokens > 0) {
    return {
      basis: "run-total",
      rows: rows.map((row) => ({ ...row, cost: (runTotalCost * rowTokens(row)) / totalTokens })),
    };
  }
  return { basis: "unavailable", rows: rows.map((row) => ({ ...row, cost: null })) };
}

function rowTokens(row) {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

/** Aggregate a set of rows into the numbers the report shows per run/bucket. */
export function aggregateRows(rows) {
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const cacheReadTokens = rows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const cacheWriteTokens = rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const costKnown = rows.length > 0 && rows.every((row) => typeof row.cost === "number");
  const cost = costKnown ? rows.reduce((sum, row) => sum + (row.cost ?? 0), 0) : null;
  const distinctRounds = new Set();
  for (const row of rows) for (const round of row.rounds ?? [row.round]) distinctRounds.add(round);
  const roundCount = distinctRounds.size;
  return {
    rows: rows.length,
    calls: rows.reduce((sum, row) => sum + (row.modelCalls || 0), 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cacheReadShare: totalTokens > 0 ? cacheReadTokens / totalTokens : 0,
    durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    roundCount,
    cost,
    costPerRound: cost !== null && roundCount > 0 ? cost / roundCount : null,
  };
}

function bucketReport(rows) {
  return aggregateRows(rows);
}

/**
 * Build the report for one run, or undefined when the run is not eligible
 * (fewer than 2 rounds, or no session metrics at all).
 *
 * @param {{
 *   id?: string,
 *   round?: number,
 *   usage?: { estimatedCost?: number } | null,
 *   sessions?: Array<Record<string, unknown>> | null,
 *   events?: Array<Record<string, unknown>> | null,
 * }} run
 */
export function buildRunReport(run) {
  const round = toInt(run?.round, 0);
  if (round < 2) return undefined;

  const events = Array.isArray(run?.events) ? run.events : [];
  let rows = mergeRows(events.map(normalizeSessionEvent).filter(Boolean));
  let source = "events";
  const eventRows = rows.length;
  if (rows.length === 0) {
    const sessions = Array.isArray(run?.sessions) ? run.sessions : [];
    rows = mergeRows(sessions.map(summaryRow).filter(Boolean));
    source = "sessions";
  }
  if (rows.length === 0) return undefined;

  const runTotalCost = finiteCost(run?.usage?.estimatedCost) ?? 0;
  const assigned = assignCosts(rows, runTotalCost);
  const resolved = assigned.rows;

  const round1 = resolved.filter((row) => row.round === 1);
  const later = resolved.filter((row) => row.round > 1);
  // A per-round comparison is only meaningful when each row is a single round.
  // The `sessions` summary fallback aggregates a session across rounds, so it is
  // left as n/a rather than guessing which round its tokens belong to.
  const perRound = source === "events";

  return {
    runId: trim(run?.id) || "(unknown run)",
    rounds: round,
    source,
    eventRows,
    costBasis: assigned.basis,
    runTotalCost,
    rows: resolved,
    totals: bucketReport(resolved),
    comparison: perRound
      ? {
          round1: bucketReport(round1),
          later: bucketReport(later),
          resumed: {
            round1: bucketReport(round1.filter((row) => row.resumed)),
            later: bucketReport(later.filter((row) => row.resumed)),
          },
        }
      : null,
  };
}

/**
 * Build reports for a list of runs. A run with ≥2 rounds but no session data is
 * counted as skipped so the CLI can say so explicitly instead of silently
 * dropping it.
 *
 * @param {Array<Parameters<typeof buildRunReport>[0]>} runs
 */
export function buildReports(runs) {
  const reports = [];
  let skipped = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    const report = buildRunReport(run);
    if (report) reports.push(report);
    else skipped += 1;
  }
  reports.sort((a, b) => b.rounds - a.rounds || a.runId.localeCompare(b.runId));
  return { reports, skipped, considered: (runs ?? []).length };
}

function formatInt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function formatCost(value) {
  return value === null || value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function formatPercent(share) {
  return Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : "n/a";
}

function roundLabel(row) {
  const rounds = row.rounds ?? [row.round];
  if (rounds.length <= 1) return String(row.round);
  return `${rounds[0]}-${rounds[rounds.length - 1]}`;
}

function pad(value, width, alignRight = false) {
  const text = String(value);
  if (text.length >= width) return text;
  return alignRight ? text.padStart(width) : text.padEnd(width);
}

function totalsLine(label, aggregate) {
  return (
    `  ${label}: ${formatInt(aggregate.totalTokens)} tokens ` +
    `(in ${formatInt(aggregate.inputTokens)} · out ${formatInt(aggregate.outputTokens)} · ` +
    `cacheRead ${formatInt(aggregate.cacheReadTokens)} · cacheWrite ${formatInt(aggregate.cacheWriteTokens)}) · ` +
    `cacheRead share ${formatPercent(aggregate.cacheReadShare)} · ` +
    `cost ${formatCost(aggregate.cost)} · cost/round ${formatCost(aggregate.costPerRound)}`
  );
}

/** Render one run's compact round×role table plus its aggregates/comparison. */
export function renderRunReport(report) {
  const headers = ["round", "role", "session", "resumed", "duration", "input", "output", "cacheRead", "cacheWrite", "cost"];
  const body = report.rows.map((row) => [
    roundLabel(row),
    row.role,
    row.sessionId,
    row.resumed ? "yes" : "no",
    `${(row.durationMs / 1000).toFixed(1)}s`,
    formatInt(row.inputTokens),
    formatInt(row.outputTokens),
    formatInt(row.cacheReadTokens),
    formatInt(row.cacheWriteTokens),
    formatCost(row.cost),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => String(row[index]).length)),
  );
  const headerLine = headers.map((header, index) => pad(header, widths[index], index >= 4)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = [
    `run ${report.runId}  ·  ${report.rounds} rounds  ·  ${report.rows.length} session rows  ·  source: ${report.source}`,
    `  ${headerLine}`,
    `  ${separator}`,
    ...body.map((row) => `  ${row.map((cell, index) => pad(cell, widths[index], index >= 4)).join("  ")}`),
    totalsLine(`totals [${report.costBasis}]`, report.totals),
  ];
  if (report.comparison) {
    lines.push(
      `  round-1 vs later: cacheRead share ${formatPercent(report.comparison.round1.cacheReadShare)} → ` +
        `${formatPercent(report.comparison.later.cacheReadShare)} · ` +
        `cost/round ${formatCost(report.comparison.round1.costPerRound)} → ${formatCost(report.comparison.later.costPerRound)}`,
      `  resumed only:     cacheRead share ${formatPercent(report.comparison.resumed.round1.cacheReadShare)} → ` +
        `${formatPercent(report.comparison.resumed.later.cacheReadShare)} · ` +
        `cost/round ${formatCost(report.comparison.resumed.round1.costPerRound)} → ${formatCost(report.comparison.resumed.later.costPerRound)}`,
    );
  } else {
    lines.push("  round-1 vs later: n/a (only the aggregated `sessions` summary is available, no per-round events)");
  }
  if (report.costBasis === "run-total") {
    lines.push(
      `  note: no per-session cost recorded; costs above allocate the run total ` +
        `${formatCost(report.runTotalCost)} by token share.`,
    );
  } else if (report.costBasis.startsWith("session-events-partial")) {
    lines.push("  note: some session.metrics events carried no cost; those rows count as $0.0000.");
  } else if (report.costBasis === "unavailable") {
    lines.push("  note: no cost recorded for this run (neither session events nor run.usage.estimatedCost).");
  }
  return lines.join("\n");
}

/** Render the whole report; an empty input yields an explicit no-data note. */
export function renderReport(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    return (
      "No runs with ≥2 rounds and session metrics were found — nothing to measure.\n" +
      "This is expected before any multi-round run has executed with a worker that emits session.metrics."
    );
  }
  const blocks = reports.map(renderRunReport);
  const overall = aggregateRows(reports.flatMap((report) => report.rows));
  const withCost = reports.filter((report) => report.costBasis !== "unavailable").length;
  return [
    `Session reuse report — ${reports.length} run(s) with session metrics (${withCost} with cost data)`,
    "",
    blocks.join("\n\n"),
    "",
    `Across ${reports.length} run(s): ${totalsLine("overall", overall).trim()}`,
  ].join("\n");
}
