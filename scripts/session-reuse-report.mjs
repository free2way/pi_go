#!/usr/bin/env node
/**
 * `npm run report:sessions` — Sprint 2 session-reuse report (read-only).
 *
 * Answers "did reusing the developer session across repair rounds help?" from
 * data a deployment already recorded. The pinned Pi CLI has no RPC/daemon mode,
 * so reuse is just calling Pi with the same `--session-id` in later rounds:
 * this script measures the tokens/cost/latency that reuse actually saved.
 *
 * DATA SOURCES (exactly one is required; without one the script refuses to run)
 *
 *   PI_DATABASE_URL (or DATABASE_URL)
 *     Reads `runs.document_json.sessions` and the run's `session.metrics`
 *     events straight from PostgreSQL with SELECT-only queries.
 *
 *   PI_REPORT_BASE_URL (+ PI_REPORT_EMAIL, default developer@localhost)
 *     Queries a running web instance over HTTP (`GET /api/runs`, `/events`).
 *     The email is sent as `x-pigo-dev-email`, the development identity header.
 *
 * The connection string is used only to connect and is never printed: the banner
 * shows `database @ host` (no user/password).
 *
 * Exit codes: 0 when data is reported OR when there is simply no data yet
 * (with an explicit note); 1 only for a missing/!invalid configuration or a
 * failed query, so `report:sessions` is safe to wire into a cron/reporting job.
 *
 * The aggregation and table rendering are pure functions in
 * `scripts/session-reuse-lib.mjs` (unit-tested with `node --test`).
 */
import { fileURLToPath } from "node:url";
import { buildReports, parseReportConfig, renderReport } from "./session-reuse-lib.mjs";

const EVENT_LIMIT = 1_000;

function usageText() {
  return `Session-reuse report (Sprint 2, read-only)

Usage:
  npm run report:sessions

Required environment (one of):
  PI_DATABASE_URL / DATABASE_URL   read the deployment database directly (SELECT only)
  PI_REPORT_BASE_URL               query a running web instance over HTTP
  PI_REPORT_EMAIL                  dev identity for the HTTP API (default developer@localhost)

The report never writes to the database or API and never prints the connection
string. It exits 0 with a note when no multi-round session data exists yet.
`;
}

async function loadFromDatabase(databaseUrl) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    const runsById = new Map();
    const runRows = await pool.query("SELECT id, document_json FROM runs");
    for (const row of runRows.rows) {
      let document;
      try {
        document = JSON.parse(String(row.document_json));
      } catch {
        continue;
      }
      runsById.set(String(row.id), { ...document, id: String(row.id), events: [] });
    }
    const eventRows = await pool.query(
      "SELECT run_id, round, type, meta_json FROM run_events WHERE type = $1 ORDER BY run_id, seq",
      ["session.metrics"],
    );
    for (const row of eventRows.rows) {
      const run = runsById.get(String(row.run_id));
      if (!run) continue;
      let meta = {};
      try {
        meta = row.meta_json ? JSON.parse(String(row.meta_json)) : {};
      } catch {
        meta = {};
      }
      run.events.push({ round: row.round, type: row.type, meta });
    }
    return [...runsById.values()];
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function fetchJson(url, email) {
  const response = await fetch(url, { headers: email ? { "x-pigo-dev-email": email } : {} });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function fetchRunEvents(baseUrl, runId, email) {
  const events = [];
  let after = 0;
  for (;;) {
    const page = await fetchJson(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${EVENT_LIMIT}`, email);
    const batch = Array.isArray(page) ? page : [];
    events.push(...batch);
    if (batch.length < EVENT_LIMIT) break;
    const last = batch[batch.length - 1];
    const next = Number(last?.seq);
    if (!Number.isFinite(next) || next <= after) break;
    after = next;
  }
  return events.filter((event) => event && event.type === "session.metrics");
}

async function loadFromApi(baseUrl, email) {
  const list = await fetchJson(`${baseUrl}/api/runs`, email);
  const runs = Array.isArray(list) ? list : [];
  for (const run of runs) {
    if (!run || typeof run.id !== "string") continue;
    run.events = await fetchRunEvents(baseUrl, run.id, email);
  }
  return runs;
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  if (argv.has("--help") || argv.has("-h")) {
    console.log(usageText());
    return;
  }

  const config = parseReportConfig(process.env);
  if (!config.ok) {
    console.error(`[session-reuse-report] ${config.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[session-reuse-report] source: ${config.mode === "db" ? "database" : "api"} — ${config.target}`);
  const runs = config.mode === "db"
    ? await loadFromDatabase(config.databaseUrl)
    : await loadFromApi(config.baseUrl, config.email);

  const { reports, skipped, considered } = buildReports(runs);
  console.log(renderReport(reports));
  if (reports.length === 0) {
    console.log(`[session-reuse-report] scanned ${considered} run(s); ${skipped} had <2 rounds or no session metrics.`);
  } else if (skipped > 0) {
    console.log(`[session-reuse-report] note: ${skipped} of ${considered} scanned run(s) were skipped (<2 rounds or no session metrics).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[session-reuse-report] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
