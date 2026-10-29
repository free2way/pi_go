import { diagnosticSecrets, redactDiagnosticText } from "./diagnostics.js";
import { timingSafeEqual } from "node:crypto";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export type MetricLabels = { service: string; environment: string; version: string };
export type MetricSample = { value: number; labels?: Record<string, string> };

/** A scraper must not receive a credential that can submit jobs or deployments. */
export function metricsAuthorized(authorization: string | undefined, readToken: string, privilegedToken: string): boolean {
  if (readToken.length < 32 || readToken === privilegedToken || !authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7)), expected = Buffer.from(readToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Only operator labels and fixed enums; never accept request or model labels. */
export function operationalLabels(service: "pigo-web" | "pigo-worker", version: string, env = process.env): MetricLabels {
  const candidate = env.PI_DEPLOYMENT_ENVIRONMENT?.trim()
    || (["development", "test"].includes(env.NODE_ENV ?? "") ? env.NODE_ENV! : "unknown");
  const safeVersion = redactDiagnosticText(version, diagnosticSecrets(env));
  return { service, environment: ["production", "staging", "development", "test"].includes(candidate) ? candidate : "unknown",
    version: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(safeVersion) ? safeVersion : "unknown" };
}

function encode(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"'); }
function sample(name: string, value: number, labels: Record<string, string>): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid metric value");
  return `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${encode(v)}"`).join(",")}} ${value}\n`;
}

/** Callers provide static names/help/enum labels, not arbitrary DTOs. */
export function gauge(name: string, help: string, labels: MetricLabels, values: MetricSample[]): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n` + values.map(v => sample(name, v.value, { ...v.labels, ...labels })).join("");
}

export function processMetrics(labels: MetricLabels): string {
  return gauge("pigo_process_uptime_seconds", "Process uptime; resets on restart.", labels, [{ value: process.uptime() }])
    + gauge("pigo_process_resident_memory_bytes", "Process resident memory.", labels, [{ value: process.memoryUsage().rss }]);
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];

/** At most 8 methods * 6 status classes; no URL, path, user or error keys. */
export class ApiMetrics {
  private readonly groups = new Map<string, { method: string; status_class: string; count: number; sum: number; buckets: number[] }>();
  observe(method: string, status: number, seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    method = METHODS.includes(method) ? method : "other";
    const status_class = Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : "other";
    const key = `${method}:${status_class}`;
    const group = this.groups.get(key) ?? { method, status_class, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    group.count++; group.sum += seconds;
    BUCKETS.forEach((limit, i) => { if (seconds <= limit) group.buckets[i]++; });
    this.groups.set(key, group);
  }
  render(labels: MetricLabels): string {
    const rows = [...this.groups.values()].sort((a, b) => `${a.method}:${a.status_class}`.localeCompare(`${b.method}:${b.status_class}`));
    let output = "# HELP pigo_api_requests_total Completed API requests since process start.\n# TYPE pigo_api_requests_total counter\n";
    for (const r of rows) output += sample("pigo_api_requests_total", r.count, { method: r.method, status_class: r.status_class, ...labels });
    output += "# HELP pigo_api_request_duration_seconds Completed API response time; streams count when closed.\n# TYPE pigo_api_request_duration_seconds histogram\n";
    for (const r of rows) {
      const tags = { method: r.method, status_class: r.status_class, ...labels };
      BUCKETS.forEach((limit, i) => { output += sample("pigo_api_request_duration_seconds_bucket", r.buckets[i]!, { ...tags, le: limit === Infinity ? "+Inf" : String(limit) }); });
      output += sample("pigo_api_request_duration_seconds_sum", r.sum, tags) + sample("pigo_api_request_duration_seconds_count", r.count, tags);
    }
    return output;
  }
}
