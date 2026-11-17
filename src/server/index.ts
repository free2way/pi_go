import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readQueueObservation, syncQueueAlerts } from "./queue-alerts.js";
import { createInfrastructureAlertSweeper } from "./infrastructure-alerts.js";
import { createProviderAlertSweeper, readProviderAlertObservation } from "./provider-alerts.js";
import { diagnosticSecrets, redactDiagnosticText } from "../shared/diagnostics.js";
import { DecisionAuditStore } from "./decision-engine/audit-store.js";
import { createDecisionEngine, loadDecisionEngineConfig } from "./decision-engine/index.js";
import { decisionCircuitSnapshot } from "./decision-engine/jev.js";
import { createDecisionMetricsSweeper } from "./decision-engine/metrics.js";
import { buildReviewTriageBatches } from "./decision-engine/review-triage.js";
import { registerDecisionReadRoutes, registerInternalDecisionRoutes, type DecisionServices } from "./decision-routes.js";
import { registerProviderCreditsRoutes } from "./provider-credits-routes.js";
import { readModelPriceTable, readProviderCreditBook, writeProviderCreditBook } from "./provider-cost-config.js";
import { isBuildAssetRequest } from "./static-cache.js";
import { registerInternalJobRoutes } from "./routes/internal/jobs.js";
import { registerInternalReleaseRoutes } from "./routes/internal/releases.js";
import { registerInternalRunRoutes } from "./routes/internal/runs.js";
import { createWebServices } from "./web-services.js";
import { registerHealthRoutes, registerSystemStatusRoutes } from "./system-routes.js";
import { registerWebSettingsRoutes } from "./web-settings-routes.js";
import { createWorkspaceAgileRoutes } from "./workspace-agile-routes.js";
import { registerRunReadRoutes } from "./run-read-routes.js";
import { createWebJobQueue } from "./web-job-queue.js";
import { createRunAdmission } from "./run-admission.js";
import { createRunHumanRoutes } from "./run-human-routes.js";
import { registerRunReleaseRoutes } from "./run-release-routes.js";

const services = await createWebServices();
const {
  JOB_STALE_MS, activeReleaseTokens, agile, alerts, app, auth, db, host, identities, jobQueue, modelCatalog,
  ownerKeysFor, persistTerminalDiffArtifact, pingDatabase, pool, port, readArtifactCredentials,
  readVaultKey, store, workerRequest,
} = services;
const queue = createWebJobQueue(services);
const workspace = createWorkspaceAgileRoutes(services);
const admission = createRunAdmission(services, queue, workspace);
const human = createRunHumanRoutes(services, queue, workspace);
const { jobCredentialsFor, requeueStaleJobs, expireStaleReleaseDeploys } = queue;
const { agileErrorReply, reconcileStoryForRun } = workspace;

registerHealthRoutes(services);
registerWebSettingsRoutes(services);
registerSystemStatusRoutes(services);
workspace.registerWorkspaceApi();
workspace.registerAgileApi(admission.startRealRun);
registerRunReadRoutes(services);
admission.registerRunAdmissionRoutes();
human.registerRunApprovalRoute();
registerRunReleaseRoutes(services, workspace);
human.registerRunManagementRoutes();
admission.registerRunFollowupRoutes();

registerInternalRunRoutes(app, { store, jobQueue, persistTerminalDiffArtifact, reconcileStoryForRun, readArtifactCredentials });
registerInternalJobRoutes(app, { store, jobQueue, staleAfterMs: JOB_STALE_MS, jobCredentialsFor });
registerInternalReleaseRoutes(app, { agile, store, releaseTokens: activeReleaseTokens, agileErrorReply });

/**
 * docs/26 §8: the decision plane's internal evaluate API and the owner-scoped,
 * read-only audit query API. The evaluate route is authenticated with the SAME
 * worker token as the other worker endpoints through the internal preHandler.
 */
const decisionAudit = new DecisionAuditStore(db);
const decisionServices: DecisionServices = {
  store,
  audit: decisionAudit,
  env: process.env,
  // A vault-stored per-user key may supply the credentials that the strict env
  // loader no longer requires; the route reports `missing_credentials` itself
  // when neither the vault nor the environment resolves one.
  loadConfig: (env) => loadDecisionEngineConfig(env, { allowMissingApiKey: true }),
  createEngine: createDecisionEngine,
  buildBatches: buildReviewTriageBatches,
  ownerKeysFor,
  readVaultKey,
  // docs/26 §16.1: the metrics route is a normal session route (owner-agnostic
  // operational aggregate); the global preHandler has already resolved the user.
  sessionAuthorized: (request) => {
    try {
      return Boolean(auth.user(request));
    } catch {
      return false;
    }
  },
  circuits: () => decisionCircuitSnapshot(),
  // AT-JEV-081: a `jev-latest` alias that starts resolving to a new model version
  // raises one deduplicated warning through the existing AlertManager (structured
  // log + optional PI_ALERT_WEBHOOK). Details carry ids and version strings only.
  raiseAlert: (alert) => alerts.raise(alert),
};
registerInternalDecisionRoutes(app, decisionServices);
registerDecisionReadRoutes(app, decisionServices);

/**
 * AT-JEV-062：provider 额度是**人工录入**的（账户余额查不到），已花费由决策审计的
 * token × 价目表算出。GET 是运营读数（与会话内其它读数同级、owner-agnostic、不含任何
 * run/评估 id 与密钥）；PUT 是管理员操作，与工作区注册/合并/发布同一档。
 */
registerProviderCreditsRoutes(app, {
  sessionAuthorized: (request) => {
    try {
      return Boolean(auth.user(request));
    } catch {
      return false;
    }
  },
  isAdmin: async (request) => identities.isAdmin(auth.user(request).id),
  readCredits: () => readProviderCreditBook({ env: process.env, warn: (message, details) => app.log.warn(details, message) }),
  writeCredits: (book) => {
    writeProviderCreditBook(book, { env: process.env });
  },
  readPrices: () => readModelPriceTable({ env: process.env, warn: (message, details) => app.log.warn(details, message) }),
  // 已花费要覆盖"从有审计以来"：下界取 epoch（created_at 是定宽 ISO 文本，字典序即时间序）。
  // 审计读取有行数上限，超过时会如实把 spentComplete 标成 false（金额只是已读部分的下界）。
  listRecent: (options) => decisionAudit.listRecent({ sinceIso: new Date(0).toISOString(), limit: options.limit }),
  warn: (message, details) => app.log.warn(details, message),
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(currentDir, "../client");
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    // 构建产物缺失就是真的缺失：回退成 index.html 会让浏览器把 HTML 当 JS/CSS 解析
    // （旧 hash 的请求在重新发布后就会这样），这里的 404 让它显式失败。
    if (isBuildAssetRequest(request.url)) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}

// REL-002: jobs left unfinished by a stopped worker are re-queued and (when the
// worker is back) pushed again, so a run never stalls silently.
await requeueStaleJobs();
// AUD-P1: asynchronous release deploys that never called back are failed after
// the bounded timeout, which is what makes an explicit retry possible.
await expireStaleReleaseDeploys();
let jobRecoveryInFlight = false;
const jobRecoveryTimer = setInterval(() => {
  if (jobRecoveryInFlight) return;
  jobRecoveryInFlight = true;
  void (async () => {
    await requeueStaleJobs();
    await expireStaleReleaseDeploys();
    if (jobQueue) {
      const queue = await readQueueObservation(db, JOB_STALE_MS);
      syncQueueAlerts(alerts, queue, JOB_STALE_MS);
    }
  })().catch((error) => {
    app.log.warn({ error: redactDiagnosticText(error instanceof Error ? error.message : String(error), diagnosticSecrets()) }, "queue alert observation failed");
  }).finally(() => { jobRecoveryInFlight = false; });
}, 60_000);
jobRecoveryTimer.unref?.();

// A healthy queue or an open health page must not be a prerequisite for
// detecting database, Worker or disk failures. Independent bounded observers
// keep one unavailable dependency from suppressing another's alert.
const infrastructureAlerts = createInfrastructureAlertSweeper({
  alerts,
  database: () => pingDatabase(),
  worker: () => workerRequest("/health", undefined, 2_500),
  storage: () => workerRequest("/health/storage", undefined, 2_500),
});
infrastructureAlerts.start();
const providerAlerts = createProviderAlertSweeper({
  alerts,
  read: () => readProviderAlertObservation(db, modelCatalog.map((model) => model.provider)),
  warn: () => app.log.warn("provider alert observation failed"),
});
providerAlerts.start();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { infrastructureAlerts.stop(); providerAlerts.stop(); });
}

// docs/26 §16.1 / AT-JEV L2 gate: the decision-plane metrics sweep. It runs in
// the web process (the only process that owns `decision_evaluations`) and only
// when the plane is configured to produce evaluations — a default `disabled`
// deployment performs zero queries here. Interval and thresholds come from the
// `PI_DECISION_METRICS_*` / `PI_DECISION_ALERT_*` env (invalid ⇒ documented
// default). Alerts go through the same `AlertManager` as every other
// infrastructure alert, so dedup/cooldown/webhook behaviour is unchanged.
const decisionMetricsSweeper = createDecisionMetricsSweeper({
  env: process.env,
  enabled: () => {
    const loaded = loadDecisionEngineConfig(process.env, { allowMissingApiKey: true });
    return loaded.ok && loaded.config.engine !== "disabled";
  },
  listRecent: (query) => decisionAudit.listRecent(query),
  circuits: () => decisionCircuitSnapshot(),
  raise: (alert) => {
    alerts.raise(alert);
  },
  clear: (key) => alerts.clear(key),
  warn: (message, details) => app.log.warn(details, message),
});
decisionMetricsSweeper.start();

await app.listen({ port, host });
