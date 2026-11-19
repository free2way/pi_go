import { counter, gauge, type MetricLabels } from "./operational-metrics.js";

export const LEASE_OPERATIONS = ["lease", "claim", "heartbeat", "release", "finish", "callback"] as const;
export type LeaseOperation = typeof LEASE_OPERATIONS[number];
export const LEASE_OUTCOMES = ["success", "empty", "conflict", "error"] as const;
export type LeaseOutcome = typeof LEASE_OUTCOMES[number];

/** Process-local observations; static enums only, no job/run/request labels. */
export class JobLeaseMetrics {
  private readonly counts = new Map<string, number>();
  observe(operation: LeaseOperation, outcome: LeaseOutcome) {
    if (!LEASE_OPERATIONS.includes(operation) || !LEASE_OUTCOMES.includes(outcome)) return;
    const key = `${operation}:${outcome}`;
    this.counts.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.counts.get(key) ?? 0) + 1));
  }
  async track<T>(operation: LeaseOperation, action: () => Promise<T>, classify: (value: T) => LeaseOutcome = () => "success"): Promise<T> {
    try {
      const value = await action();
      this.observe(operation, classify(value));
      return value;
    } catch (error) {
      this.observe(operation, (error as { code?: unknown })?.code === "JOB_LEASE_LOST" ? "conflict" : "error");
      throw error;
    }
  }
  render(labels: MetricLabels): string {
    const operations = LEASE_OPERATIONS.flatMap(operation => LEASE_OUTCOMES.map(outcome => ({
      value: this.counts.get(`${operation}:${outcome}`) ?? 0, labels: { operation, outcome },
    })));
    const lost = LEASE_OPERATIONS.map(operation => ({ value: this.counts.get(`${operation}:conflict`) ?? 0, labels: { operation } }));
    return counter("pigo_job_lease_operations_total", "Lease operations and lease-fenced callbacks observed by this process; resets on restart.", labels, operations)
      + counter("pigo_job_lease_lost_total", "JOB_LEASE_LOST outcomes observed by this process; resets on restart.", labels, lost);
  }
}

export function storageStateMetrics(labels: MetricLabels, state: string): string {
  const states = ["ok", "low", "critical", "unknown"];
  const current = states.includes(state) ? state : "unknown";
  return gauge("pigo_worker_storage_state", "Latest workspace storage observation; exactly one state is set.", labels,
    states.map(value => ({ value: Number(value === current), labels: { state: value } })));
}
