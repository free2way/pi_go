import { readFile } from "node:fs/promises";
import type { CurrentUser } from "../shared/types.js";
import { syncStorageAlerts, type WorkspaceStorageStatus } from "./storage-alerts.js";
import { readQueueObservation, syncQueueAlerts } from "./queue-alerts.js";
import { buildDeploymentStatus, parseDeployLog, resolveDeployLogPath, type DeploymentStatus } from "./deployments.js";
import {
  FAILURE_SCAN_LIMIT,
  USAGE_RUN_SCAN_LIMIT,
  buildSystemStatus,
  utcDayStart,
  type DeploymentInfo,
  type FailureEventRow,
  type StateCountRow,
  type SystemStatusInput,
  type TodayRunRow,
} from "./system-status.js";
import { serverDiagnosticMessage } from "./server-diagnostics.js";
import type { WebServices } from "./web-services.js";

export function registerHealthRoutes(services: WebServices) {
  const {
    JOB_STALE_MS,
    alerts, app, auth, db, identities, jobQueue, pingDatabase, safeTokenMatch, webVersion,
    workerRequest, workerUrl,
  } = services;

  app.get("/api/health", async (_request, reply) => {
    try {
      await pingDatabase();
      alerts.clear("database_unavailable");
      return { status: "ok", service: "pigo-web", version: webVersion, db: "ok", authMode: auth.authMode };
    } catch (error) {
      // AT-REL-005: fail loudly instead of pretending the service is healthy.
      alerts.raise({
        key: "database_unavailable",
        severity: "critical",
        message: "数据库不可用，Web 已降级：运行/事件读写暂停",
        details: { error: serverDiagnosticMessage(error, { limit: 200 }) },
      });
      return reply.code(503).send({ status: "degraded", service: "pigo-web", version: webVersion, db: "unavailable", authMode: auth.authMode, code: "DATABASE_UNAVAILABLE" });
    }
  });

  /** REL-006: one place to inspect database, queue, worker and disk health. */
  app.get("/api/health/detail", async (request, reply) => {
    const internal = safeTokenMatch(request.headers.authorization);
    if (!internal && !auth.user(request)) return reply.code(401).send({ error: "Unauthorized" });
    const health: Record<string, unknown> = { version: webVersion, at: new Date().toISOString() };
    try {
      await pingDatabase();
      health.database = { status: "ok" };
      alerts.clear("database_unavailable");
    } catch (error) {
      health.database = { status: "unavailable", error: serverDiagnosticMessage(error, { limit: 200 }) };
      alerts.raise({ key: "database_unavailable", severity: "critical", message: "数据库不可用", details: {} });
    }
    if (jobQueue) {
      try {
        const queue = await readQueueObservation(db, JOB_STALE_MS);
        health.queue = { pending: queue.pending, reclaimedFromDeadWorker: queue.stale };
        syncQueueAlerts(alerts, queue, JOB_STALE_MS);
      } catch (error) {
        health.queue = { status: "unavailable", error: serverDiagnosticMessage(error, { limit: 200 }) };
      }
    }
    const worker = await workerRequest<{ activeJobs: number }>("/health").then((value) => value).catch(() => undefined);
    if (worker) {
      alerts.clear("worker_unreachable");
      const storage = await workerRequest<WorkspaceStorageStatus>("/health/storage").catch(() => undefined);
      health.worker = { status: "ok", activeJobs: worker.activeJobs, storage: storage ?? null };
      syncStorageAlerts(alerts, storage);
    } else {
      health.worker = { status: "unreachable" };
      alerts.raise({ key: "worker_unreachable", severity: "critical", message: "无法连接 Worker，任务执行暂停", details: { workerUrl } });
    }
    health.alerts = alerts.activeKeys;
    return health;
  });
  app.get("/api/me", async (request): Promise<CurrentUser> => {
    const user = auth.user(request);
    return { ...user, isAdmin: await identities.isAdmin(user.id) };
  });

  /** Public bootstrap data only; Clerk's publishable key is intentionally client-safe. */
  app.get("/api/auth/config", async () => auth.publicConfig());
}

export function registerSystemStatusRoutes(services: WebServices) {
  const {
    app, auth, db, identities, pingDatabase, workerRequest,
  } = services;

  /**
   * A3: read-only deployment status. The deploy log is read defensively: a missing
   * file reports `available: false` and an empty record list, never an error.
   */
  async function readDeploymentStatus(): Promise<DeploymentStatus> {
    const logPath = resolveDeployLogPath(process.env);
    let records = [] as ReturnType<typeof parseDeployLog>;
    let logAvailable = false;
    let logError: string | undefined;
    try {
      const content = await readFile(logPath, "utf8");
      records = parseDeployLog(content);
      logAvailable = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") logError = serverDiagnosticMessage(error, { limit: 200 });
    }
    return buildDeploymentStatus({ env: process.env, records, logPath, logAvailable, logError });
  }

  app.get("/api/deployments", async () => readDeploymentStatus());

  const SYSTEM_FAILURE_TYPE_PATTERNS = ["%storage_error%", "%budget_exhausted%", "%provider_error%", "%failure_artifact%"];

  /**
   * SYS-01: system-wide, read-only status for the 「系统状态」 dashboard. Aggregates
   * are visible to any authenticated user, but only counts/timestamps/sanitised
   * summaries are returned — never credentials, environment values or paths.
   * Every query is bounded and each section degrades to `unavailable` on failure.
   */
  app.get("/api/system/status", async (request) => {
    const now = new Date().toISOString();
    // B7: failure summaries are admin-only; every authenticated user still gets
    // the category counts (recent details are suppressed below).
    const audience: "admin" | "user" = (await identities.isAdmin(auth.user(request).id)) ? "admin" : "user";
    const [deployments, workerHealth] = await Promise.all([
      readDeploymentStatus().catch(() => null),
      workerRequest<{ activeJobs?: number; version?: string; storage?: string }>("/health", undefined, 3_000).catch(() => undefined),
    ]);

    let database: { status: "ok" | "unavailable"; error?: string } = { status: "unavailable" };
    try {
      await pingDatabase(2_000);
      database = { status: "ok" };
    } catch (error) {
      // Classify failures through section state; log only a safe bounded cause.
      app.log.warn({ error: serverDiagnosticMessage(error, { limit: 200 }) }, "system status database ping failed");
    }

    const storage = workerHealth?.storage === "ok" || workerHealth?.storage === "low" || workerHealth?.storage === "critical" || workerHealth?.storage === "unknown"
      ? workerHealth.storage
      : undefined;
    const infrastructure: SystemStatusInput["infrastructure"] = {
      database,
      worker: workerHealth
        ? {
            status: "ok",
            activeJobs: typeof workerHealth.activeJobs === "number" ? workerHealth.activeJobs : undefined,
            storage,
          }
        : { status: "unreachable" },
    };

    let jobStates: StateCountRow[] | null = null;
    let runStates: StateCountRow[] | null = null;
    let todayRuns: TodayRunRow[] | null = null;
    let failures: FailureEventRow[] | null = null;
    try {
      const jobs = await db.query("SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at FROM jobs GROUP BY state");
      jobStates = jobs.rows as unknown as StateCountRow[];
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error, { limit: 200 }) }, "system status job aggregation failed");
    }
    try {
      const runs = await db.query("SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_at FROM runs GROUP BY state");
      runStates = runs.rows as unknown as StateCountRow[];
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error, { limit: 200 }) }, "system status run aggregation failed");
    }
    try {
      const usage = await db.query(`SELECT document_json FROM runs WHERE updated_at >= $1 LIMIT ${USAGE_RUN_SCAN_LIMIT}`, [utcDayStart(now)]);
      todayRuns = usage.rows as unknown as TodayRunRow[];
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error, { limit: 200 }) }, "system status usage aggregation failed");
    }
    try {
      const events = await db.query(
        `SELECT at, type, message FROM run_events WHERE at >= $1 AND (type LIKE $2 OR type LIKE $3 OR type LIKE $4 OR type LIKE $5) ORDER BY at DESC LIMIT ${FAILURE_SCAN_LIMIT}`,
        [new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString(), ...SYSTEM_FAILURE_TYPE_PATTERNS],
      );
      failures = events.rows as unknown as FailureEventRow[];
    } catch (error) {
      app.log.warn({ error: serverDiagnosticMessage(error, { limit: 200 }) }, "system status failure aggregation failed");
    }

    // Only the worker reports its own version over HTTP; fall back to the
    // deployment configuration and otherwise leave it unknown (`null`).
    const workerVersion = typeof workerHealth?.version === "string" && workerHealth.version.trim()
      ? workerHealth.version.trim()
      : (process.env.PI_WORKER_VERSION?.trim() || null);

    // Reuse the deployment payload but drop the deploy-log path: this response is
    // path-free by contract (the dedicated `/api/deployments` endpoint keeps it).
    const deploymentInfo: DeploymentInfo | null = deployments
      ? {
          web: deployments.web,
          worker: deployments.worker,
          rollbackTags: deployments.rollbackTags,
          records: deployments.records,
          // `error` is omitted too: file-read errors can embed the log path.
          log: { available: deployments.log.available },
          at: deployments.at,
        }
      : null;

    return buildSystemStatus({
      now,
      audience,
      versions: { web: deployments?.web.version ?? null, worker: workerVersion },
      infrastructure,
      jobStates,
      runStates,
      todayRuns,
      failures,
      deployments: deploymentInfo,
    });
  });

}
