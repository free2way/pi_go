import { clerkPlugin } from "@clerk/fastify";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRequestLocale, type Locale } from "../shared/i18n.js";
import type { CurrentUser, Run, RunEvent } from "../shared/types.js";
import { AlertManager, createAlertSink } from "./alerts.js";
import { registerOperationalMetrics } from "./operational-metrics.js";
import { metricsAuthorized } from "../shared/operational-metrics.js";
import { Authenticator, normalizePublicOrigin } from "./auth.js";
import { ExpiringLruCache } from "./expiring-lru-cache.js";
import { CredentialVault } from "./credential-vault.js";
import { sourceExportCredentials } from "./source-export-credentials.js";
import { normalizeReleaseCallbackOrigin, ReleaseSettingsStore } from "./release-settings.js";
import { releaseCallbackTokens, resolveReleaseRoute, type ReleaseEnvironment } from "./release-routing.js";
import { ScmSettingsStore } from "./scm-settings.js";
import { createDb, createPool, runMigrations } from "./db.js";
import { IdentityService } from "./identity.js";
import { defaultSelections, loadModelCatalog } from "./model-catalog.js";
import { type RunDirectoryCleaner } from "./run-cleanup.js";
import { createProviderProbe, providerProbeDisabled } from "./provider-probe.js";
import { verifyPendingCredentials } from "./credential-verification.js";
import { RateLimiter } from "./rate-limit.js";
import { PostgresRunStore } from "./run-store-pg.js";
import { artifactDiagnosticCredentials } from "./artifact-api.js";
import { requestErrorReply } from "./request-errors.js";
import { buildAcceptanceSnapshot } from "./acceptance.js";
import { planPostMergeDeploy } from "./run-merge.js";
import { resolveMergeRequestConfig, selectPatch, type PatchSelection } from "./run-patch.js";
import { AgileService } from "./agile.js";
import { AgentTeamService } from "./agent-teams.js";
import compress from "@fastify/compress";
import { cacheControlFor } from "./static-cache.js";
import type { RunStoreLike } from "./store.js";
import { scmWorkerTimeoutMs, WorkspaceService } from "./workspaces.js";
import { serverDiagnosticMessage, serverLoggerOptions } from "./server-diagnostics.js";
import { registerInternalAuthorization, safeSecretMatch } from "./routes/internal/auth.js";

export async function createWebServices() {
  const app = Fastify({
    logger: serverLoggerOptions(),
    bodyLimit: 64 * 1024,
  });

  // Register before plugins/routes so their contexts inherit this handler.
  app.setErrorHandler((error, _request, reply) => {
    const result = requestErrorReply(error);
    const { message } = result;
    if (result.storage) {
      alerts.raise({ key: "storage_failure", severity: "critical", message: "存储写入失败，任务未完成", details: { error: message.slice(0, 200) } });
      return reply.code(result.status).send(result.body);
    }
    if (result.status >= 500) app.log.error({ error: message }, "request failed");
    return reply.code(result.status).send(result.body);
  });

  // 响应压缩：JS/CSS/JSON 未压缩时要传 ~700 KB（实测首屏 702 KB JS），压缩后约 1/4。
  // 必须注册在任何路由之前才生效；`@fastify/compress` 的默认可压缩类型显式排除
  // `text/event-stream`，所以运行事件流（SSE）不会被压缩/缓冲。
  await app.register(compress, { global: true, encodings: ["br", "gzip", "deflate"], threshold: 1024 });
  const port = Number(process.env.PORT || 3100);
  const host = process.env.HOST || "localhost";
  const webVersion = process.env.PI_WEB_VERSION?.trim() || "0.27.5";
  const demoMode = process.env.PI_DEMO_MODE !== "false";
  const realRunsEnabled = process.env.PI_REAL_RUNS_ENABLED === "true";
  const workerUrl = process.env.PI_WORKER_URL || "http://worker:3200";
  const internalToken = process.env.PI_INTERNAL_TOKEN || "";
  const dataFile = process.env.PI_DATA_FILE || path.resolve("data/runs.json");
  const vaultFile = process.env.PI_VAULT_FILE || path.resolve("data/credentials.v1.json");
  const releaseSettingsFile = process.env.PI_RELEASE_SETTINGS_FILE || path.resolve("data/release-settings.v1.json");
  const scmSettingsFile = process.env.PI_SCM_SETTINGS_FILE || path.resolve("data/scm-settings.v1.json");
  const authMode = process.env.PI_AUTH_MODE || "development";
  const configuredPublicOrigin = process.env.PI_PUBLIC_ORIGIN?.trim() || "";
  const publicOrigin = configuredPublicOrigin
    ? normalizePublicOrigin(configuredPublicOrigin, { production: process.env.NODE_ENV === "production" })
    : "";
  const configuredReleaseCallbackOrigin = process.env.PI_RELEASE_CALLBACK_ORIGIN?.trim() || "";
  const releaseCallbackOrigin = configuredReleaseCallbackOrigin
    ? normalizeReleaseCallbackOrigin(configuredReleaseCallbackOrigin)
    : "";
  const vaultSecret = process.env.PI_VAULT_SECRET;
  if (!vaultSecret) throw new Error("PI_VAULT_SECRET is required");
  if ((authMode === "cloudflare" || authMode === "clerk") && !publicOrigin) {
    throw new Error("PI_PUBLIC_ORIGIN is required with external authentication");
  }

  const modelCatalog = loadModelCatalog();
  const modelDefaults = defaultSelections();
  const vault = new CredentialVault(vaultFile, vaultSecret, {
    developer: modelDefaults.developer.provider,
    reviewer: modelDefaults.reviewer.provider,
  });
  const releaseSettings = new ReleaseSettingsStore(releaseSettingsFile, vaultSecret);
  const scmSettings = new ScmSettingsStore(scmSettingsFile, vaultSecret);
  const auth = new Authenticator();
  if (auth.authMode === "clerk") {
    // Use Clerk's same-origin Frontend API proxy. Besides improving resilience to
    // privacy/ad-blocking rules, this keeps the __session cookie first-party so
    // native EventSource connections authenticate without putting JWTs in URLs.
    await app.register(clerkPlugin, {
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
      secretKey: process.env.CLERK_SECRET_KEY!,
      hookName: "onRequest",
      frontendApiProxy: { enabled: true, path: "/__clerk" },
    });
  }
  await Promise.all([vault.init(), releaseSettings.init(), scmSettings.init()]);
  // AUD-08 / AT-MODEL-004: live provider probe used to verify credentials. It is
  // injectable and never throws; a failed probe simply leaves a key unverified.
  const providerProbe = createProviderProbe();

  // AUD-08 cutover safety: credentials stored before live verification existed
  // have `verifiedAt === null` and would block every real run. Resolve them once at
  // startup, bounded so boot is not delayed by more than ~10s. Logs carry provider
  // names and outcomes only — never key material.
  try {
    const pending = vault.pendingVerifications();
    if (pending.length > 0) {
      const budgetMs = Number(process.env.PI_STARTUP_CREDENTIAL_PROBE_BUDGET_MS || 10_000);
      const pass = verifyPendingCredentials({
        listPending: () => pending,
        readKey: (userId, provider) => vault.get(userId, provider),
        probe: providerProbe,
        markVerified: (userId, provider, models, capabilities) => vault.markVerified(userId, provider, models, capabilities),
        markOperatorAsserted: (userId, provider) => vault.markOperatorAsserted(userId, provider),
        markUnverified: (userId, provider) => vault.markUnverified(userId, provider),
        probeDisabled: providerProbeDisabled,
        log: (message, detail) => app.log.info(detail ?? {}, message),
      }, { budgetMs });
      const outcome = await Promise.race([
        pass,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), budgetMs + 500);
          timer.unref?.();
        }),
      ]);
      if (outcome) {
        app.log.info(
          { pending: outcome.considered, verified: outcome.verified, asserted: outcome.asserted, unverified: outcome.unverified, skipped: outcome.skipped, deferred: outcome.deferred },
          "startup credential verification pass finished",
        );
      } else {
        app.log.warn({ pending: pending.length, budgetMs }, "startup credential verification pass exceeded its budget; continuing in the background");
      }
    }
  } catch (error) {
    app.log.warn({ error: serverDiagnosticMessage(error) }, "startup credential verification pass failed");
  }

  const databaseUrl = process.env.PI_DATABASE_URL;
  if (!databaseUrl) throw new Error("PI_DATABASE_URL is required (PostgreSQL connection URL)");
  const pool = createPool(databaseUrl, () => {
    app.log.warn({ code: "DATABASE_IDLE_CONNECTION_ERROR" }, "Database idle connection lost; health monitor will reconcile");
  });
  const db = createDb(pool);
  await runMigrations(db);

  // REL-001: runs, events, agents, checks, findings, artifacts, checkpoints and
  // jobs live in PostgreSQL. A legacy runs.json is imported once and kept intact.
  const store: RunStoreLike = new PostgresRunStore(db);
  const jobQueue = store instanceof PostgresRunStore ? store : undefined;
  await store.init();
  if (store instanceof PostgresRunStore && existsSync(dataFile)) {
    try {
      const legacy = JSON.parse(await readFile(dataFile, "utf8")) as { runs?: Run[]; events?: Record<string, RunEvent[]> };
      if ((legacy.runs ?? []).length > 0) {
        const before = await store.statistics();
        if (before.counts.runs === 0) {
          // Pre-owner-scoping runs (no ownerId) belong to the single legacy owner.
          const owners = (await db.query("SELECT id, legacy_owner_id FROM users")).rows;
          const defaultOwnerId = owners.length === 1 ? String(owners[0].legacy_owner_id ?? owners[0].id) : undefined;
          const result = await store.importLegacy({ runs: legacy.runs ?? [], events: legacy.events ?? {} }, { defaultOwnerId });
          app.log.info({ ...result, defaultOwnerId: Boolean(defaultOwnerId) }, "imported legacy runs.json into PostgreSQL");
        }
      }
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error) }, "legacy runs.json import skipped");
    }
  }
  const alerts = new AlertManager(createAlertSink({
    log: (level, payload, message) => app.log[level](payload, message),
    webhookUrl: process.env.PI_ALERT_WEBHOOK,
  }));
  const identities = new IdentityService(db);
  const workspacesEnabled = process.env.PI_WORKSPACES_ENABLED !== "false";
  // A1: merge-request creation is opt-in via PI_MERGE_REQUEST_*; when unset the
  // route refuses clearly (409 MERGE_REQUEST_NOT_CONFIGURED) instead of guessing.
  const mergeRequestConfig = resolveMergeRequestConfig(process.env);
  const scmRequestTimeoutMs = scmWorkerTimeoutMs(process.env.PI_SCM_WORKER_TIMEOUT_MS);
  const workspaces = new WorkspaceService(
    db,
    (pathName, init) => workerRequest(pathName, init, scmRequestTimeoutMs),
    scmSettings,
    (actorId) => sourceExportCredentials(actorId, vault, (id) => identities.legacyOwnerFor(id)),
  );
  const agile = new AgileService(db);
  const agentTeams = new AgentTeamService(db);
  // Open registration means this cache can no longer be an unbounded process-wide
  // Map. The TTL also lets a verified Clerk email change flow back through the
  // identity service instead of pinning the first observed address until restart.
  const userCache = new ExpiringLruCache<CurrentUser>({ maxEntries: 5_000, ttlMs: 5 * 60_000 });

  // SEC-008 / AT-SEC-005: per-user write limits for credential and run mutations.
  const credentialWrites = new RateLimiter(10);
  const runCreations = new RateLimiter(Number(process.env.PI_RUN_CREATE_PER_MINUTE || 20));
  const runActions = new RateLimiter(Number(process.env.PI_RUN_ACTIONS_PER_MINUTE || 30));
  const requirementRefinements = new RateLimiter(Number(process.env.PI_REQUIREMENT_ASSISTANT_PER_MINUTE || 12));
  const piAssistantQuestions = new RateLimiter(Number(process.env.PI_ASSISTANT_PER_MINUTE || 20));

  /** GAP-01: the budget that applied when the run was created (also shown in the UI). */
  function readRunBudget() {
    return {
      maxTokens: Number(process.env.PI_RUN_MAX_TOKENS || 0),
      maxCostUsd: Number(process.env.PI_RUN_MAX_COST_USD || 0),
      maxModelCalls: Number(process.env.PI_RUN_MAX_MODEL_CALLS || 0),
      // 0 = 不限制（与 worker 语义一致）：缺省时不得隐式套用 1800s 上限。
      maxDurationSeconds: Number(process.env.PI_RUN_MAX_DURATION_SECONDS ?? process.env.PI_RUN_TIMEOUT_SECONDS ?? 0) || 0,
    };
  }

  /** GAP-01: credential version marker (never the credential itself). */
  function credentialFingerprint(apiKey: string | undefined) {
    if (!apiKey) return undefined;
    return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  }

  /** GAP-01: workflow/prompt/plugin policy snapshot. */
  const PIPELINE_VERSION = process.env.PI_PIPELINE_VERSION || "pigo-pipeline-1";

  /** Terminal run states (used for artifact persistence and cleanup). */
  const TERMINAL_RUN_STATES = new Set<Run["state"]>(["completed", "needs_human", "failed", "cancelled"]);

  /**
   * AUD-16 / AT-GIT-004, AT-UI-005: persist the unified diff reported for a run as
   * a downloadable artifact once the run reaches a terminal state. The body is the
   * exact patch the worker produced against the run's pinned base SHA; storing it
   * (instead of only length/hash) is what makes a full download possible.
   */
  async function persistTerminalDiffArtifact(run: Run | undefined) {
    if (!run || !TERMINAL_RUN_STATES.has(run.state) || !run.diff) return;
    try {
      await store.saveArtifact({
        runId: run.id,
        artifactId: "diff",
        kind: "patch",
        content: run.diff,
        baseSha: run.baseSha ?? null,
        createdAt: run.updatedAt,
      });
    } catch (error) {
      app.log.warn({ runId: run.id, error: serverDiagnosticMessage(error) }, "failed to persist diff artifact");
    }
  }

  /** AUD-16: download cap so one artifact can never be streamed without bound. */
  const ARTIFACT_DOWNLOAD_MAX_BYTES = Number(process.env.PI_ARTIFACT_MAX_DOWNLOAD_BYTES || 5 * 1024 * 1024);

  type RunPatchResolution =
    | { ok: true; selection: PatchSelection }
    | { ok: false; status: 409 | 503; code: string; error: string };

  /**
   * A1: resolves the authoritative patch for a run. Prefers the stored artifact
   * (full body), falls back to the inline diff, and only then asks the worker to
   * regenerate it from the run directory the same way it does during execution.
   * A regenerated body is persisted so later downloads do not need the worker.
   */
  async function resolveRunPatch(run: Run): Promise<RunPatchResolution> {
    const artifact = await store.getArtifact(run.id, "diff").catch(() => undefined);
    const direct = selectPatch({
      artifact: artifact
        ? { artifactId: artifact.artifactId, content: artifact.content, sha256: artifact.sha256, bytes: artifact.bytes }
        : undefined,
      runDiff: run.diff,
      baseSha: artifact?.baseSha ?? run.baseSha,
    });
    if (direct) return { ok: true, selection: direct };

    let generated: { diff?: string; baseSha?: string | null };
    try {
      generated = await workerRequest<{ diff?: string; baseSha?: string | null }>(`/runs/${encodeURIComponent(run.id)}/diff`, {
        method: "POST",
        body: JSON.stringify({ ownerId: run.ownerId, baseSha: run.baseSha, repository: run.repository }),
      });
    } catch (error) {
      return { ok: false, status: 503, code: "PATCH_UNAVAILABLE", error: `无法生成补丁：${serverDiagnosticMessage(error)}` };
    }
    const selection = selectPatch({
      artifact: artifact
        ? { artifactId: artifact.artifactId, content: artifact.content, sha256: artifact.sha256, bytes: artifact.bytes }
        : undefined,
      runDiff: run.diff,
      worktreeDiff: generated.diff,
      baseSha: generated.baseSha ?? run.baseSha,
    });
    if (!selection) return { ok: false, status: 409, code: "PATCH_UNAVAILABLE", error: "该任务没有可导出的补丁" };
    if (selection.origin === "worktree") {
      await store
        .saveArtifact({ runId: run.id, artifactId: "diff", kind: "patch", content: selection.content, baseSha: selection.baseSha, createdAt: run.updatedAt })
        .catch((error) => app.log.warn({ runId: run.id, error: serverDiagnosticMessage(error) }, "failed to persist regenerated diff artifact"));
    }
    return { ok: true, selection };
  }

  function tooManyRequests(reply: FastifyReply, retryAfterMs: number) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return reply.code(429).send({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
  }

  function safeTokenMatch(value: string | undefined) {
    return safeSecretMatch(value, internalToken);
  }

  async function workerRequest<T>(pathName: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
    const response = await fetch(`${workerUrl}${pathName}`, {
      ...init,
      headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (!response.ok) {
      const failure = new Error(body.error || `Worker request failed: ${response.status}`) as Error & { code?: string; status?: number };
      failure.code = body.code;
      failure.status = response.status;
      throw failure;
    }
    return body as T;
  }

  /**
   * GAP-04 storage follow-up: asks the worker to remove a finished run's on-disk
   * directory tree (standalone clone, sub-agent worktrees, reviewer snapshots and
   * the per-run Pi state directories). Best-effort by design: the caller shapes a
   * `kept` outcome instead of failing the cleanup request.
   */
  const runDirectoryCleaner: RunDirectoryCleaner = ({ runId, ownerId, dryRun }) =>
    workerRequest(`/runs/${encodeURIComponent(runId)}/cleanup`, {
      method: "POST",
      body: JSON.stringify({ ownerId, dryRun }),
    });

  registerOperationalMetrics(app, { db, pool, version: webVersion });
  const activeReleaseTokens = () => releaseCallbackTokens(releaseSettings.get(), process.env);
  registerInternalAuthorization(app, {
    worker: safeTokenMatch,
    release: (authorization) => activeReleaseTokens().some((token) => safeSecretMatch(authorization, token)) || safeTokenMatch(authorization),
    metrics: (authorization) => metricsAuthorized(authorization, process.env.PI_METRICS_TOKEN?.trim() || "", internalToken),
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // 按路径区分：API 不缓存；带 hash 的构建产物长缓存 immutable；index.html/SPA 回退走
    // no-cache（每次校验）。策略见 static-cache.ts，那里有单元测试。
    reply.header("Cache-Control", cacheControlFor(request.url));
    return payload;
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url === "/api/health" || request.url === "/api/auth/config" || request.url.startsWith("/api/internal/")) return;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && publicOrigin) {
      const origin = request.headers.origin;
      if (origin && origin !== publicOrigin) return reply.code(403).send({ error: "Origin not allowed" });
    }
    const unauthorized = await auth.authenticate(request, reply);
    if (unauthorized) return unauthorized;
    const identity = auth.identity(request);
    const cacheKey = `${identity.issuer}|${identity.subject}`;
    const cached = userCache.get(cacheKey);
    if (cached) return auth.setUser(request, cached);
    const record = await identities.resolve({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      identityProvider: identity.identityProvider,
      legacyOwnerId: identity.legacyOwnerId,
    });
    const user: CurrentUser = { id: record.id, email: record.email, legacyOwnerId: record.legacyOwnerId ?? undefined };
    userCache.set(cacheKey, user);
    auth.setUser(request, user);
  });

  function ownerKeysFor(request: FastifyRequest) {
    const user = auth.user(request);
    return user.legacyOwnerId ? [user.id, user.legacyOwnerId] : [user.id];
  }

  /**
   * Locale of a request that produces code-generated runtime text
   * (docs/24-i18n.md §9): `Accept-Language` first, then `?locale=`, then `zh`.
   * The resolution is pure and lives in `src/shared/i18n.ts` so the server routes
   * and their tests share one rule; a request that expresses neither preference
   * reads as Chinese, exactly as before this change.
   */
  function requestLocale(request: FastifyRequest): Locale {
    const query = (request.query ?? {}) as { locale?: unknown };
    return resolveRequestLocale(request.headers["accept-language"], query.locale);
  }

  /** Narrows vault lookups into a complete credential pair or nothing. */
  function requireCredentials(input: { developer?: string; reviewer?: string }): { developer: string; reviewer: string } | undefined {
    const { developer, reviewer } = input;
    if (!developer || !reviewer) return undefined;
    return { developer, reviewer };
  }

  /** Credentials written before the internal-user migration live under the legacy owner key. */
  function vaultKeyFor(request: FastifyRequest) {
    const user = auth.user(request);
    return user.legacyOwnerId ?? user.id;
  }

  /**
   * Decrypted per-user credential read for the decision plane. Only presence is
   * ever projected; the value is handed straight to the engine's key resolver and
   * is never logged, evented or persisted. A corrupt/unreadable record degrades to
   * "no key" (the route then reports `missing_credentials`) instead of failing the
   * internal evaluate route.
   *
   * AT-REL-002: like `jobCredentialsFor`, the vault may hold the credential under
   * the internal user id **or** under its legacy owner key, so both are tried.
   */
  async function readVaultKey(userId: string, provider: string): Promise<string | undefined> {
    const candidates = [userId];
    const legacy = await identities.legacyOwnerFor(userId).catch(() => undefined);
    if (legacy && legacy !== userId) candidates.push(legacy);
    for (const key of candidates) {
      try {
        const found = vault.get(key, provider);
        if (found !== undefined && found !== "") return found;
      } catch (error) {
        app.log.warn({ provider, error: serverDiagnosticMessage(error) }, "credential vault read failed");
      }
    }
    return undefined;
  }

  /** Presence-only vault check for the `/api/config/status` decision-engine block. */
  async function hasVaultDecisionKey(userId: string) {
    return Boolean((await readVaultKey(userId, "typesafe")) || (await readVaultKey(userId, "jev")));
  }

  function readArtifactCredentials(run: Run) {
    return artifactDiagnosticCredentials(run, vault, (ownerId) => identities.legacyOwnerFor(ownerId));
  }

  /** Bounded liveness ping: a frozen database must not hang the health probe. */
  async function pingDatabase(timeoutMs = 2_500) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.query("SELECT 1"),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("database ping timeout")), timeoutMs);
        }),
      ]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }


  function effectiveReleaseConfig(environment: ReleaseEnvironment) {
    const saved = releaseSettings.get();
    const route = resolveReleaseRoute({ environment, ...(saved ? { saved } : {}), variables: process.env });
    return {
      deployPlan: planPostMergeDeploy(route.webhookUrl),
      webhookToken: route.webhookToken,
      callbackOrigin: saved?.publicOrigin ?? (releaseCallbackOrigin || publicOrigin),
      source: route.source,
      environmentSpecific: route.environmentSpecific,
    };
  }


  /**
   * B2: builds the durable acceptance snapshot for a run, preferring the stored
   * diff artifact's identity over re-hashing the inline diff.
   */
  async function acceptanceSnapshotFor(run: Run, input: {
    acceptedAt: string;
    acceptedBy: string;
    note?: string;
    acknowledgedOpenFindings?: boolean;
  }) {
    const artifact = await store.getArtifact(run.id, "diff").catch(() => undefined);
    return buildAcceptanceSnapshot({
      run,
      acceptedAt: input.acceptedAt,
      acceptedBy: input.acceptedBy,
      note: input.note,
      acknowledgedOpenFindings: input.acknowledgedOpenFindings,
      artifact: artifact ? { artifactId: artifact.artifactId, sha256: artifact.sha256, bytes: artifact.bytes } : undefined,
    });
  }


  const JOB_STALE_MS = Number(process.env.PI_JOB_STALE_SECONDS || 120) * 1_000;

  return {
    JOB_STALE_MS, ARTIFACT_DOWNLOAD_MAX_BYTES, PIPELINE_VERSION, TERMINAL_RUN_STATES, acceptanceSnapshotFor,
    activeReleaseTokens, agile, agentTeams, alerts, app, auth, credentialFingerprint, credentialWrites, dataFile,
    db, demoMode, effectiveReleaseConfig, hasVaultDecisionKey, host, identities, internalToken,
    jobQueue, mergeRequestConfig, modelCatalog, modelDefaults, ownerKeysFor,
    persistTerminalDiffArtifact, piAssistantQuestions, pingDatabase, pool, port, providerProbe,
    publicOrigin, readArtifactCredentials, readRunBudget, readVaultKey, realRunsEnabled,
    releaseCallbackOrigin, releaseSettings, releaseSettingsFile, requestLocale, requireCredentials,
    requirementRefinements, resolveRunPatch, runActions, runCreations, runDirectoryCleaner,
    safeTokenMatch, scmSettingsFile, store, tooManyRequests, vault, vaultFile, vaultKeyFor, webVersion,
    workerRequest, workerUrl, workspaces, workspacesEnabled,
  };
}

export type WebServices = Awaited<ReturnType<typeof createWebServices>>;
