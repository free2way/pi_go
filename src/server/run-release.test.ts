import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types.js";
import { isActiveRelease, planReleaseStart, releaseDeliveryId, sameReleaseAttempt } from "./run-release.js";

const NOW = "2026-10-05T03:00:00.000Z";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ownerId: "owner_1",
    title: "release",
    task: "release tested code",
    repository: "repo",
    branch: "pigo/run_1",
    mode: "real",
    state: "completed",
    round: 1,
    maxRounds: 3,
    createdAt: NOW,
    updatedAt: NOW,
    developer: { provider: "deepseek", model: "dev" },
    reviewer: { provider: "openai", model: "review" },
    checks: [],
    findings: [],
    diff: "",
    summary: "done",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 1,
    lastSeq: 1,
    merge: { commit: "abc123", strategy: "fast-forward", targetBranch: "main", mergedAt: NOW, mergedBy: "admin" },
    ...overrides,
  };
}

describe("releaseDeliveryId", () => {
  it("is stable for the same run/commit/environment and changes by environment", () => {
    expect(releaseDeliveryId("r", "c", "prod")).toBe(releaseDeliveryId("r", "c", "prod"));
    expect(releaseDeliveryId("r", "c", "prod")).not.toBe(releaseDeliveryId("r", "c", "staging"));
  });
});

describe("planReleaseStart", () => {
  it("allows a successful staging deployment to promote the same commit to production", () => {
    const staging = planReleaseStart({ run: run(), environment: "staging", requestedBy: "admin", now: NOW, kind: "webhook" });
    expect(staging.kind).toBe("ready");
    const succeeded = { ...(staging as Extract<typeof staging, { kind: "ready" }>).release, status: "succeeded" as const };
    const promoted = planReleaseStart({ run: run({ release: succeeded }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:10:00.000Z", kind: "webhook" });
    expect(promoted).toMatchObject({ kind: "ready", release: { environment: "production", attempt: 1 } });
    if (promoted.kind === "ready") expect(promoted.release.deliveryId).not.toBe(succeeded.deliveryId);
  });
  it("requires a completed, merged run", () => {
    expect(planReleaseStart({ run: run({ state: "reviewing" }), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" })).toMatchObject({ kind: "conflict", code: "RUN_NOT_RELEASE_READY" });
    expect(planReleaseStart({ run: run({ merge: undefined }), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" })).toMatchObject({ kind: "conflict", code: "MERGE_REQUIRED" });
  });

  it("creates a durable first attempt", () => {
    const decision = planReleaseStart({ run: run(), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" });
    expect(decision).toMatchObject({ kind: "ready", release: { status: "publishing", environment: "production", commit: "abc123", attempt: 1 } });
  });

  it("returns a successful identical release idempotently", () => {
    const release = {
      deliveryId: "release_1",
      status: "succeeded" as const,
      environment: "production",
      commit: "abc123",
      targetBranch: "main",
      requestedAt: NOW,
      requestedBy: "admin",
      startedAt: NOW,
      finishedAt: NOW,
      attempt: 1,
      kind: "webhook" as const,
    };
    expect(planReleaseStart({ run: run({ release }), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" })).toEqual({ kind: "already-succeeded", release });
  });

  it("requires explicit retry after failure and reuses the delivery id", () => {
    const release = {
      deliveryId: "release_stable",
      status: "failed" as const,
      environment: "production",
      commit: "abc123",
      targetBranch: "main",
      requestedAt: NOW,
      requestedBy: "admin",
      startedAt: NOW,
      finishedAt: NOW,
      attempt: 1,
      kind: "webhook" as const,
    };
    expect(planReleaseStart({ run: run({ release }), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" })).toMatchObject({ kind: "conflict", code: "RELEASE_RETRY_REQUIRED" });
    expect(planReleaseStart({ run: run({ release }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:01:00.000Z", kind: "webhook", retry: true })).toMatchObject({
      kind: "ready",
      release: { deliveryId: "release_stable", attempt: 2, status: "publishing" },
    });
  });

  it("only retries a publishing attempt after it is stale", () => {
    const first = planReleaseStart({ run: run(), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" });
    if (first.kind !== "ready") throw new Error("expected ready");
    expect(planReleaseStart({ run: run({ release: first.release }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:01:00.000Z", kind: "webhook", retry: true })).toMatchObject({ kind: "conflict", code: "RELEASE_IN_PROGRESS" });
    expect(planReleaseStart({ run: run({ release: first.release }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:03:00.000Z", kind: "webhook", retry: true })).toMatchObject({ kind: "ready", release: { attempt: 2, deliveryId: first.release.deliveryId } });
  });

  it("can recover a lost asynchronous callback with the same delivery id", () => {
    const triggered = {
      deliveryId: "release_async",
      status: "triggered" as const,
      environment: "production",
      commit: "abc123",
      targetBranch: "main",
      requestedAt: NOW,
      requestedBy: "admin",
      startedAt: NOW,
      attempt: 1,
      kind: "webhook" as const,
    };
    expect(planReleaseStart({ run: run({ release: triggered }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:01:00.000Z", kind: "webhook", retry: true })).toMatchObject({ kind: "conflict", code: "RELEASE_AWAITING_RESULT" });
    expect(planReleaseStart({ run: run({ release: triggered }), environment: "production", requestedBy: "admin", now: "2026-10-05T03:03:00.000Z", kind: "webhook", retry: true })).toMatchObject({ kind: "ready", release: { deliveryId: "release_async", attempt: 2 } });
  });
});

describe("sameReleaseAttempt", () => {
  it("matches only the publishing attempt that owns the result", () => {
    const planned = planReleaseStart({ run: run(), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" });
    if (planned.kind !== "ready") throw new Error("expected ready");
    expect(sameReleaseAttempt(run({ release: planned.release }), planned.release)).toBe(true);
    expect(sameReleaseAttempt(run({ release: { ...planned.release, attempt: 2 } }), planned.release)).toBe(false);
    expect(sameReleaseAttempt(run({ release: { ...planned.release, status: "failed" } }), planned.release)).toBe(false);
  });
});

describe("isActiveRelease", () => {
  it("protects publishing/triggered runs from reopen or cleanup", () => {
    const planned = planReleaseStart({ run: run(), environment: "production", requestedBy: "admin", now: NOW, kind: "webhook" });
    if (planned.kind !== "ready") throw new Error("expected ready");
    expect(isActiveRelease(run({ release: planned.release }))).toBe(true);
    expect(isActiveRelease(run({ release: { ...planned.release, status: "triggered" } }))).toBe(true);
    expect(isActiveRelease(run({ release: { ...planned.release, status: "failed" } }))).toBe(false);
  });
});
