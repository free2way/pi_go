import { describe, expect, it } from "vitest";
import type { AgileRelease, ReleaseDeployRecord } from "../shared/agile.js";
import {
  buildReleaseDeployPayload,
  isReleasePublishTerminal,
  planReleaseDeployAttempt,
  planReleaseDeployCallback,
  planReleasePublish,
  planReleasePublishGate,
  releaseDeployDeliveryId,
  shapeReleaseDeployOutcome,
  RELEASE_DEPLOY_STALE_MS,
  type ReleasePublishStory,
} from "./release-publish.js";

function story(overrides: Partial<ReleasePublishStory> = {}): ReleasePublishStory {
  return {
    storyId: "story_1",
    title: "故事一",
    status: "done",
    runState: "completed",
    runId: "run_1",
    checkPassed: true,
    checks: [{ name: "lint", command: "npm run lint", status: "passed" }],
    findings: [],
    criteria: ["结账成功"],
    diffFiles: ["src/pay.ts"],
    mergedCommit: "abc1234",
    ...overrides,
  };
}

function release(overrides: Partial<AgileRelease> = {}): AgileRelease {
  return {
    id: "release_1",
    projectId: "proj_1",
    ownerId: "user_a",
    name: "结账",
    version: "v1.2.0",
    notes: "",
    status: "planned",
    storyIds: ["story_1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deploy: null,
    ...overrides,
  };
}

const NOW = "2026-01-01T00:00:00.000Z";

describe("planReleasePublish", () => {
  it("reports RELEASE_EMPTY when the release has no stories", () => {
    expect(planReleasePublish({ stories: [], label: "发布「v1」" })).toMatchObject({
      kind: "empty",
      status: 409,
      code: "RELEASE_EMPTY",
    });
  });

  it("lists every blocked story (with a fallback reason) and answers 409", () => {
    const plan = planReleasePublish({
      stories: [
        story({ storyId: "s1", title: "阻塞一", status: "blocked", reason: "等待上游接口" }),
        story({ storyId: "s2", title: "阻塞二", status: "blocked", reason: "   " }),
        story({ storyId: "s3", title: "完成", status: "done" }),
      ],
    });
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") throw new Error("expected blocked");
    expect(plan.status).toBe(409);
    expect(plan.code).toBe("RELEASE_BLOCKED");
    expect(plan.blocked.map((entry) => entry.storyId)).toEqual(["s1", "s2"]);
    expect(plan.blocked[0].reason).toBe("等待上游接口");
    expect(plan.blocked[1].reason).toBe("阻塞（无原因说明）");
  });

  it("is ready when every story has a completed run, passing checks, no blocking findings and a merged commit", () => {
    expect(planReleasePublish({ stories: [story(), story({ storyId: "s2", status: "awaiting_acceptance" })] })).toEqual({ kind: "ready" });
  });

  it("reports RELEASE_NOT_READY for a story with no linked run", () => {
    const plan = planReleasePublish({ stories: [story({ storyId: "s_missing", runId: null, runState: null })] });
    expect(plan).toMatchObject({ kind: "not_ready", status: 409, code: "RELEASE_NOT_READY" });
    if (plan.kind !== "not_ready") throw new Error("expected not_ready");
    expect(plan.stories.map((entry) => entry.storyId)).toEqual(["s_missing"]);
    expect(plan.stories[0].reason).toContain("没有关联的运行");
  });

  it("reports RELEASE_NOT_READY for a run that is not a terminal success", () => {
    for (const runState of ["developing", "needs_human", "failed", "cancelled"] as const) {
      const plan = planReleasePublish({ stories: [story({ runState })] });
      expect(plan).toMatchObject({ kind: "not_ready", code: "RELEASE_NOT_READY" });
      if (plan.kind !== "not_ready") throw new Error("expected not_ready");
      expect(plan.stories[0].runState).toBe(runState);
    }
  });

  it("reports RELEASE_CHECKS_FAILED when the run's checks did not pass or cannot be proven to pass", () => {
    expect(planReleasePublish({ stories: [story({ checkPassed: false })] })).toMatchObject({ kind: "checks_failed", code: "RELEASE_CHECKS_FAILED" });
    expect(planReleasePublish({ stories: [story({ checkPassed: true, checks: [{ name: "lint", status: "failed" }] })] })).toMatchObject({ kind: "checks_failed", code: "RELEASE_CHECKS_FAILED" });
    // No positive evidence (no checkPassed, no checks) is fail-safe.
    expect(planReleasePublish({ stories: [story({ checkPassed: null, checks: [] })] })).toMatchObject({ kind: "checks_failed", code: "RELEASE_CHECKS_FAILED" });
  });

  it("reports RELEASE_BLOCKED for an unresolved critical finding even when the story is not blocked", () => {
    const plan = planReleasePublish({
      stories: [story({ findings: [{ id: "f1", severity: "critical", title: "注入漏洞", resolved: false }] })],
    });
    expect(plan).toMatchObject({ kind: "blocked", status: 409, code: "RELEASE_BLOCKED" });
    if (plan.kind !== "blocked") throw new Error("expected blocked");
    expect(plan.blocked).toEqual([]);
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]).toMatchObject({ storyId: "story_1", severity: "critical", title: "注入漏洞" });
  });

  it("fails safe on an unresolved high whose irrelevance cannot be proven", () => {
    const plan = planReleasePublish({
      stories: [story({ findings: [{ id: "f2", severity: "high", title: "未知模块缺陷", resolved: false }] })],
    });
    expect(plan).toMatchObject({ kind: "blocked", code: "RELEASE_BLOCKED" });
  });

  it("reports RELEASE_NOT_MERGED when requireMergedCommit is set and no commit is merged", () => {
    const plan = planReleasePublish({ stories: [story({ mergedCommit: null })] });
    expect(plan).toMatchObject({ kind: "not_merged", status: 409, code: "RELEASE_NOT_MERGED" });
    if (plan.kind !== "not_merged") throw new Error("expected not_merged");
    expect(plan.stories).toEqual([{ storyId: "story_1", title: "故事一", runId: "run_1" }]);

    // Policy off: the same story is publishable without a merged commit.
    expect(planReleasePublish({ stories: [story({ mergedCommit: null })], requireMergedCommit: false })).toEqual({ kind: "ready" });
  });
});

describe("shapeReleaseDeployOutcome", () => {
  it("records not_configured when the hook is unset", () => {
    const outcome = shapeReleaseDeployOutcome({ configured: false, reason: "hook not configured" }, undefined, "2026-01-01T00:00:00.000Z");
    expect(outcome).toEqual({ status: "not_configured", detail: "hook not configured", at: "2026-01-01T00:00:00.000Z" });
  });

  it("records unsupported for a malformed hook", () => {
    const outcome = shapeReleaseDeployOutcome(
      { configured: true, kind: "unsupported", reason: "deploy hook must be an http(s) URL or a `cmd:` command" },
      undefined,
      "2026-01-01T00:00:00.000Z",
    );
    expect(outcome.status).toBe("unsupported");
  });

  it("records a confirmed synchronous success as ok", () => {
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      { configured: true, kind: "webhook", status: "succeeded", detail: "HTTP 200", httpStatus: 200 },
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "ok", detail: "HTTP 200" });
  });

  it("maps an asynchronous (HTTP 202) execution to pending, never a premature ok", () => {
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "command", command: "deploy.sh" },
      { configured: true, kind: "command", status: "triggered", detail: "HTTP 202；等待部署系统回调" },
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "pending", detail: "HTTP 202；等待部署系统回调" });
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      { configured: true, kind: "webhook", status: "triggered", detail: "HTTP 202；等待部署系统回调", httpStatus: 202 },
      "2026-01-01T00:00:00.000Z",
      { deliveryId: "release-publish:release_1", attempt: 2 },
    )).toMatchObject({ status: "pending", deliveryId: "release-publish:release_1", attempt: 2, startedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("never silently skips a configured-but-failing hook", () => {
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      { configured: true, kind: "webhook", status: "failed", detail: "HTTP 503", httpStatus: 503 },
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "failed", detail: "HTTP 503" });
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      undefined,
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "failed" });
  });
});

describe("buildReleaseDeployPayload", () => {
  it("carries the exact delivery id + attempt so the callback can be matched", () => {
    const payload = buildReleaseDeployPayload({
      release: { id: "rel_1", projectId: "proj_1", name: "结账", version: "v1.2.0" },
      stories: [{ storyId: "s1", title: "故事一", status: "done" }],
      releasedAt: "2026-01-01T00:00:00.000Z",
      releasedBy: "user_a",
      environment: "staging",
      deliveryId: "release-publish:rel_1",
      attempt: 2,
    });
    expect(payload).toMatchObject({ deliveryId: "release-publish:rel_1", attempt: 2 });
  });

  it("shapes the release publish payload with stories and actor", () => {
    const payload = buildReleaseDeployPayload({
      release: { id: "rel_1", projectId: "proj_1", name: "结账", version: "v1.2.0" },
      stories: [
        { storyId: "s1", title: "故事一", status: "done" },
        { storyId: "s2", title: "故事二", status: "awaiting_acceptance" },
      ],
      releasedAt: "2026-01-01T00:00:00.000Z",
      releasedBy: "user_a",
      environment: "staging",
      note: "  首次发布  ",
    });
    expect(payload).toEqual({
      event: "release.published",
      releaseId: "rel_1",
      projectId: "proj_1",
      name: "结账",
      version: "v1.2.0",
      releasedAt: "2026-01-01T00:00:00.000Z",
      releasedBy: "user_a",
      environment: "staging",
      note: "首次发布",
      stories: [
        { storyId: "s1", title: "故事一", status: "done" },
        { storyId: "s2", title: "故事二", status: "awaiting_acceptance" },
      ],
    });
  });
});

describe("planReleasePublishGate (release.requireAdmin)", () => {
  it("refuses a non-admin with 403 ADMIN_REQUIRED, even for the release owner", () => {
    const gate = planReleasePublishGate({ isAdmin: false });
    expect(gate.kind).toBe("forbidden");
    if (gate.kind !== "forbidden") throw new Error("expected forbidden");
    expect(gate.status).toBe(403);
    expect(gate.code).toBe("ADMIN_REQUIRED");
    expect(gate.message).toBe("仅管理员可以发布代码");
  });

  it("allows an admin", () => {
    expect(planReleasePublishGate({ isAdmin: true })).toEqual({ kind: "ready" });
  });
});

describe("planReleaseDeployAttempt", () => {
  it("starts the first attempt for an unpublished release", () => {
    expect(planReleaseDeployAttempt({ release: release(), environment: "staging", now: NOW })).toEqual({
      kind: "ready",
      deliveryId: "release-publish:release_1:staging",
      attempt: 1,
    });
  });

  it("is terminal for an ok / not-configured / no-deploy release", () => {
    for (const deploy of [null, { status: "ok", detail: "HTTP 200", at: NOW }, { status: "not_configured", detail: "未配置", at: NOW }]) {
      const decision = planReleaseDeployAttempt({ release: release({ status: "released", deploy: deploy as never }), environment: "staging", now: NOW });
      expect(decision).toMatchObject({ kind: "conflict", status: 409, code: "RELEASE_RELEASED" });
    }
    expect(isReleasePublishTerminal(release({ status: "released", deploy: null }))).toBe(true);
    expect(isReleasePublishTerminal(release({ status: "released", deploy: { status: "failed", detail: "HTTP 503", at: NOW } }))).toBe(false);
  });

  it("requires an explicit retry after a failed deploy", () => {
    const failed = release({ status: "released", deploy: { status: "failed", detail: "HTTP 503", at: NOW, deliveryId: "release-publish:release_1", attempt: 1 } });
    expect(planReleaseDeployAttempt({ release: failed, environment: "staging", now: NOW })).toMatchObject({ kind: "conflict", status: 409, code: "RELEASE_RETRY_REQUIRED" });
    expect(planReleaseDeployAttempt({ release: failed, environment: "staging", retry: true, now: NOW })).toEqual({ kind: "ready", deliveryId: "release-publish:release_1", attempt: 2 });
  });

  it("allows a successful staging release to promote to production with a new delivery id", () => {
    const staged = release({
      status: "released",
      deploy: { status: "ok", environment: "staging", detail: "HTTP 200", at: NOW, deliveryId: "release-publish:release_1:staging", attempt: 1 },
    });
    expect(isReleasePublishTerminal(staged, "production")).toBe(false);
    expect(planReleaseDeployAttempt({ release: staged, environment: "production", now: NOW })).toEqual({
      kind: "ready",
      deliveryId: "release-publish:release_1:production",
      attempt: 2,
    });
  });

  it("continues the release-wide attempt sequence when staging was retried before promotion", () => {
    const staged = release({
      status: "released",
      deploy: { status: "ok", environment: "staging", detail: "HTTP 200", at: NOW, deliveryId: "release-publish:release_1:staging", attempt: 3 },
    });
    expect(planReleaseDeployAttempt({ release: staged, environment: "production", now: NOW })).toMatchObject({
      kind: "ready",
      deliveryId: "release-publish:release_1:production",
      attempt: 4,
    });
  });

  it("keeps a fresh pending attempt pending and refuses a premature retry", () => {
    const pending = release({ status: "released", deploy: { status: "pending", detail: "HTTP 202", at: NOW, startedAt: NOW, attempt: 1 } });
    expect(planReleaseDeployAttempt({ release: pending, environment: "staging", now: NOW })).toMatchObject({ kind: "conflict", code: "RELEASE_AWAITING_RESULT" });
    expect(planReleaseDeployAttempt({ release: pending, environment: "staging", retry: true, now: NOW })).toMatchObject({ kind: "conflict", code: "RELEASE_IN_PROGRESS" });
  });

  it("times a pending attempt out (bounded verification) and reports it as expired for retry", () => {
    const started = "2026-01-01T00:00:00.000Z";
    const timedOut = release({
      status: "released",
      deploy: { status: "pending", detail: "HTTP 202", at: started, startedAt: started, deliveryId: "release-publish:release_1", attempt: 1 },
    });
    const later = new Date(Date.parse(started) + RELEASE_DEPLOY_STALE_MS + 1).toISOString();
    expect(planReleaseDeployAttempt({ release: timedOut, environment: "staging", now: later })).toMatchObject({ kind: "conflict", code: "RELEASE_DEPLOY_TIMEOUT" });
    const decision = planReleaseDeployAttempt({ release: timedOut, environment: "staging", retry: true, now: later });
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") throw new Error("expected ready");
    expect(decision.attempt).toBe(2);
    expect(decision.expired).toMatchObject({ status: "failed", finishedAt: later });
    expect(decision.expired?.detail).toContain("超时");
  });
});

describe("releaseDeployDeliveryId", () => {
  it("is stable for a release so a retry can be de-duplicated by the receiver", () => {
    expect(releaseDeployDeliveryId("release_1", "staging")).toBe("release-publish:release_1:staging");
    expect(releaseDeployDeliveryId("release_1", "staging")).toBe(releaseDeployDeliveryId("release_1", "staging"));
    expect(releaseDeployDeliveryId("release_1", "staging")).not.toBe(releaseDeployDeliveryId("release_1", "production"));
  });
});

describe("planReleaseDeployCallback (old-attempt isolation)", () => {
  const deliveryId = "release-publish:release_1";
  function pending(overrides: Partial<ReleaseDeployRecord> = {}): ReleaseDeployRecord {
    return { status: "pending", detail: "HTTP 202", at: NOW, startedAt: NOW, deliveryId, attempt: 2, ...overrides };
  }

  it("rejects a callback for a previous attempt with RELEASE_ATTEMPT_STALE and audits it", () => {
    const plan = planReleaseDeployCallback({ current: pending(), deliveryId, attempt: 1, status: "succeeded", now: NOW });
    expect(plan).toMatchObject({ kind: "reject", status: 409, code: "RELEASE_ATTEMPT_STALE", audit: true, attempt: 2 });
  });

  it("rejects a callback that omits the attempt (cannot prove it is for the current one)", () => {
    const plan = planReleaseDeployCallback({ current: pending(), deliveryId, attempt: undefined, status: "succeeded", now: NOW });
    expect(plan).toMatchObject({ kind: "reject", code: "RELEASE_ATTEMPT_STALE", audit: true });
  });

  it("rejects a foreign delivery id with RELEASE_DELIVERY_MISMATCH and no audit", () => {
    const plan = planReleaseDeployCallback({ current: pending(), deliveryId, attempt: 2, status: "succeeded", now: NOW });
    expect(plan.kind).toBe("settle");
    const mismatch = planReleaseDeployCallback({ current: pending(), deliveryId: "release-publish:other", attempt: 2, status: "succeeded", now: NOW });
    expect(mismatch).toMatchObject({ kind: "reject", code: "RELEASE_DELIVERY_MISMATCH", audit: false });
  });

  it("settles only the current pending attempt, shaping the final record", () => {
    const plan = planReleaseDeployCallback({ current: pending(), deliveryId, attempt: 2, status: "failed", detail: "HTTP 500", now: "2026-01-02T00:01:00.000Z" });
    expect(plan).toMatchObject({
      kind: "settle",
      action: "release.deploy_failed",
      deploy: { status: "failed", detail: "HTTP 500", deliveryId, attempt: 2, finishedAt: "2026-01-02T00:01:00.000Z" },
    });
  });

  it("stays idempotent for a duplicate callback on the current attempt", () => {
    const settled = pending({ status: "ok", finishedAt: NOW });
    const plan = planReleaseDeployCallback({ current: settled, deliveryId, attempt: 2, status: "succeeded", now: NOW });
    expect(plan).toEqual({ kind: "duplicate", deploy: settled });
  });

  it("rejects a conflicting status for the current, already-final attempt", () => {
    const plan = planReleaseDeployCallback({ current: pending({ status: "ok" }), deliveryId, attempt: 2, status: "failed", now: NOW });
    expect(plan).toMatchObject({ kind: "reject", code: "RELEASE_ALREADY_FINAL", audit: false });
  });
});
