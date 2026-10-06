import { describe, expect, it } from "vitest";
import type { AgileRelease } from "../shared/agile.js";
import { AgileService } from "./agile.js";
import { createTestDb } from "./test-db.js";
import type { Db } from "./db.js";
import { runReleaseDeploy, type ReleaseDeployDeps } from "./release-deploy.js";
import type { ReleaseExecutionOutcome } from "./release-execution.js";
import type { PostMergeDeployPlan } from "./run-merge.js";

/**
 * AUD-P1: the confirm path must (a) never double-deploy under concurrency,
 * (b) never record an asynchronous deploy as success prematurely, and (c) allow
 * a retry after a failure/timeout without duplicating side effects. These tests
 * drive the real `runReleaseDeploy` (the route's orchestration) against a real
 * AgileService (pg-mem).
 */

const WEBHOOK: PostMergeDeployPlan = { configured: true, kind: "webhook", url: "https://deploy.example/hook" };

async function seed(db: Db) {
  const service = new AgileService(db);
  const project = await service.createProject("user_a", { name: "结账", key: "PAY" });
  const story = await service.createStory("user_a", { projectId: project.id, title: "支付", status: "done" });
  const release = await service.createRelease("user_a", { projectId: project.id, name: "结账发布", version: "v1.0.0", storyIds: [story.id] });
  const stories = await service.collectReleaseStories(["user_a"], release);
  return { service, release, stories };
}

/** Binds the orchestration deps to a real service + a counting fake transport. */
function deps(service: AgileService, releaseId: string, executions: Array<{ deliveryId: string }>, outcome: ReleaseExecutionOutcome): ReleaseDeployDeps {
  return {
    start: (input) => service.startReleaseDeploy(input),
    settle: (input) => service.settleReleaseDeployResult(input),
    read: () => service.getRelease([], releaseId, true),
    execute: async (_payload, options) => {
      executions.push({ deliveryId: options.deliveryId });
      return outcome;
    },
  };
}

function input(release: AgileRelease, stories: Awaited<ReturnType<AgileService["collectReleaseStories"]>>, overrides: Partial<Parameters<typeof runReleaseDeploy>[0]> = {}) {
  return {
    release,
    stories,
    deployPlan: WEBHOOK,
    retry: false,
    now: "2026-01-02T00:00:00.000Z",
    releasedBy: "admin_1",
    callbackUrl: "https://pigo.example/api/internal/agile/releases/x/release-result",
    webhookToken: "token",
    ...overrides,
  };
}

describe("runReleaseDeploy (audit P1)", () => {
  it("fires two concurrent confirms and executes the deploy exactly once", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const executions: Array<{ deliveryId: string }> = [];
    const d = deps(service, release.id, executions, { configured: true, kind: "webhook", status: "triggered", detail: "HTTP 202；等待部署系统回调", httpStatus: 202 });

    const [first, second] = await Promise.all([
      runReleaseDeploy(input(release, stories), d),
      runReleaseDeploy(input(release, stories), d),
    ]);

    expect(executions).toHaveLength(1);
    expect(executions[0].deliveryId).toBe(`release-publish:${release.id}`);
    const conflicts = [first, second].filter((run) => run.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ status: 409, code: "RELEASE_IN_PROGRESS" });
    const published = [first, second].find((run) => run.kind === "published");
    expect(published).toMatchObject({ kind: "published", deploy: { status: "pending" } });

    const stored = await service.getRelease([], release.id, true);
    expect(stored.deploy).toMatchObject({ status: "pending", deliveryId: `release-publish:${release.id}`, attempt: 1 });

    // The single execution is backed by exactly one persisted claim record.
    const claims = await db.query("SELECT attempt, idempotency_key FROM agile_release_deploy_claims WHERE release_id = $1", [release.id]);
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({ attempt: 1, idempotency_key: `release-publish:${release.id}#1` });
  });

  it("records an HTTP 202 as pending, never as premature success, until the callback settles it", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const executions: Array<{ deliveryId: string }> = [];
    const d = deps(service, release.id, executions, { configured: true, kind: "webhook", status: "triggered", detail: "HTTP 202；等待部署系统回调", httpStatus: 202 });

    const run = await runReleaseDeploy(input(release, stories), d);
    expect(run).toMatchObject({ kind: "published", deploy: { status: "pending" } });
    expect((await service.getRelease([], release.id, true)).deploy?.status).toBe("pending");

    const settled = await service.settleReleaseDeployResult({
      releaseId: release.id,
      action: "release.deploy_succeeded",
      actorId: "deploy-system",
      now: "2026-01-02T00:05:00.000Z",
      deploy: { status: "ok", detail: "部署系统回调：成功", at: "2026-01-02T00:05:00.000Z", finishedAt: "2026-01-02T00:05:00.000Z", deliveryId: `release-publish:${release.id}`, attempt: 1 },
    });
    expect(settled.applied).toBe(true);
    expect(settled.release.deploy).toMatchObject({ status: "ok" });
  });

  it("records a failed deploy and retries it as a new attempt with the same delivery id", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const executions: Array<{ deliveryId: string }> = [];
    let outcome: ReleaseExecutionOutcome = { configured: true, kind: "webhook", status: "failed", detail: "HTTP 503", httpStatus: 503 };
    const d = deps(service, release.id, executions, outcome);
    d.execute = async (_payload, options) => {
      executions.push({ deliveryId: options.deliveryId });
      return outcome;
    };

    const failed = await runReleaseDeploy(input(release, stories), d);
    expect(failed).toMatchObject({ kind: "published", deploy: { status: "failed", detail: "HTTP 503", attempt: 1 } });

    // Without an explicit retry the failed deploy is not silently re-run.
    const refused = await runReleaseDeploy(input(await service.getRelease([], release.id, true), stories), d);
    expect(refused).toMatchObject({ kind: "conflict", code: "RELEASE_RETRY_REQUIRED" });
    expect(executions).toHaveLength(1);

    // An explicit retry starts attempt 2, reusing the delivery id so the receiver
    // can de-duplicate, and succeeds.
    outcome = { configured: true, kind: "webhook", status: "succeeded", detail: "HTTP 200", httpStatus: 200 };
    const retried = await runReleaseDeploy(
      input(await service.getRelease([], release.id, true), stories, { retry: true, now: "2026-01-02T00:01:00.000Z" }),
      d,
    );
    expect(executions).toHaveLength(2);
    expect(executions[1].deliveryId).toBe(executions[0].deliveryId);
    expect(retried).toMatchObject({ kind: "published", deploy: { status: "ok", attempt: 2 } });

    const claims = await db.query("SELECT attempt FROM agile_release_deploy_claims WHERE release_id = $1 ORDER BY attempt", [release.id]);
    expect(claims.rows.map((row) => Number(row.attempt))).toEqual([1, 2]);
  });

  it("records a timed-out attempt as failed and only then allows an explicit retry", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const executions: Array<{ deliveryId: string }> = [];
    const d = deps(service, release.id, executions, { configured: true, kind: "webhook", status: "triggered", detail: "HTTP 202", httpStatus: 202 });

    await runReleaseDeploy(input(release, stories), d);
    expect(executions).toHaveLength(1);

    const pending = await service.getRelease([], release.id, true);
    const later = new Date(Date.parse(pending.deploy!.startedAt!) + 5 * 60_000 + 1).toISOString();

    const timedOut = await runReleaseDeploy(input(pending, stories, { now: later }), d);
    expect(timedOut).toMatchObject({ kind: "conflict", code: "RELEASE_DEPLOY_TIMEOUT" });
    expect(executions).toHaveLength(1);

    const retried = await runReleaseDeploy(input(await service.getRelease([], release.id, true), stories, { retry: true, now: later }), d);
    expect(executions).toHaveLength(2);
    expect(retried).toMatchObject({ kind: "published", deploy: { status: "pending", attempt: 2 } });

    const audit = await db.query("SELECT action FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(audit.rows.map((row) => row.action)).toContain("release.deploy_failed");
  });

  it("rejects a late callback for attempt 1 after attempt 2 started and leaves attempt 2 intact", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const deliveryId = `release-publish:${release.id}`;
    const t0 = "2026-01-02T00:00:00.000Z";
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId,
      attempt: 1,
      releasedBy: "admin_1",
      releasedAt: t0,
      stories,
      deploy: { status: "pending", detail: "HTTP 202", at: t0, startedAt: t0, deliveryId, attempt: 1 },
    });

    // Attempt 1 times out (bounded verification) and attempt 2 starts, reusing
    // the delivery id — exactly the state a stale callback can race against.
    const t1 = new Date(Date.parse(t0) + 5 * 60_000 + 1).toISOString();
    await service.expireStaleReleaseDeploys({ now: t1, timeoutMs: 5 * 60_000 });
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId,
      attempt: 2,
      releasedBy: "admin_1",
      releasedAt: t1,
      stories,
      deploy: { status: "pending", detail: "HTTP 202", at: t1, startedAt: t1, deliveryId, attempt: 2 },
    });

    // A late callback for attempt 1 must not settle attempt 2.
    const stale = await service.settleReleaseDeployResult({
      releaseId: release.id,
      action: "release.deploy_succeeded",
      actorId: "deploy-system",
      deploy: { status: "ok", detail: "attempt 1 late callback", at: t1, finishedAt: t1, deliveryId, attempt: 1 },
    });
    expect(stale.applied).toBe(false);
    expect(stale.rejected).toBe("stale_attempt");
    expect((await service.getRelease([], release.id, true)).deploy).toMatchObject({ status: "pending", attempt: 2, deliveryId });
    const auditAfterStale = await db.query("SELECT action FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(auditAfterStale.rows.map((row) => row.action)).not.toContain("release.deploy_succeeded");

    // The current attempt (2) settles normally afterwards.
    const ok = await service.settleReleaseDeployResult({
      releaseId: release.id,
      action: "release.deploy_succeeded",
      actorId: "deploy-system",
      deploy: { status: "ok", detail: "attempt 2 callback", at: t1, finishedAt: t1, deliveryId, attempt: 2 },
    });
    expect(ok.applied).toBe(true);
    expect(ok.release.deploy).toMatchObject({ status: "ok", attempt: 2 });
  });

  it("is idempotent for a duplicate callback on the current attempt", async () => {
    const db = await createTestDb();
    const { service, release, stories } = await seed(db);
    const deliveryId = `release-publish:${release.id}`;
    const t0 = "2026-01-02T00:00:00.000Z";
    await service.startReleaseDeploy({
      releaseId: release.id,
      deliveryId,
      attempt: 1,
      releasedBy: "admin_1",
      releasedAt: t0,
      stories,
      deploy: { status: "pending", detail: "HTTP 202", at: t0, startedAt: t0, deliveryId, attempt: 1 },
    });

    const settle = {
      releaseId: release.id,
      action: "release.deploy_succeeded" as const,
      actorId: "deploy-system",
      deploy: { status: "ok" as const, detail: "部署系统回调：成功", at: t0, finishedAt: t0, deliveryId, attempt: 1 },
    };
    expect((await service.settleReleaseDeployResult(settle)).applied).toBe(true);
    const duplicate = await service.settleReleaseDeployResult(settle);
    expect(duplicate.applied).toBe(false);
    expect(duplicate.rejected).toBe("not_pending");
    expect(duplicate.release.deploy).toMatchObject({ status: "ok", attempt: 1 });

    // Exactly one successful settlement row — the duplicate wrote nothing.
    const audit = await db.query("SELECT action FROM agile_release_audit WHERE release_id = $1", [release.id]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(["release.deploy_succeeded", "release.published"]);
  });
});
