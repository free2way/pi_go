import { describe, expect, it } from "vitest";
import type { AgileRelease } from "../shared/agile.js";
import {
  buildReleaseDeployPayload,
  isReleasePublishTerminal,
  planReleaseDeployAttempt,
  planReleasePublish,
  planReleasePublishGate,
  releaseDeployDeliveryId,
  shapeReleaseDeployOutcome,
  RELEASE_DEPLOY_STALE_MS,
  type ReleasePublishStory,
} from "./release-publish.js";

function story(overrides: Partial<ReleasePublishStory> = {}): ReleasePublishStory {
  return { storyId: "story_1", title: "故事一", status: "done", runState: "completed", ...overrides };
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

  it("is ready when every story is unblocked", () => {
    expect(planReleasePublish({ stories: [story(), story({ storyId: "s2", status: "in_progress" })] })).toEqual({ kind: "ready" });
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
  it("shapes the release publish payload with stories and actor", () => {
    const payload = buildReleaseDeployPayload({
      release: { id: "rel_1", projectId: "proj_1", name: "结账", version: "v1.2.0" },
      stories: [
        { storyId: "s1", title: "故事一", status: "done" },
        { storyId: "s2", title: "故事二", status: "awaiting_acceptance" },
      ],
      releasedAt: "2026-01-01T00:00:00.000Z",
      releasedBy: "user_a",
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
    expect(planReleaseDeployAttempt({ release: release(), now: NOW })).toEqual({
      kind: "ready",
      deliveryId: "release-publish:release_1",
      attempt: 1,
    });
  });

  it("is terminal for an ok / not-configured / no-deploy release", () => {
    for (const deploy of [null, { status: "ok", detail: "HTTP 200", at: NOW }, { status: "not_configured", detail: "未配置", at: NOW }]) {
      const decision = planReleaseDeployAttempt({ release: release({ status: "released", deploy: deploy as never }), now: NOW });
      expect(decision).toMatchObject({ kind: "conflict", status: 409, code: "RELEASE_RELEASED" });
    }
    expect(isReleasePublishTerminal(release({ status: "released", deploy: null }))).toBe(true);
    expect(isReleasePublishTerminal(release({ status: "released", deploy: { status: "failed", detail: "HTTP 503", at: NOW } }))).toBe(false);
  });

  it("requires an explicit retry after a failed deploy", () => {
    const failed = release({ status: "released", deploy: { status: "failed", detail: "HTTP 503", at: NOW, deliveryId: "release-publish:release_1", attempt: 1 } });
    expect(planReleaseDeployAttempt({ release: failed, now: NOW })).toMatchObject({ kind: "conflict", status: 409, code: "RELEASE_RETRY_REQUIRED" });
    expect(planReleaseDeployAttempt({ release: failed, retry: true, now: NOW })).toEqual({ kind: "ready", deliveryId: "release-publish:release_1", attempt: 2 });
  });

  it("keeps a fresh pending attempt pending and refuses a premature retry", () => {
    const pending = release({ status: "released", deploy: { status: "pending", detail: "HTTP 202", at: NOW, startedAt: NOW, attempt: 1 } });
    expect(planReleaseDeployAttempt({ release: pending, now: NOW })).toMatchObject({ kind: "conflict", code: "RELEASE_AWAITING_RESULT" });
    expect(planReleaseDeployAttempt({ release: pending, retry: true, now: NOW })).toMatchObject({ kind: "conflict", code: "RELEASE_IN_PROGRESS" });
  });

  it("times a pending attempt out (bounded verification) and reports it as expired for retry", () => {
    const started = "2026-01-01T00:00:00.000Z";
    const timedOut = release({
      status: "released",
      deploy: { status: "pending", detail: "HTTP 202", at: started, startedAt: started, deliveryId: "release-publish:release_1", attempt: 1 },
    });
    const later = new Date(Date.parse(started) + RELEASE_DEPLOY_STALE_MS + 1).toISOString();
    expect(planReleaseDeployAttempt({ release: timedOut, now: later })).toMatchObject({ kind: "conflict", code: "RELEASE_DEPLOY_TIMEOUT" });
    const decision = planReleaseDeployAttempt({ release: timedOut, retry: true, now: later });
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") throw new Error("expected ready");
    expect(decision.attempt).toBe(2);
    expect(decision.expired).toMatchObject({ status: "failed", finishedAt: later });
    expect(decision.expired?.detail).toContain("超时");
  });
});

describe("releaseDeployDeliveryId", () => {
  it("is stable for a release so a retry can be de-duplicated by the receiver", () => {
    expect(releaseDeployDeliveryId("release_1")).toBe("release-publish:release_1");
    expect(releaseDeployDeliveryId("release_1")).toBe(releaseDeployDeliveryId("release_1"));
  });
});
