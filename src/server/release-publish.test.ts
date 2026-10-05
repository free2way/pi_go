import { describe, expect, it } from "vitest";
import { buildReleaseDeployPayload, planReleasePublish, shapeReleaseDeployOutcome, type ReleasePublishStory } from "./release-publish.js";

function story(overrides: Partial<ReleasePublishStory> = {}): ReleasePublishStory {
  return { storyId: "story_1", title: "故事一", status: "done", runState: "completed", ...overrides };
}

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

  it("maps a successful or async-accepted execution to ok", () => {
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      { configured: true, kind: "webhook", status: "succeeded", detail: "HTTP 200", httpStatus: 200 },
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "ok", detail: "HTTP 200" });
    expect(shapeReleaseDeployOutcome(
      { configured: true, kind: "command", command: "deploy.sh" },
      { configured: true, kind: "command", status: "triggered", detail: "HTTP 202；等待部署系统回调" },
      "2026-01-01T00:00:00.000Z",
    )).toMatchObject({ status: "ok" });
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
