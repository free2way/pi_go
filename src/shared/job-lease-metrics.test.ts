import { describe, expect, it } from "vitest";
import { JobLeaseMetrics, LEASE_OPERATIONS, LEASE_OUTCOMES, storageStateMetrics } from "./job-lease-metrics.js";
import { operationalLabels } from "./operational-metrics.js";

const labels = operationalLabels("pigo-worker", "v1", { NODE_ENV: "test" });
describe("bounded lease observations", () => {
  it("distinguishes idle polls, successful requests, conflicts and errors without retaining caller data", async () => {
    const m = new JobLeaseMetrics(), value = { id: "private-run", credential: "DUMMY_PRIVATE" };
    expect(await m.track("claim", async () => value)).toBe(value);
    await m.track("lease", async () => [], () => "empty");
    const lost = Object.assign(new Error("DUMMY_PRIVATE"), { code: "JOB_LEASE_LOST" });
    await expect(m.track("heartbeat", async () => { throw lost; })).rejects.toBe(lost);
    const error = new Error("DUMMY_PRIVATE");
    await expect(m.track("finish", async () => { throw error; })).rejects.toBe(error);
    const output = m.render(labels);
    expect(output).toContain('# TYPE pigo_job_lease_operations_total counter');
    expect(output).toContain('operation="claim",outcome="success",service="pigo-worker",environment="test",version="v1"} 1');
    expect(output).toContain('operation="lease",outcome="empty",service="pigo-worker",environment="test",version="v1"} 1');
    expect(output).toContain('pigo_job_lease_lost_total{operation="heartbeat",service="pigo-worker",environment="test",version="v1"} 1');
    expect(output).toContain('pigo_job_lease_lost_total{operation="finish",service="pigo-worker",environment="test",version="v1"} 0');
    expect(output).not.toMatch(/private-run|DUMMY_PRIVATE|credential|run_id|job_id/);
  });
  it("does not allocate labels for arbitrary runtime inputs and resets per process instance", () => {
    const m = new JobLeaseMetrics();
    for (let i = 0; i < 1000; i++) m.observe(`private-${i}` as "claim", "success");
    m.observe("claim", "private-result" as "error");
    const output = m.render(labels);
    expect(output.match(/^pigo_job_lease_operations_total\{/gm)).toHaveLength(LEASE_OPERATIONS.length * LEASE_OUTCOMES.length);
    expect(output).not.toContain("private-");
    m.observe("claim", "conflict");
    expect(new JobLeaseMetrics().render(labels)).toBe(output);
  });
  it.each(["ok", "low", "critical", "unknown", "/private/path"])("exports one-hot storage state without paths: %s", state => {
    const output = storageStateMetrics(labels, state);
    const rows = output.split("\n").filter(s => s.startsWith("pigo_worker_storage_state{"));
    expect(rows).toHaveLength(4);
    expect(rows.filter(s => s.endsWith(" 1"))).toHaveLength(1);
    expect(rows.find(s => s.endsWith(" 1"))).toContain(`state="${state.startsWith("/") ? "unknown" : state}"`);
    expect(output).not.toContain("/private/path");
  });
});
