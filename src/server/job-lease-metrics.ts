import type { FastifyInstance } from "fastify";
import { JobLeaseMetrics } from "../shared/job-lease-metrics.js";

const registries = new WeakMap<FastifyInstance, JobLeaseMetrics>();
export function jobLeaseMetricsFor(app: FastifyInstance): JobLeaseMetrics {
  let metrics = registries.get(app);
  if (!metrics) { metrics = new JobLeaseMetrics(); registries.set(app, metrics); }
  return metrics;
}
