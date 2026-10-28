import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "./db.js";
import { parseOperationalRows, registerOperationalMetrics } from "./operational-metrics.js";
import { ApiMetrics, operationalLabels } from "../shared/operational-metrics.js";

const rows = () => [...["calls", "tokens", "estimated_cost_usd", "unknown_calls", "failures"].map(bucket => ({ family: "usage", bucket, value: bucket === "tokens" ? "42" : "0" })), { family: "queue", bucket: "oldest_wait_seconds", value: "0.5" }];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map(a => a.close())); });

function fixture(observe: () => Promise<{ rows: Record<string, unknown>[] }>) {
  const app = Fastify(); apps.push(app);
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => { statements.push(sql); return sql.startsWith("SET ") ? { rows: [] } : observe(); });
  const db: Db = { query, withTransaction: async fn => fn(db) };
  registerOperationalMetrics(app, { db, pool: { totalCount: 3, idleCount: 2, waitingCount: 1 },
    version: "1.2.3", environment: { PI_DEPLOYMENT_ENVIRONMENT: "staging" }, authorized: req => req.headers.authorization === "Bearer fixture" });
  app.get("/api/runs/:id", async () => ({ ok: true }));
  return { app, query, statements };
}
const scrape = (app: ReturnType<typeof Fastify>) => app.inject({ url: "/api/internal/metrics", headers: { authorization: "Bearer fixture" } });

it("denies ordinary sessions and missing/wrong service credentials before touching the database", async () => {
  const { app, query } = fixture(async () => ({ rows: rows() }));
  for (const headers of [{}, { cookie: "session=fixture" }, { authorization: "Bearer wrong" }]) {
    expect((await app.inject({ url: "/api/internal/metrics", headers })).statusCode).toBe(401);
  }
  expect(query).not.toHaveBeenCalled();
});

it("exports complete aggregates and bounded API histograms without request values, and reuses one read-only observation", async () => {
  const { app, query, statements } = fixture(async () => ({ rows: [...rows(), { family: "jobs", bucket: "queued", value: "7" }, { family: "agents", bucket: "running", value: "2" }] }));
  for (let i = 0; i < 100; i++) await app.inject(`/api/runs/private-path-${i}?token=secret-body-${i}`);
  const first = await scrape(app), second = await scrape(app);
  expect(first.statusCode).toBe(200); expect(first.headers["content-type"]).toContain("version=0.0.4"); expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.body).toContain('pigo_jobs{state="queued",service="pigo-web",environment="staging",version="1.2.3"} 7');
  expect(first.body).toContain('pigo_model_tokens_recorded{service="pigo-web",environment="staging",version="1.2.3"} 42');
  expect(first.body).toMatch(/pigo_api_requests_total\{[^\n]+\} 100\n/);
  expect(first.body).toMatch(/pigo_api_request_duration_seconds_bucket\{[^\n]+le="\+Inf"\} 100\n/);
  expect(second.body).toMatch(/pigo_api_request_duration_seconds_count\{[^\n]+\} 100\n/);
  expect(first.body).not.toMatch(/private-path|secret-body|token=|run_id|owner=|provider=|model="/);
  expect(statements.slice(0, 3)).toEqual(["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '500ms'"]);
  expect(query).toHaveBeenCalledTimes(4);
});

it("bounds method/status label cardinality even for hostile methods and rejects invalid durations", () => {
  const api = new ApiMetrics();
  for (let i = 0; i < 1000; i++) api.observe(`PRIVATE_${i}`, 700 + i, 0.01);
  api.observe("GET", 200, NaN); api.observe("GET", 200, -1);
  const output = api.render(operationalLabels("pigo-web", "v1", { NODE_ENV: "test" }));
  expect(output).toContain('method="other",status_class="other"'); expect(output).not.toContain("PRIVATE_");
  expect(output.match(/^pigo_api_requests_total\{/gm)).toHaveLength(1);
  const counts = [...output.matchAll(/^pigo_api_request_duration_seconds_bucket\{.*\} (\d+)$/gm)].map(x => Number(x[1]));
  expect(counts).toEqual([...counts].sort((a, b) => a - b)); expect(counts.at(-1)).toBe(1000);
});

it.each(["secret", "\nforged=\"value\"", "a".repeat(100)])("does not expose untrusted deployment labels %j", value => {
  const labels = operationalLabels("pigo-worker", value, { PI_INTERNAL_TOKEN: "secret", PI_DEPLOYMENT_ENVIRONMENT: value });
  expect(labels).toEqual({ service: "pigo-worker", environment: "unknown", version: "unknown" });
  expect(operationalLabels("pigo-web", "v1", { NODE_ENV: "production" }).environment).toBe("unknown");
});

it.each(["-1", "NaN", "Infinity", "9007199254740992", "", null, undefined])("rejects corrupted aggregate %j rather than reporting healthy zeroes", value => {
  expect(() => parseOperationalRows([...rows(), { family: "jobs", bucket: "queued", value }])).toThrow();
});

it("rejects missing usage, duplicates and unbounded labels", () => {
  expect(() => parseOperationalRows([])).toThrow();
  expect(() => parseOperationalRows([...rows(), rows()[0]!])).toThrow();
  expect(() => parseOperationalRows([...rows(), { family: "jobs", bucket: "private/path", value: 1 }])).toThrow();
});

it("database failure is explicit and never exports the error, old data, or false usage zeroes", async () => {
  const { app } = fixture(async () => { throw new Error("opaque-database-error-secret-body"); });
  const response = await scrape(app);
  expect(response.statusCode).toBe(200); expect(response.body).toMatch(/pigo_database_up\{[^\n]+\} 0\n/);
  expect(response.body).not.toMatch(/secret-body|opaque-database-error|pigo_jobs\{|pigo_model_tokens_recorded\{/);
});

it("coalesces concurrent scrapes and bounds an unresponsive database to two seconds", async () => {
  const { app, query } = fixture(() => new Promise(() => undefined));
  await app.ready(); vi.useFakeTimers();
  const pending = Promise.all(Array.from({ length: 8 }, () => scrape(app)));
  await vi.advanceTimersByTimeAsync(2100);
  const responses = await pending;
  expect(query).toHaveBeenCalledTimes(4);
  expect(responses.every(r => r.statusCode === 200 && /pigo_database_up\{[^\n]+\} 0\n/.test(r.body))).toBe(true);
});
