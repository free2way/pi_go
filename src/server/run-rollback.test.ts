import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { buildRollbackPayload, planRollbackStart, rollbackDeliveryId, sameRollbackAttempt } from "./run-rollback";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-10-12T01:00:00.000Z";
const baseRun = (): Run => ({
  id: "run_1", ownerId: "owner", title: "Release", task: "task", repository: "apps/repo", branch: "run/1", mode: "real",
  state: "completed", round: 1, maxRounds: 3, createdAt: NOW, updatedAt: NOW,
  developer: { provider: "openai", model: "dev" }, reviewer: { provider: "openai", model: "review" },
  checks: [], findings: [], diff: "", summary: "", usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, durationMs: 0, lastSeq: 0,
  release: {
    deliveryId: "release_1", status: "succeeded", environment: "production", commit: "1".repeat(40), targetBranch: "main",
    requestedAt: NOW, requestedBy: "admin", startedAt: NOW, finishedAt: NOW, attempt: 1, kind: "webhook",
    image: "local/app:commit", imageDigest: DIGEST,
  },
});

describe("production rollback planning", () => {
  it("derives the immutable target from a successful production release", () => {
    const run = baseRun();
    const plan = planRollbackStart({ run, requestedBy: "admin", reason: "incident 42", now: NOW });
    expect(plan).toMatchObject({ kind: "ready", rollback: { commit: run.release!.commit, image: run.release!.image, imageDigest: DIGEST, attempt: 1, reason: "incident 42" } });
    if (plan.kind !== "ready") throw new Error("expected ready");
    expect(buildRollbackPayload({ run, rollback: plan.rollback, callbackUrl: "https://pigo.example/api/internal/runs/run_1/rollback-result" })).toMatchObject({
      event: "run.rollback_requested", environment: "production", commit: run.release!.commit, expectedImageDigest: DIGEST,
    });
  });

  it("rejects staging and mutable production targets", () => {
    const staging = baseRun();
    staging.release = { ...staging.release!, environment: "staging" };
    expect(planRollbackStart({ run: staging, requestedBy: "admin", reason: "reason", now: NOW })).toMatchObject({ code: "ROLLBACK_TARGET_NOT_PRODUCTION" });
    const mutable = baseRun();
    mutable.release = { ...mutable.release!, imageDigest: "latest" };
    expect(planRollbackStart({ run: mutable, requestedBy: "admin", reason: "reason", now: NOW })).toMatchObject({ code: "ROLLBACK_EVIDENCE_REQUIRED" });
  });

  it("requires an explicit retry and preserves identity while incrementing attempt", () => {
    const run = baseRun();
    run.rollback = {
      deliveryId: "rollback_existing", status: "failed", environment: "production", commit: run.release!.commit,
      image: run.release!.image!, imageDigest: DIGEST, requestedAt: NOW, requestedBy: "admin", startedAt: NOW,
      finishedAt: NOW, attempt: 1, reason: "first",
    };
    expect(planRollbackStart({ run, requestedBy: "admin", reason: "retry", now: NOW })).toMatchObject({ code: "ROLLBACK_RETRY_REQUIRED" });
    const retry = planRollbackStart({ run, requestedBy: "admin", reason: "retry", now: NOW, retry: true });
    expect(retry).toMatchObject({ kind: "ready", rollback: { deliveryId: "rollback_existing", attempt: 2 } });
    if (retry.kind === "ready") expect(sameRollbackAttempt({ ...run, rollback: retry.rollback }, retry.rollback)).toBe(true);
  });

  it("generates stable target-scoped delivery ids", () => {
    expect(rollbackDeliveryId("run_1", "1".repeat(40), DIGEST)).toBe(rollbackDeliveryId("run_1", "1".repeat(40), DIGEST));
    expect(rollbackDeliveryId("run_1", "1".repeat(40), DIGEST)).not.toBe(rollbackDeliveryId("run_2", "1".repeat(40), DIGEST));
  });
});
