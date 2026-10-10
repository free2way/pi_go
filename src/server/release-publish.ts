import { RELEASE_DEPLOY_STALE_MS, type AgileRelease, type ReleaseDeployRecord, type ReleaseEnvironment, type StoryStatus } from "../shared/agile.js";
import { gateBlocking, type DecisionBriefFindingInput } from "../shared/decision-brief.js";
import type { RunState } from "../shared/types.js";
import type { ReleaseExecutionOutcome } from "./release-execution.js";
import type { PostMergeDeployPlan } from "./run-merge.js";

/**
 * Release publish action (Sprint 5) — pure planning/shaping helpers.
 *
 * The route stays a thin adapter: guards and the deploy-outcome mapping live
 * here so they can be unit-tested without a database or the Fastify app. The
 * deploy transport itself is reused from `executeRelease` (never duplicated).
 */

/** A deploy that is still `pending` after this long is timed out and retryable. */
export { RELEASE_DEPLOY_STALE_MS };

/**
 * The documented release policy (`config/workflow.example.yaml` `release:` block,
 * `docs/19`). Kept as one constant so the security-relevant preconditions read
 * from a single source of truth instead of being scattered across the route.
 *
 * - `requireAdmin`: publishing is administrator-only (see `planReleasePublishGate`).
 * - `requireExplicitConfirmation`: a side effect only happens with `confirm: true`;
 *   a request without it is the read-only preview.
 * - `requireMergedCommit`: the reviewed commit must have been merged before it can
 *   be released (see `planReleasePublish`, `RELEASE_NOT_MERGED`).
 */
export const RELEASE_PUBLISH_POLICY = {
  requireAdmin: true,
  requireExplicitConfirmation: true,
  requireMergedCommit: true,
} as const;

/**
 * `release.requireAdmin: true` (config/workflow.example.yaml) makes publishing a
 * release administrator-only, exactly like `POST /api/runs/:id/publish`. Owner
 * status grants no exemption: a non-admin owner is still refused.
 */
export type ReleasePublishGate =
  | { kind: "ready" }
  | { kind: "forbidden"; status: 403; code: "ADMIN_REQUIRED"; message: string };

export function planReleasePublishGate(input: { isAdmin: boolean }): ReleasePublishGate {
  if (!input.isAdmin) {
    return { kind: "forbidden", status: 403, code: "ADMIN_REQUIRED", message: "仅管理员可以发布代码" };
  }
  return { kind: "ready" };
}

/**
 * Stable deployment identity for a release. Mirrors `releaseDeliveryId` for runs
 * (stable across retries so the receiver can de-duplicate; the release is the
 * deployment unit, so its id is the `run` slot of the documented
 * `run+commit+environment` key).
 */
export function releaseDeployDeliveryId(releaseId: string, environment: ReleaseEnvironment) {
  return `release-publish:${releaseId}:${environment}`;
}

/**
 * Whether the release publish is already settled and must not be confirmed
 * again: a `released` release whose deploy reached a final, non-retryable state
 * (`ok`/`not_configured`/`unsupported`) or that never recorded a deploy. A
 * `failed`/timed-out deploy is deliberately *not* terminal — see
 * `planReleaseDeployAttempt`, which allows an explicit retry.
 */
export function isReleasePublishTerminal(release: Pick<AgileRelease, "status" | "deploy">, environment?: ReleaseEnvironment): boolean {
  const deploy = release.deploy ?? null;
  if (release.status !== "released") return false;
  if (!deploy) return true;
  if (environment === "production" && deploy.environment === "staging" && deploy.status === "ok") return false;
  return deploy.status === "ok" || deploy.status === "not_configured" || deploy.status === "unsupported";
}

export type ReleaseDeployDecision =
  | { kind: "ready"; deliveryId: string; attempt: number; expired?: ReleaseDeployRecord }
  | { kind: "conflict"; status: 409; code: string; message: string };

/**
 * Decides whether a confirmed publish may start a new deploy attempt, and which
 * attempt number it is. The attempt is derived from the *observed* deploy state
 * (never from a counter), so two simultaneous confirms for the same state compute
 * the same attempt and therefore the same DB idempotency key — exactly one wins.
 *
 * - first publish (or a publish that never recorded a deploy) → attempt 1;
 * - staging → production promotion → the next release-wide attempt, with a
 *   new environment-scoped delivery id;
 * - already succeeded / nothing to wait for → `RELEASE_RELEASED` (409);
 * - `failed` → only with an explicit `retry` (`RELEASE_RETRY_REQUIRED`);
 * - `pending` → refused until the bounded timeout, then only with `retry`; a
 *   timed-out attempt is returned as `expired` so the caller records it failed.
 */
export function planReleaseDeployAttempt(input: {
  release: Pick<AgileRelease, "id" | "status" | "deploy">;
  environment: ReleaseEnvironment;
  retry?: boolean;
  now: string;
  staleAfterMs?: number;
}): ReleaseDeployDecision {
  const deploy = input.release.deploy ?? null;
  const retry = input.retry === true;
  const deliveryId = releaseDeployDeliveryId(input.release.id, input.environment);
  if (!deploy) {
    if (input.release.status === "released") {
      return { kind: "conflict", status: 409, code: "RELEASE_RELEASED", message: "发布已发布，不可重复发布" };
    }
    return { kind: "ready", deliveryId, attempt: 1 };
  }
  const promotion = deploy.status === "ok" && deploy.environment === "staging" && input.environment === "production";
  const targetChanged = Boolean(deploy.environment && deploy.environment !== input.environment);
  if (targetChanged && !promotion) {
    return { kind: "conflict", status: 409, code: "RELEASE_TARGET_CHANGED", message: "已有发布记录与当前环境不一致，仅允许 staging 成功后晋级到 production" };
  }
  const retryDeliveryId = deploy.deliveryId ?? deliveryId;
  const nextAttempt = (deploy.attempt ?? 1) + 1;
  // `agile_release_deploy_claims` enforces UNIQUE(release_id, attempt), so the
  // sequence is release-wide rather than per environment. Reusing attempt 1
  // for production after a successful staging claim would violate that key.
  if (promotion) return { kind: "ready", deliveryId, attempt: nextAttempt };
  if (deploy.status === "ok" || deploy.status === "not_configured" || deploy.status === "unsupported") {
    return { kind: "conflict", status: 409, code: "RELEASE_RELEASED", message: "发布已发布，不可重复发布" };
  }
  if (deploy.status === "failed") {
    if (!retry) {
      return { kind: "conflict", status: 409, code: "RELEASE_RETRY_REQUIRED", message: "上次部署失败，请明确选择重试部署" };
    }
    return { kind: "ready", deliveryId: retryDeliveryId, attempt: nextAttempt };
  }
  // pending: bounded verification — only a timed-out attempt may be retried.
  const startedAt = deploy.startedAt ?? deploy.at;
  const age = Date.parse(input.now) - Date.parse(startedAt);
  const staleAfterMs = input.staleAfterMs ?? RELEASE_DEPLOY_STALE_MS;
  const stale = Number.isFinite(age) && age >= staleAfterMs;
  if (!stale) {
    return retry
      ? { kind: "conflict", status: 409, code: "RELEASE_IN_PROGRESS", message: "部署正在进行中；仅可在回调超时后重试" }
      : { kind: "conflict", status: 409, code: "RELEASE_AWAITING_RESULT", message: "部署已触发，正在等待部署系统回调；超时后可显式重试" };
  }
  const expired: ReleaseDeployRecord = {
    ...deploy,
    status: "failed",
    detail: `等待部署系统回调超时（超过 ${Math.round(staleAfterMs / 60_000)} 分钟未收到结果）`,
    at: input.now,
    finishedAt: input.now,
  };
  if (!retry) {
    return { kind: "conflict", status: 409, code: "RELEASE_DEPLOY_TIMEOUT", message: `${expired.detail}，请显式重试部署` };
  }
  return { kind: "ready", deliveryId: retryDeliveryId, attempt: nextAttempt, expired };
}

/** One release story, already reconciled to its derived status. */
export interface ReleasePublishStory {
  storyId: string;
  title: string;
  status: StoryStatus;
  /** Canonical source workspace used by the story's latest run. */
  workspaceId?: string | null;
  /** Derived reason; present only when `status` is `blocked`. */
  reason?: string;
  /** Latest linked run state, echoed to the UI when the story is blocked. */
  runState?: RunState | null;
  /**
   * Latest linked run's id (`null`/absent when the story has no run at all), so
   * the readiness gate can tell "missing" from "not finished".
   */
  runId?: string | null;
  /**
   * The deterministic check verdict recorded on the latest run
   * (`Run.checkPassed`), when the run documents it.
   */
  checkPassed?: boolean | null;
  /** Recorded checks of the latest run (`Run.checks`). */
  checks?: Array<{ name?: string | null; command?: string | null; status?: string | null; exitCode?: number | null }> | null;
  /** Unresolved/blocking findings of the latest run (`Run.findings`). */
  findings?: DecisionBriefFindingInput[] | null;
  /**
   * The story's AC/DoD text, used by the Decision Brief blocking gate to decide
   * whether an unresolved `high` is relevant (the same inputs the brief gets).
   */
  criteria?: string[] | null;
  /** Files touched by the latest run's diff (blocking-gate relevance context). */
  diffFiles?: string[] | null;
  /** The merged commit recorded on the latest run (`Run.merge.commit`), if any. */
  mergedCommit?: string | null;
}

export interface ReleasePublishBlockedStory extends ReleasePublishStory {
  reason: string;
}

/** A story that is not in a publishable state (missing or unfinished run). */
export interface ReleasePublishNotReadyStory {
  storyId: string;
  title: string;
  status: StoryStatus;
  runState?: RunState | null;
  reason: string;
}

/** A story whose deterministic checks did not (provably) pass. */
export interface ReleasePublishChecksFailedStory {
  storyId: string;
  title: string;
  runId: string | null;
  detail: string;
}

/** A story whose reviewed commit is not merged yet (requireMergedCommit). */
export interface ReleasePublishNotMergedStory {
  storyId: string;
  title: string;
  runId: string | null;
}

/** An unresolved blocking finding surfaced by the Decision Brief blocking gate. */
export interface ReleasePublishBlockingFinding {
  storyId: string;
  runId: string | null;
  severity: string;
  title: string;
}

export type ReleasePublishPlan =
  | { kind: "empty"; status: 409; code: "RELEASE_EMPTY"; message: string }
  | { kind: "not_ready"; status: 409; code: "RELEASE_NOT_READY"; message: string; stories: ReleasePublishNotReadyStory[] }
  | { kind: "checks_failed"; status: 409; code: "RELEASE_CHECKS_FAILED"; message: string; stories: ReleasePublishChecksFailedStory[] }
  | {
      kind: "blocked";
      status: 409;
      code: "RELEASE_BLOCKED";
      message: string;
      blocked: ReleasePublishBlockedStory[];
      findings: ReleasePublishBlockingFinding[];
    }
  | { kind: "not_merged"; status: 409; code: "RELEASE_NOT_MERGED"; message: string; stories: ReleasePublishNotMergedStory[] }
  | { kind: "ready" };

/** The run states whose reviewed work may be released (see `planReleaseStart`). */
const PUBLISHABLE_RUN_STATES: ReadonlyArray<RunState> = ["completed"];

/**
 * The deterministic check verdict of one story's latest run. `run.checkPassed`
 * is authoritative; the recorded checks are a cross-check. Fail-safe: without
 * positive evidence that every check passed, the release is refused.
 */
function storyChecksPassed(story: ReleasePublishStory): { passed: boolean; detail: string } {
  const checks = story.checks ?? [];
  const failed = checks.filter((check) => String(check.status ?? "").toLowerCase() === "failed");
  if (story.checkPassed === false) return { passed: false, detail: "运行记录的检查未通过（checkPassed=false）" };
  if (failed.length > 0) {
    const names = failed.map((check) => check.name?.trim() || check.command?.trim() || "检查").slice(0, 5).join("、");
    return { passed: false, detail: `${failed.length} 项检查未通过（${names}）` };
  }
  if (story.checkPassed === true) return { passed: true, detail: "运行记录的检查已通过（checkPassed=true）" };
  if (checks.length > 0 && checks.every((check) => String(check.status ?? "").toLowerCase() === "passed")) {
    return { passed: true, detail: `${checks.length} 项检查全部通过` };
  }
  return { passed: false, detail: "没有可确认通过的检查记录" };
}

/**
 * The full publish precondition set, evaluated in a fixed order so two callers
 * observing the same data always get the same verdict and code. Every unmet
 * condition carries a distinct, stable `code` and the offending ids:
 *
 * 1. `RELEASE_EMPTY`         — the release references no (visible) story.
 * 2. `RELEASE_BLOCKED`       — a story is blocked (manual or run-derived).
 * 3. `RELEASE_NOT_READY`     — a story has no run, or its latest run is not a
 *                              terminal success (`completed`).
 * 4. `RELEASE_CHECKS_FAILED` — the run's deterministic checks did not pass.
 * 5. `RELEASE_BLOCKED`       — the Decision Brief blocking gate is red/unknown
 *                              (unresolved critical, or an unresolved high whose
 *                              irrelevance cannot be proven).
 * 6. `RELEASE_NOT_MERGED`    — `requireMergedCommit` is set and the run records no
 *                              merged commit.
 *
 * The same plan is used by the dry-run preview and the confirmed publish, so the
 * preview reports the identical verdict without any side effect.
 */
export function planReleasePublish(input: {
  stories: ReleasePublishStory[];
  label?: string;
  requireMergedCommit?: boolean;
}): ReleasePublishPlan {
  const label = input.label?.trim() || "该发布";
  if (input.stories.length === 0) {
    return { kind: "empty", status: 409, code: "RELEASE_EMPTY", message: `${label}不包含任何故事，无法发布` };
  }

  const blocked: ReleasePublishBlockedStory[] = input.stories
    .filter((story) => story.status === "blocked")
    .map((story) => ({ ...story, reason: story.reason?.trim() || "阻塞（无原因说明）" }));
  if (blocked.length > 0) {
    return {
      kind: "blocked",
      status: 409,
      code: "RELEASE_BLOCKED",
      message: `${label}仍有 ${blocked.length} 个阻塞故事，需先解除阻塞`,
      blocked,
      findings: [],
    };
  }

  const notReady: ReleasePublishNotReadyStory[] = input.stories.flatMap((story) => {
    if (!story.runId) {
      return [{ storyId: story.storyId, title: story.title, status: story.status, runState: story.runState ?? null, reason: "没有关联的运行，无可发布的交付物" }];
    }
    if (!PUBLISHABLE_RUN_STATES.includes(story.runState as RunState)) {
      return [{
        storyId: story.storyId,
        title: story.title,
        status: story.status,
        runState: story.runState ?? null,
        reason: `最新运行状态为 ${story.runState ?? "未知"}，尚未完成，不可发布`,
      }];
    }
    return [];
  });
  if (notReady.length > 0) {
    return {
      kind: "not_ready",
      status: 409,
      code: "RELEASE_NOT_READY",
      message: `${label}仍有 ${notReady.length} 个故事不可发布（缺少已完成的运行）`,
      stories: notReady,
    };
  }

  const checksFailed: ReleasePublishChecksFailedStory[] = input.stories.flatMap((story) => {
    const verdict = storyChecksPassed(story);
    return verdict.passed ? [] : [{ storyId: story.storyId, title: story.title, runId: story.runId ?? null, detail: verdict.detail }];
  });
  if (checksFailed.length > 0) {
    return {
      kind: "checks_failed",
      status: 409,
      code: "RELEASE_CHECKS_FAILED",
      message: `${label}有 ${checksFailed.length} 个故事的确定性检查未通过，不可发布`,
      stories: checksFailed,
    };
  }

  const findings: ReleasePublishBlockingFinding[] = [];
  for (const story of input.stories) {
    const gate = gateBlocking(story.findings ?? [], story.criteria ?? [], story.diffFiles ?? null);
    if (gate.status === "green") continue;
    for (const ref of gate.findings ?? []) {
      findings.push({ storyId: story.storyId, runId: story.runId ?? null, severity: ref.severity, title: ref.title || gate.detail });
    }
    if ((gate.findings ?? []).length === 0) {
      findings.push({ storyId: story.storyId, runId: story.runId ?? null, severity: "unknown", title: gate.detail });
    }
  }
  if (findings.length > 0) {
    return {
      kind: "blocked",
      status: 409,
      code: "RELEASE_BLOCKED",
      message: `${label}存在 ${findings.length} 个未解决的阻断级问题，需先修复`,
      blocked: [],
      findings,
    };
  }

  const requireMergedCommit = input.requireMergedCommit ?? RELEASE_PUBLISH_POLICY.requireMergedCommit;
  if (requireMergedCommit) {
    const notMerged: ReleasePublishNotMergedStory[] = input.stories
      .filter((story) => !story.mergedCommit?.trim())
      .map((story) => ({ storyId: story.storyId, title: story.title, runId: story.runId ?? null }));
    if (notMerged.length > 0) {
      return {
        kind: "not_merged",
        status: 409,
        code: "RELEASE_NOT_MERGED",
        message: `${label}有 ${notMerged.length} 个故事的审核提交尚未合并，发布前必须先合并`,
        stories: notMerged,
      };
    }
  }

  return { kind: "ready" };
}

/** Terminal status a callback maps onto (`succeeded` → `ok`, else `failed`). */
export type ReleaseDeployCallbackStatus = "ok" | "failed";

/**
 * Decision for one asynchronous deploy callback. The matching rule is *exact*:
 * the callback must carry the same `deliveryId` and the same `attempt` as the
 * stored in-flight record, and that record must still be `pending`.
 *
 * Retries reuse the same `deliveryId` (only `attempt` changes), so a late
 * callback from a previous attempt would otherwise look identical to a callback
 * for the current one. Requiring an explicit, matching `attempt` is what makes a
 * stale/unsolicited callback (`RELEASE_ATTEMPT_STALE`, audited, no write)
 * distinguishable from a legitimate duplicate of the current attempt
 * (`kind: "duplicate"`, idempotent, no write).
 */
export type ReleaseDeployCallbackPlan =
  | { kind: "duplicate"; deploy: ReleaseDeployRecord }
  | { kind: "settle"; deploy: ReleaseDeployRecord; action: "release.deploy_succeeded" | "release.deploy_failed" }
  | {
      kind: "reject";
      status: 409;
      code: "RELEASE_DELIVERY_MISMATCH" | "RELEASE_ATTEMPT_STALE" | "RELEASE_ALREADY_FINAL";
      message: string;
      /** Whether the caller must append an audit row for this rejection. */
      audit: boolean;
      attempt?: number;
    };

export function planReleaseDeployCallback(input: {
  current: ReleaseDeployRecord | null;
  deliveryId: string;
  attempt?: number;
  status: "succeeded" | "failed";
  detail?: string;
  deploymentId?: string;
  url?: string;
  now: string;
}): ReleaseDeployCallbackPlan {
  const current = input.current;
  if (!current || !current.deliveryId || current.deliveryId !== input.deliveryId) {
    return { kind: "reject", status: 409, code: "RELEASE_DELIVERY_MISMATCH", message: "Release delivery id does not match", audit: false };
  }
  if (input.attempt === undefined || current.attempt === undefined || input.attempt !== current.attempt) {
    return {
      kind: "reject",
      status: 409,
      code: "RELEASE_ATTEMPT_STALE",
      message: `Release callback attempt ${input.attempt ?? "unknown"} does not match the current attempt ${current.attempt ?? "unknown"}`,
      audit: true,
      ...(current.attempt === undefined ? {} : { attempt: current.attempt }),
    };
  }
  const deployStatus: ReleaseDeployCallbackStatus = input.status === "succeeded" ? "ok" : "failed";
  // A duplicate callback for the *current* attempt is idempotent.
  if (current.status === deployStatus) return { kind: "duplicate", deploy: current };
  if (current.status !== "pending") {
    return { kind: "reject", status: 409, code: "RELEASE_ALREADY_FINAL", message: `Release deploy is already ${current.status}`, audit: false };
  }
  const deploy: ReleaseDeployRecord = {
    ...current,
    status: deployStatus,
    detail: input.detail ?? (deployStatus === "ok" ? "部署系统回调：成功" : "部署系统回调：失败"),
    at: input.now,
    finishedAt: input.now,
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    ...(input.url ? { url: input.url } : {}),
  };
  return { kind: "settle", deploy, action: deployStatus === "ok" ? "release.deploy_succeeded" : "release.deploy_failed" };
}

/**
 * Maps the deploy plan + execution outcome onto the release's recorded deploy
 * status. A configured-but-failing hook is always `failed` (never skipped); an
 * HTTP 202 is only `pending` — the deploy system accepted an asynchronous
 * request and the final result must arrive via callback (or the bounded timeout
 * marks it failed), so it is never recorded as premature success.
 */
export function shapeReleaseDeployOutcome(
  plan: PostMergeDeployPlan,
  execution: ReleaseExecutionOutcome | undefined,
  at: string,
  identity: { deliveryId?: string; attempt?: number; environment?: ReleaseEnvironment } = {},
): ReleaseDeployRecord {
  const id = {
    ...(identity.deliveryId ? { deliveryId: identity.deliveryId } : {}),
    ...(identity.attempt === undefined ? {} : { attempt: identity.attempt }),
    ...(identity.environment ? { environment: identity.environment } : {}),
  };
  if (!plan.configured) return { status: "not_configured", detail: plan.reason, at, ...id };
  if (plan.kind === "unsupported") return { status: "unsupported", detail: plan.reason, at, ...id };
  if (!execution) return { status: "failed", detail: "deploy hook configured but no execution outcome was recorded", at, ...id };
  if (execution.status === "succeeded") return { status: "ok", detail: execution.detail, at, finishedAt: at, ...id };
  if (execution.status === "triggered") return { status: "pending", detail: execution.detail, at, startedAt: at, ...id };
  return { status: "failed", detail: execution.detail, at, finishedAt: at, ...id };
}

/** Payload sent to the deploy hook for a release publish (reuses `executeRelease`). */
export function buildReleaseDeployPayload(input: {
  release: Pick<AgileRelease, "id" | "projectId" | "name" | "version">;
  stories: Array<Pick<ReleasePublishStory, "storyId" | "title" | "status">>;
  releasedAt: string;
  releasedBy: string;
  environment: ReleaseEnvironment;
  note?: string;
  callbackUrl?: string;
  deliveryId?: string;
  attempt?: number;
}) {
  return {
    event: "release.published",
    releaseId: input.release.id,
    projectId: input.release.projectId,
    name: input.release.name,
    version: input.release.version,
    // The deploy system must echo these back on the callback — the callback is
    // matched against the exact in-flight attempt (see `planReleaseDeployCallback`).
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    releasedAt: input.releasedAt,
    releasedBy: input.releasedBy,
    environment: input.environment,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    stories: input.stories.map((story) => ({ storyId: story.storyId, title: story.title, status: story.status })),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  };
}
