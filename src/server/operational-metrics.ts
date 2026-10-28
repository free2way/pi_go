import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { ApiMetrics, gauge, METRICS_CONTENT_TYPE, operationalLabels, processMetrics, type MetricSample } from "../shared/operational-metrics.js";

const GROUPS = {
  jobs: ["queued", "claimed", "done", "failed", "cancelled", "other"],
  agents: ["planned", "running", "completed", "merged", "failed", "other"],
  runs: ["queued", "preparing", "developing", "checking", "reviewing", "completed", "needs_human", "failed", "cancelled", "other"],
  releases: ["planned", "in_progress", "released", "cancelled", "other"],
  run_releases: ["publishing", "triggered", "succeeded", "failed", "other"],
} as const;
const USAGE = ["calls", "tokens", "estimated_cost_usd", "unknown_calls", "failures"] as const;

/** Static aggregate projection: no IDs, provider/model names, JSON bodies or paths leave SQL. */
export const OPERATIONAL_METRICS_SQL = `WITH usage AS (
  SELECT COALESCE(SUM(calls), 0) AS calls,
    COALESCE(SUM(input_tokens::numeric + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
    COALESCE(SUM(estimated_cost), 0) AS cost FROM run_usage_role
), unknown_usage AS (
  SELECT COALESCE(SUM(COALESCE((document_json::jsonb ->> 'usageUnknownCalls')::numeric, 0)), 0) AS calls FROM runs
)
${Object.entries(GROUPS).filter(([family]) => family !== "run_releases").map(([family, states]) => {
  const table = { jobs: "jobs", agents: "run_agents", runs: "runs", releases: "agile_releases" }[family];
  const field = family === "agents" || family === "releases" ? "status" : "state";
  const allowed = states.filter(s => s !== "other").map(s => `'${s}'`).join(",");
  return `SELECT '${family}' AS family, CASE WHEN ${field} IN (${allowed}) THEN ${field} ELSE 'other' END AS bucket, COUNT(*)::text AS value FROM ${table} GROUP BY 2`;
}).join("\nUNION ALL\n")}
UNION ALL SELECT 'run_releases', CASE WHEN document_json::jsonb -> 'release' ->> 'status' IN ('publishing', 'triggered', 'succeeded', 'failed')
  THEN document_json::jsonb -> 'release' ->> 'status' ELSE 'other' END, COUNT(*)::text
  FROM runs WHERE jsonb_typeof(document_json::jsonb -> 'release') = 'object' GROUP BY 2
UNION ALL SELECT 'queue', 'oldest_wait_seconds', COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at)::timestamptz))), 0)::text
  FROM jobs WHERE state = 'queued' AND attempts < 5
UNION ALL SELECT 'usage', 'calls', calls::text FROM usage
UNION ALL SELECT 'usage', 'tokens', tokens::text FROM usage
UNION ALL SELECT 'usage', 'estimated_cost_usd', cost::text FROM usage
UNION ALL SELECT 'usage', 'unknown_calls', calls::text FROM unknown_usage
UNION ALL SELECT 'usage', 'failures', COUNT(*)::text FROM run_events WHERE source = 'system' AND type = 'provider.attempt_failed'`;

export function parseOperationalRows(rows: Record<string, unknown>[]): Map<string, MetricSample[]> {
  const result = new Map<string, MetricSample[]>(Object.entries(GROUPS).map(([k, states]) => [k, states.map(state => ({ value: 0, labels: { state } }))]));
  result.set("usage", USAGE.map(kind => ({ value: 0, labels: { kind } })));
  result.set("queue", [{ value: 0, labels: { kind: "oldest_wait_seconds" } }]);
  const seen = new Set<string>();
  for (const row of rows) {
    const family = String(row.family), bucket = String(row.bucket), values = result.get(family);
    const slot = values?.find(s => (s.labels?.state ?? s.labels?.kind) === bucket);
    const n = typeof row.value === "number" || typeof row.value === "string" && row.value.trim() ? Number(row.value) : NaN;
    const key = `${family}:${bucket}`;
    if (!slot || seen.has(key) || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER
      || !["estimated_cost_usd", "oldest_wait_seconds"].includes(bucket) && !Number.isSafeInteger(n)) throw new Error("Invalid operational aggregate");
    slot.value = n; seen.add(key);
  }
  if (USAGE.some(kind => !seen.has(`usage:${kind}`)) || !seen.has("queue:oldest_wait_seconds")) throw new Error("Incomplete operational aggregate");
  return result;
}

export function registerOperationalMetrics(app: FastifyInstance, options: {
  db: Db; pool: { totalCount: number; idleCount: number; waitingCount: number };
  authorized: (request: FastifyRequest) => boolean; version: string; environment?: NodeJS.ProcessEnv;
}) {
  const labels = operationalLabels("pigo-web", options.version, options.environment);
  const api = new ApiMetrics();
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/api/") && request.routeOptions.url !== "/api/internal/metrics") api.observe(request.method, reply.statusCode, reply.elapsedTime / 1000);
  });
  type Snapshot = { at: number; values?: ReturnType<typeof parseOperationalRows> };
  let cached: Snapshot | undefined, pending: Promise<Snapshot> | undefined;
  async function collect(): Promise<Snapshot> {
    if (cached && Date.now() - cached.at < 15_000) return cached;
    if (!pending) {
      pending = options.db.withTransaction(async tx => {
        await tx.query("SET TRANSACTION READ ONLY");
        await tx.query("SET LOCAL statement_timeout = '1500ms'");
        await tx.query("SET LOCAL lock_timeout = '500ms'");
        return parseOperationalRows((await tx.query(OPERATIONAL_METRICS_SQL)).rows);
      }).then(values => ({ at: Date.now(), values }), () => ({ at: Date.now() }))
        .then(snapshot => { cached = snapshot; return snapshot; }).finally(() => { pending = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<Snapshot>(resolve => { timer = setTimeout(() => resolve({ at: Date.now() }), 2000); timer.unref?.(); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  app.get("/api/internal/metrics", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!options.authorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const snapshot = await collect();
    let output = processMetrics(labels) + api.render(labels)
      + gauge("pigo_database_up", "Successful bounded database aggregate observation; failure is not zero usage.", labels, [{ value: snapshot.values ? 1 : 0 }])
      + gauge("pigo_database_pool_connections", "Current database pool connections and waiters.", labels,
        ["total", "idle", "waiting"].map((state, i) => ({ value: [options.pool.totalCount, options.pool.idleCount, options.pool.waitingCount][i]!, labels: { state } })));
    if (snapshot.values) {
      output += gauge("pigo_observation_age_seconds", "Age of the cached database aggregate.", labels, [{ value: Math.max(0, Date.now() - snapshot.at) / 1000 }]);
      output += gauge("pigo_queue_oldest_wait_seconds", "Oldest eligible queued job wait.", labels, [{ value: snapshot.values.get("queue")![0]!.value }]);
      for (const [family, help] of Object.entries({ jobs: "Retained jobs by state; claimed is not necessarily running.", agents: "Retained agent records by state.", runs: "Retained runs by state.", releases: "Retained Agile releases by state.", run_releases: "Retained standalone Run release records by state." })) {
        output += gauge(`pigo_${family}`, help, labels, snapshot.values.get(family)!);
      }
      for (const x of snapshot.values.get("usage")!) {
        const kind = x.labels!.kind;
        output += gauge(`pigo_model_${kind}_recorded`, kind === "estimated_cost_usd" ? "Retained estimated model cost; not a provider invoice." : "Retained reported model usage; can decrease after retention or deletion.", labels, [{ value: x.value }]);
      }
    }
    return reply.type(METRICS_CONTENT_TYPE).send(output);
  });
}
