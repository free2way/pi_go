import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { buildStoryRunInput, STORY_STATUS_LABELS, type StoryDetail } from "../../shared/agile.js";
import type { Locale } from "../../shared/i18n.js";
import type { CurrentUser } from "../../shared/types.js";
import type { AgileService } from "../agile.js";
import { readAgileMetrics, readReleaseRetrospective, readReleaseSummary } from "../agile-metrics.js";
import {
  projectCreateSchema, projectPatchSchema, releaseCreateSchema, releasePatchSchema,
  releasePublishSchema, sprintCreateSchema, sprintPatchSchema, storyBlockSchema,
  storyCreateSchema, storyPatchSchema, storySubmitSchema, templateCreateSchema,
} from "../agile-schemas.js";
import type { Db } from "../db.js";
import { baseDemoRun, runDemo } from "../demo-runner.js";
import type { RateLimiter } from "../rate-limit.js";
import { runReleaseDeploy } from "../release-deploy.js";
import { executeRelease } from "../release-execution.js";
import { isReleasePublishTerminal, planReleasePublish, planReleasePublishGate, RELEASE_PUBLISH_POLICY } from "../release-publish.js";
import type { ReleaseEnvironment } from "../release-routing.js";
import type { PostMergeDeployPlan } from "../run-merge.js";
import type { planRemoteSyncGate } from "../scm-release-gate.js";
import type { RunStoreLike } from "../store.js";
import type { WorkspaceService } from "../workspaces.js";
import { createRunSchema, type RealRunExtra, type RealRunResult } from "./create-run-schema.js";

type AgileRoutes = Pick<AgileService,
  "listProjects" | "createProject" | "getProject" | "updateProject" | "deleteProject" |
  "listStories" | "createStory" | "getStory" | "updateStory" | "deleteStory" |
  "blockStory" | "unblockStory" | "reopenStory" | "linkRun" | "markStoryInProgress" | "reconcileRun" |
  "listSprints" | "createSprint" | "updateSprint" | "deleteSprint" |
  "listReleases" | "createRelease" | "getRelease" | "updateRelease" | "deleteRelease" |
  "collectReleaseStories" | "startReleaseDeploy" | "settleReleaseDeployResult" |
  "listTemplates" | "createTemplate" | "deleteTemplate"
>;

export interface AgileRouteDependencies {
  currentUser: (request: FastifyRequest) => CurrentUser;
  ownerKeysFor: (request: FastifyRequest) => string[];
  isAdmin: (userId: string) => Promise<boolean>;
  agile: AgileRoutes;
  db: Db;
  workspaces: Pick<WorkspaceService, "get">;
  store: RunStoreLike;
  demoMode: boolean;
  runCreations: Pick<RateLimiter, "check">;
  tooManyRequests: (reply: FastifyReply, retryAfterMs: number) => FastifyReply;
  agileErrorReply: (reply: FastifyReply, error: unknown) => FastifyReply;
  requestLocale: (request: FastifyRequest) => Locale;
  startRealRun: (request: FastifyRequest, input: z.infer<typeof createRunSchema>, extra: RealRunExtra) => Promise<RealRunResult>;
  productionRemoteGate: (
    request: FastifyRequest,
    targets: Array<{ workspaceId?: string | null; commit?: string | null }>,
    isAdmin: boolean,
  ) => Promise<ReturnType<typeof planRemoteSyncGate>>;
  effectiveReleaseConfig: (environment: ReleaseEnvironment) => {
    deployPlan: PostMergeDeployPlan;
    webhookToken: string;
    callbackOrigin: string;
  };
}

/** Owner-scoped planning, story submission, and release management. */
export function registerAgileRoutes(app: FastifyInstance, deps: AgileRouteDependencies) {
  const {
    currentUser, ownerKeysFor, agile, db, workspaces, store, demoMode, runCreations,
    tooManyRequests, agileErrorReply, requestLocale, startRealRun, productionRemoteGate, effectiveReleaseConfig,
  } = deps;

  app.get("/api/agile/projects", async (request, reply) => {
    try {
      return { projects: await agile.listProjects(ownerKeysFor(request)) };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post("/api/agile/projects", async (request, reply) => {
    const parsed = projectCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await agile.createProject(currentUser(request).id, parsed.data));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
    try {
      return await agile.getProject(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
    const parsed = projectPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await agile.updateProject(ownerKeysFor(request), request.params.id, parsed.data, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agile/projects/:id", async (request, reply) => {
    try {
      await agile.deleteProject(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
      return reply.code(204).send();
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.get<{ Querystring: { projectId?: string; sprintId?: string; status?: string } }>("/api/stories", async (request, reply) => {
    const filter: { projectId?: string; sprintId?: string | null; status?: StoryDetail["status"] } = {};
    if (request.query.projectId) filter.projectId = request.query.projectId;
    if (request.query.sprintId) filter.sprintId = request.query.sprintId;
    if (request.query.status) filter.status = request.query.status as StoryDetail["status"];
    try {
      return { stories: await agile.listStories(ownerKeysFor(request), filter) };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post("/api/stories", async (request, reply) => {
    const parsed = storyCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await agile.createStory(currentUser(request).id, parsed.data));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  // Story detail reconciles the derived status from the latest linked run first.
  app.get<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
    try {
      return await agile.getStory(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
    const parsed = storyPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await agile.updateStory(ownerKeysFor(request), request.params.id, parsed.data, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/stories/:id", async (request, reply) => {
    try {
      await agile.deleteStory(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
      return reply.code(204).send();
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  // Kanban blocked-management: manual block/unblock on a story. A manual block
  // wins over the derived in-progress/review status until unblocked; a run that is
  // still parked cannot be unblocked from here (409 BLOCKED_BY_RUN).
  app.post<{ Params: { id: string } }>("/api/stories/:id/block", async (request, reply) => {
    const parsed = storyBlockSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "标记阻塞需要填写原因", code: "BLOCK_REASON_REQUIRED", details: parsed.error.issues });
    const user = currentUser(request);
    try {
      return await agile.blockStory(ownerKeysFor(request), request.params.id, parsed.data.reason, user.id, await deps.isAdmin(user.id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/stories/:id/unblock", async (request, reply) => {
    const user = currentUser(request);
    try {
      return await agile.unblockStory(ownerKeysFor(request), request.params.id, await deps.isAdmin(user.id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  // Reopen a story whose latest run is a terminal failed/cancelled run: it goes
  // back to `ready` so it can be submitted again. This is the explicit human path
  // for a stuck (or manually blocked) story and never silently lifts a manual
  // block: 409 with the run id while the latest run is live or needs_human, 409
  // BLOCKED_BY_MANUAL on a manual block, 409 STORY_NOT_REOPENABLE once delivered.
  // The reopen is audited on the latest run (`story.reopened`). See docs/19.
  app.post<{ Params: { id: string } }>("/api/stories/:id/reopen", async (request, reply) => {
    const user = currentUser(request);
    try {
      const result = await agile.reopenStory(ownerKeysFor(request), request.params.id, await deps.isAdmin(user.id));
      if (result.runId) {
        const run = store.getRun(result.runId);
        await store.appendEvent({
          runId: result.runId,
          round: run?.round ?? 0,
          source: "system",
          type: "story.reopened",
          message: `故事「${result.story.title}」已重新打开为就绪（原状态 ${STORY_STATUS_LABELS[result.previousStatus]}）`,
          at: new Date().toISOString(),
          meta: { storyId: result.story.id, actorId: user.id, previousStatus: result.previousStatus },
        });
      }
      return result.story;
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  // Submit a story as a run. Only a `ready` story may be submitted; the run's
  // task carries the description + acceptance criteria + definition of done.
  app.post<{ Params: { id: string } }>("/api/stories/:id/runs", async (request, reply) => {
    const parsed = storySubmitSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    const user = currentUser(request);
    const creationLimit = runCreations.check(user.id);
    if (!creationLimit.allowed) return tooManyRequests(reply, creationLimit.retryAfterMs);
    const isAdmin = await deps.isAdmin(user.id);
    let story: StoryDetail;
    try {
      story = await agile.getStory(ownerKeysFor(request), request.params.id, isAdmin);
    } catch (error) {
      return agileErrorReply(reply, error);
    }
    if (story.status !== "ready") {
      return reply.code(409).send({ error: "只有「就绪」状态的故事可以提交为运行", code: "STORY_NOT_READY", status: story.status });
    }
    const workspaceId = parsed.data.workspaceId ?? story.workspaceId ?? undefined;
    // Checks default to the workspace's registered commands.
    let defaultChecks: string[] = [];
    if (workspaceId) {
      try {
        defaultChecks = (await workspaces.get(ownerKeysFor(request), workspaceId, { isAdmin })).defaultChecks;
      } catch (error) {
        return agileErrorReply(reply, error);
      }
    }
    const input = buildStoryRunInput(story, { checks: parsed.data.checks ?? defaultChecks, workspaceId });

    if (parsed.data.mode === "demo") {
      if (!demoMode) return reply.code(403).send({ error: "Demo mode is disabled" });
      const run = baseDemoRun({ title: input.title, task: input.task, repository: "demo/agile-story" }, user.id);
      run.storyId = story.id;
      // 运行时文案语言 (docs/24-i18n.md §9): the story run records the requester's locale.
      run.locale = requestLocale(request);
      await store.createRun(run, { runId: run.id, round: 1, source: "system", type: "run.created", message: "已从用户故事创建演示任务", at: new Date().toISOString() });
      void runDemo(store, run.id);
      await agile.linkRun(story.id, run.id);
      await agile.markStoryInProgress(story.id);
      return reply.code(201).send({ run: store.getRun(run.id, user.id), story: await agile.getStory(ownerKeysFor(request), story.id, isAdmin) });
    }

    if (!workspaceId) return reply.code(422).send({ error: "真实运行需要指定工作区（故事或请求中的 workspaceId）", code: "STORY_WORKSPACE_REQUIRED" });
    if (input.checks.length === 0) return reply.code(422).send({ error: "真实运行需要至少一个检查命令（工作区默认检查或请求中的 checks）", code: "STORY_CHECKS_REQUIRED" });
    const runParsed = createRunSchema.safeParse({
      title: input.title,
      task: input.task,
      repository: "pending-workspace",
      workspaceId,
      mode: "real",
      checks: input.checks,
      acceptanceCriteria: input.acceptanceCriteria,
      idempotencyKey: parsed.data.idempotencyKey,
      developerModel: input.developerModel,
      reviewerModel: input.reviewerModel,
    });
    if (!runParsed.success) return reply.code(422).send({ error: "故事无法生成合法运行", details: runParsed.error.issues });
    const result = await startRealRun(request, runParsed.data, {
      budget: story.budget ?? undefined,
      maxParallel: story.maxParallel ?? undefined,
      storyId: story.id,
    });
    if (result.run) {
      await agile.linkRun(story.id, result.run.id);
      if (result.ok) await agile.markStoryInProgress(story.id);
      else await agile.reconcileRun(result.run.id);
    }
    if (!result.ok) return reply.code(result.status).send({ ...result.body, storyId: story.id });
    return reply.code(201).send({ run: store.getRun(result.run.id, user.id), story: await agile.getStory(ownerKeysFor(request), story.id, isAdmin) });
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/sprints", async (request, reply) => {
    try {
      return { sprints: await agile.listSprints(ownerKeysFor(request), request.query.projectId) };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post("/api/sprints", async (request, reply) => {
    const parsed = sprintCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await agile.createSprint(currentUser(request).id, parsed.data));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/sprints/:id", async (request, reply) => {
    const parsed = sprintPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await agile.updateSprint(ownerKeysFor(request), request.params.id, parsed.data, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sprints/:id", async (request, reply) => {
    try {
      await agile.deleteSprint(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
      return reply.code(204).send();
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/releases", async (request, reply) => {
    try {
      return { releases: await agile.listReleases(ownerKeysFor(request), request.query.projectId) };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post("/api/releases", async (request, reply) => {
    const parsed = releaseCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await agile.createRelease(currentUser(request).id, parsed.data));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/releases/:id", async (request, reply) => {
    const parsed = releasePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return await agile.updateRelease(ownerKeysFor(request), request.params.id, parsed.data, await deps.isAdmin(currentUser(request).id));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/releases/:id", async (request, reply) => {
    try {
      await agile.deleteRelease(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
      return reply.code(204).send();
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  /**
   * Release publish action (Sprint 5). Owner-scoped, but **admin-only** to execute
   * (`release.requireAdmin: true`; same source of truth and error code as
   * `POST /api/runs/:id/publish`).
   *
   * The full precondition set (`planReleasePublish`, docs/19 §1.1) is enforced
   * after the admin gate and before any side effect, and is shared by the dry-run
   * preview and the confirmed publish so both report the identical verdict:
   * `RELEASE_EMPTY` / `RELEASE_BLOCKED` (blocked story or an unresolved blocking
   * finding) / `RELEASE_NOT_READY` (missing or unfinished run) /
   * `RELEASE_CHECKS_FAILED` / `RELEASE_NOT_MERGED` (`release.requireMergedCommit`).
   *
   * Without `confirm` this is a dry-run preview so the UI can render the
   * confirmation dialog (`release.requireExplicitConfirmation`: only `confirm:true`
   * reaches a deploy). With `confirm` the release is marked `released`, a DB-level
   * idempotency claim guarantees exactly ONE deploy attempt per confirm, and when
   * PI_POST_MERGE_DEPLOY_HOOK is configured the same deploy transport as run
   * publish (`executeRelease`) is invoked. An HTTP 202 stays `pending` until its
   * callback arrives (or the bounded timeout marks it failed and makes an explicit
   * retry possible); its outcome is recorded on the release + an audit row (never
   * silently skipped, never a premature `ok`).
   */
  app.post<{ Params: { id: string } }>("/api/agile/releases/:id/publish", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = releasePublishSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "发布需要 confirm=true（省略时只做只读预检）", code: "RELEASE_CONFIRM_REQUIRED", details: parsed.error.issues });
    }
    const user = currentUser(request);
    const isAdmin = await deps.isAdmin(user.id);
    try {
      const release = await agile.getRelease(ownerKeysFor(request), request.params.id, isAdmin);

      // AUD-P1: publishing is administrator-only, even for the release's owner.
      // Checked before any guard detail is computed, so a non-admin learns nothing
      // about blocked stories (and can never trigger a deploy).
      const gate = planReleasePublishGate({ isAdmin });
      if (gate.kind === "forbidden") return reply.code(gate.status).send({ error: gate.message, code: gate.code });

      // A terminal release has nothing left to publish (failed/timed-out deploys are
      // deliberately not terminal: they must be explicitly retried).
      if (isReleasePublishTerminal(release, parsed.data.environment)) return reply.code(409).send({ error: "该环境已经发布，不可重复发布", code: "RELEASE_RELEASED" });

      // Full, ordered precondition set on the stories' latest runs. Evaluated once
      // for both the preview and the confirmed publish (same verdict, no side effect).
      const stories = await agile.collectReleaseStories(ownerKeysFor(request), release, isAdmin);
      const plan = planReleasePublish({ stories, label: `发布「${release.version} ${release.name}」` });
      if (plan.kind !== "ready") {
        return reply.code(plan.status).send({
          error: plan.message,
          code: plan.code,
          ...(plan.kind === "blocked" ? { blocked: plan.blocked, findings: plan.findings } : {}),
          ...(plan.kind === "not_ready" ? { stories: plan.stories } : {}),
          ...(plan.kind === "checks_failed" ? { stories: plan.stories } : {}),
          ...(plan.kind === "not_merged" ? { stories: plan.stories } : {}),
        });
      }

      if (parsed.data.environment === "production") {
        const remoteGate = await productionRemoteGate(
          request,
          stories.map((story) => ({ workspaceId: story.workspaceId, commit: story.mergedCommit })),
          isAdmin,
        );
        if (remoteGate.kind === "blocked") {
          return reply.code(409).send({ error: remoteGate.message, code: remoteGate.code, blocked: remoteGate.blocked });
        }
      }

      // Explicit confirmation (`release.requireExplicitConfirmation`): a request
      // without `confirm: true` is the read-only dry-run preview. It never settles a
      // `failed` deploy (so the UI can offer a retry) and never reaches the deploy
      // below — only an explicit confirmation does.
      if (RELEASE_PUBLISH_POLICY.requireExplicitConfirmation && !parsed.data.confirm) {
        return {
          published: false,
          confirmationRequired: true,
          release,
          stories,
          deploy: release.deploy ?? null,
        };
      }

      const now = new Date().toISOString();
      const releaseRuntime = effectiveReleaseConfig(parsed.data.environment!);
      const deployPlan = releaseRuntime.deployPlan;
      if (deployPlan.configured && deployPlan.kind === "webhook" && !releaseRuntime.webhookToken) {
        return reply.code(409).send({ error: "Webhook 发布必须在发布设置或环境变量中配置 Token", code: "RELEASE_AUTH_NOT_CONFIGURED" });
      }
      if (deployPlan.configured && deployPlan.kind === "webhook" && !releaseRuntime.callbackOrigin) {
        return reply.code(409).send({ error: "Webhook 发布必须配置 PiGO 公网地址以接收异步结果回调", code: "RELEASE_CALLBACK_NOT_CONFIGURED" });
      }
      const callbackUrl = releaseRuntime.callbackOrigin
        ? `${releaseRuntime.callbackOrigin.replace(/\/$/, "")}/api/internal/agile/releases/${encodeURIComponent(release.id)}/release-result`
        : undefined;

      // AUD-P1: ordering (timeout → claim → execute) is the correctness argument
      // and lives in `runReleaseDeploy`, unit-tested including the concurrent path.
      const run = await runReleaseDeploy(
        {
          release,
          stories,
          deployPlan,
          retry: parsed.data.retry === true,
          now,
          releasedBy: user.id,
          environment: parsed.data.environment!,
          note: parsed.data.note,
          callbackUrl,
          webhookToken: releaseRuntime.webhookToken || undefined,
        },
        {
          start: (input) => agile.startReleaseDeploy(input),
          settle: (input) => agile.settleReleaseDeployResult(input),
          execute: (payload, options) => executeRelease(deployPlan, payload, options),
          read: () => agile.getRelease(ownerKeysFor(request), release.id, isAdmin),
        },
      );
      if (run.kind === "conflict") {
        return reply.code(run.status).send({
          error: run.message,
          code: run.code,
          ...(run.attempt === undefined ? {} : { attempt: run.attempt }),
          ...(run.deliveryId ? { deliveryId: run.deliveryId } : {}),
        });
      }
      return { published: true, release: run.release, deploy: run.deploy };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  /**
   * Sprint 4 core: release summary + retrospective export. Both are read-only,
   * owner-scoped projections of the release's stories and their linked runs. An
   * unknown/foreign release answers a 404 (`RELEASE_NOT_FOUND`) exactly like the
   * release CRUD routes, never a 500.
   */
  app.get<{ Params: { id: string } }>("/api/agile/releases/:id/summary", async (request, reply) => {
    try {
      const summary = await readReleaseSummary(db, ownerKeysFor(request), request.params.id);
      if (!summary) return reply.code(404).send({ error: "RELEASE_NOT_FOUND", message: "发布不存在" });
      return summary;
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agile/releases/:id/retrospective", async (request, reply) => {
    try {
      const retrospective = await readReleaseRetrospective(db, ownerKeysFor(request), request.params.id);
      if (!retrospective) return reply.code(404).send({ error: "RELEASE_NOT_FOUND", message: "发布不存在" });
      return retrospective;
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  /**
   * Sprint 4 core: read-only, owner-scoped sprint metrics + project rollup.
   * Optional `?projectId=` / `?sprintId=` narrow the scope; empty scopes return
   * explicit zeros (never a 500). The heavy lifting is `readAgileMetrics`.
   */
  app.get<{ Querystring: { projectId?: string; sprintId?: string } }>("/api/agile/metrics", async (request, reply) => {
    try {
      return await readAgileMetrics(db, ownerKeysFor(request), {
        projectId: request.query.projectId,
        sprintId: request.query.sprintId,
      });
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  // Sprint 4: owner-scoped saved model combinations ("模板"). Lightweight CRUD;
  // nothing is seeded, and the same name may be reused by a different owner.
  app.get("/api/templates", async (request, reply) => {
    try {
      return { templates: await agile.listTemplates(ownerKeysFor(request)) };
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.post("/api/templates", async (request, reply) => {
    const parsed = templateCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    try {
      return reply.code(201).send(await agile.createTemplate(currentUser(request).id, parsed.data));
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    try {
      await agile.deleteTemplate(ownerKeysFor(request), request.params.id, await deps.isAdmin(currentUser(request).id));
      return reply.code(204).send();
    } catch (error) {
      return agileErrorReply(reply, error);
    }
  });
}
