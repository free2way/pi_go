import type { AgileRelease, ReleaseDeployRecord } from "../shared/agile.js";
import type { PostMergeDeployPlan } from "./run-merge.js";
import type { ReleaseExecutionOutcome } from "./release-execution.js";
import {
  buildReleaseDeployPayload,
  planReleaseDeployAttempt,
  shapeReleaseDeployOutcome,
  type ReleasePublishStory,
} from "./release-publish.js";

/**
 * AUD-P1 confirm orchestration for an agile release publish.
 *
 * Kept out of the Fastify route (and dependency-injected, so it needs no
 * database) because the correctness argument lives in the *order* of steps:
 *
 *   1. a `pending` attempt older than the bounded timeout is recorded as
 *      `failed` first (bounded verification — the callback never arrived), and
 *      only then may an explicit retry start;
 *   2. the deploy is *started* atomically in the DB (`startReleaseDeploy`: unique
 *      idempotency record + the release write in one transaction), so exactly one
 *      of two simultaneous confirms wins and no claim can exist without its
 *      deploy record;
 *   3. only the winner invokes the deploy transport, and an HTTP 202 stays
 *      `pending` until its callback (or the timeout) supplies a real result — a
 *      final result is then settled with a compare-and-swap, so a late duplicate
 *      writer can never overwrite the callback.
 */

export interface ReleaseDeployStart {
  releaseId: string;
  deliveryId: string;
  attempt: number;
  releasedBy: string;
  releasedAt: string;
  note?: string;
  deploy: ReleaseDeployRecord;
  stories: ReleasePublishStory[];
}

export interface ReleaseDeployDeps {
  /** Atomic idempotency claim + `released` write (one transaction). */
  start: (input: ReleaseDeployStart) => Promise<{ claimed: boolean; attempt: number; release: AgileRelease }>;
  /** Compare-and-swap settlement of a final observed result. */
  settle: (input: {
    releaseId: string;
    deploy: ReleaseDeployRecord;
    action: "release.deploy_result" | "release.deploy_failed";
    actorId: string;
    now: string;
  }) => Promise<{ applied: boolean; release: AgileRelease }>;
  /** The shared deploy transport (never duplicated). */
  execute: (
    payload: Record<string, unknown>,
    options: { deliveryId: string; webhookToken?: string },
  ) => Promise<ReleaseExecutionOutcome>;
  /** Read the authoritative release for the response body. */
  read: () => Promise<AgileRelease>;
}

export interface ReleaseDeployInput {
  release: AgileRelease;
  stories: ReleasePublishStory[];
  deployPlan: PostMergeDeployPlan;
  retry: boolean;
  now: string;
  releasedBy: string;
  note?: string;
  callbackUrl?: string;
  webhookToken?: string;
}

export type ReleaseDeployRun =
  | { kind: "conflict"; status: 409; code: string; message: string; attempt?: number; deliveryId?: string }
  | { kind: "published"; release: AgileRelease; deploy: ReleaseDeployRecord };

export async function runReleaseDeploy(input: ReleaseDeployInput, deps: ReleaseDeployDeps): Promise<ReleaseDeployRun> {
  const now = input.now;
  const release = input.release;

  // 1. Bounded verification / retry decision from the observed state.
  const decision = planReleaseDeployAttempt({ release, retry: input.retry, now });
  if (decision.kind === "conflict") {
    return { kind: "conflict", status: decision.status, code: decision.code, message: decision.message };
  }
  if (decision.expired) {
    // Record the timed-out attempt as failed before starting the next one, so
    // the audit trail never shows an in-flight deploy that no longer exists.
    const expired = await deps.settle({ releaseId: release.id, deploy: decision.expired, action: "release.deploy_failed", actorId: input.releasedBy, now });
    if (!expired.applied) {
      return { kind: "conflict", status: 409, code: "RELEASE_IN_PROGRESS", message: "部署状态已由其他请求更新，请刷新后重试" };
    }
  }

  const deliveryId = decision.deliveryId;
  const releasedAt = now;
  const hookExecutable = input.deployPlan.configured && input.deployPlan.kind !== "unsupported";
  const pendingDeploy: ReleaseDeployRecord = {
    status: "pending",
    detail: "部署已触发，等待部署系统回调",
    at: now,
    startedAt: now,
    deliveryId,
    attempt: decision.attempt,
  };
  // 2. Claim + record the in-flight attempt in one atomic write, BEFORE the hook.
  const started = await deps.start({
    releaseId: release.id,
    deliveryId,
    attempt: decision.attempt,
    releasedBy: input.releasedBy,
    releasedAt,
    note: input.note,
    deploy: hookExecutable ? pendingDeploy : shapeReleaseDeployOutcome(input.deployPlan, undefined, now),
    stories: input.stories,
  });
  if (!started.claimed) {
    return {
      kind: "conflict",
      status: 409,
      code: "RELEASE_IN_PROGRESS",
      message: "已有相同的发布部署请求正在处理，请勿重复确认",
      attempt: started.attempt,
      deliveryId,
    };
  }
  if (!hookExecutable) return { kind: "published", release: started.release, deploy: started.release.deploy ?? pendingDeploy };

  // 3. Only the winner invokes the transport (a malformed/unset hook never does).
  const execution = await deps.execute(
    buildReleaseDeployPayload({
      release,
      stories: input.stories,
      releasedAt,
      releasedBy: input.releasedBy,
      note: input.note,
      callbackUrl: input.callbackUrl,
    }),
    { deliveryId, ...(input.webhookToken ? { webhookToken: input.webhookToken } : {}) },
  );
  const deploy = shapeReleaseDeployOutcome(input.deployPlan, execution, new Date().toISOString(), { deliveryId, attempt: decision.attempt });
  // A 202 stays pending; only a real result is settled (CAS-guarded).
  if (deploy.status === "pending") return { kind: "published", release: await deps.read(), deploy };

  const settled = await deps.settle({
    releaseId: release.id,
    deploy,
    action: deploy.status === "failed" ? "release.deploy_failed" : "release.deploy_result",
    actorId: input.releasedBy,
    now: new Date().toISOString(),
  });
  return { kind: "published", release: settled.release, deploy: settled.release.deploy ?? deploy };
}
