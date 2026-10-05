import { describe, expect, it } from "vitest";
import { buildDeployHookPayload, buildMergeRecord, planMergeGate, planPostMergeDeploy } from "./run-merge.js";

describe("planMergeGate (A2)", () => {
  it("does nothing when the flag is absent", () => {
    expect(planMergeGate({ requested: false, isAdmin: false })).toEqual({ kind: "not-requested" });
  });

  it("refuses a non-admin merge with 403 ADMIN_REQUIRED", () => {
    const gate = planMergeGate({ requested: true, isAdmin: false });
    expect(gate.kind).toBe("forbidden");
    if (gate.kind !== "forbidden") throw new Error("expected forbidden");
    expect(gate.status).toBe(403);
    expect(gate.code).toBe("ADMIN_REQUIRED");
  });

  it("allows an admin merge", () => {
    expect(planMergeGate({ requested: true, isAdmin: true })).toEqual({ kind: "ready" });
  });
});

describe("planPostMergeDeploy (A2)", () => {
  it("reports not configured when unset or blank, never silently skipping", () => {
    expect(planPostMergeDeploy(undefined)).toEqual({ configured: false, reason: expect.stringContaining("hook not configured") });
    expect(planPostMergeDeploy("  ").configured).toBe(false);
  });

  it("recognizes a webhook URL", () => {
    expect(planPostMergeDeploy("https://deploy.example/hook")).toEqual({ configured: true, kind: "webhook", url: "https://deploy.example/hook" });
  });

  it("recognizes a cmd: command", () => {
    expect(planPostMergeDeploy("cmd: ./deploy.sh")).toEqual({ configured: true, kind: "command", command: "./deploy.sh" });
  });

  it("marks an unrecognized value as unsupported instead of skipping", () => {
    const plan = planPostMergeDeploy("./deploy.sh");
    expect(plan.configured).toBe(true);
    expect(plan).toMatchObject({ kind: "unsupported" });
  });
});

describe("buildMergeRecord / buildDeployHookPayload", () => {
  it("persists the merge commit fields", () => {
    expect(buildMergeRecord({ commit: "abc123", strategy: "merge-commit", targetBranch: "main", mergedAt: "2026-01-01T00:00:00.000Z", mergedBy: "admin" })).toEqual({
      commit: "abc123",
      strategy: "merge-commit",
      targetBranch: "main",
      mergedAt: "2026-01-01T00:00:00.000Z",
      mergedBy: "admin",
    });
  });

  it("builds a deploy payload without leaking any credential", () => {
    const payload = buildDeployHookPayload({
      run: { id: "run_1", title: "t", repository: "repo", branch: "pigo/run_1", baseSha: "base" },
      merge: buildMergeRecord({ commit: "c", strategy: "fast-forward", targetBranch: "main", mergedAt: "now", mergedBy: "admin" }),
    });
    expect(payload).toMatchObject({ event: "run.merged", runId: "run_1", targetBranch: "main", commit: "c", strategy: "fast-forward" });
    expect(JSON.stringify(payload)).not.toMatch(/token|key|secret|password/i);
  });

  it("builds an environment-specific release payload with callback metadata", () => {
    const payload = buildDeployHookPayload({
      run: { id: "run_1", title: "t", repository: "repo", branch: "pigo/run_1", baseSha: "base" },
      merge: buildMergeRecord({ commit: "c", strategy: "fast-forward", targetBranch: "main", mergedAt: "now", mergedBy: "admin" }),
      release: { deliveryId: "release_1", environment: "production", attempt: 2, requestedBy: "admin" },
      callbackUrl: "https://pigo.example/api/internal/runs/run_1/release-result",
    });
    expect(payload).toMatchObject({
      event: "run.release_requested",
      deliveryId: "release_1",
      environment: "production",
      attempt: 2,
      callbackUrl: "https://pigo.example/api/internal/runs/run_1/release-result",
    });
  });
});
