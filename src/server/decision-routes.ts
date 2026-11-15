import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DecisionMetricsResponse } from "../shared/decision-metrics.js";
import { projectDecision, type DecisionServices } from "./decision-contract.js";
import { decisionMaxConcurrent, evaluateDecisionForRun } from "./decision-evaluation.js";
import { createAdmissionController } from "./decision-engine/admission.js";
import { createDecisionAuditRetentionSweeper } from "./decision-engine/audit-retention.js";
import {
  DECISION_AUDIT_DEFAULT_ROWS,
  DECISION_AUDIT_MAX_ROWS,
  type DecisionAuditPruneStore,
  type DecisionAuditStoreLike,
} from "./decision-engine/audit-store.js";
import { decisionCircuitSnapshot } from "./decision-engine/jev.js";
import { readDecisionMetrics, resolveDecisionMetricsConfig } from "./decision-engine/metrics.js";

export {
  DECISION_KEY_PROVIDERS,
  decisionEngineStatus,
  envDecisionApiKey,
  projectDecision,
  resolveDecisionApiKey,
  type BuildDecisionBatches,
  type CreateDecisionEngine,
  type DecisionConfigLoad,
  type DecisionEngineStatus,
  type DecisionEvaluateOutcome,
  type DecisionEvaluateResponse,
  type DecisionProjection,
  type DecisionRunStore,
  type DecisionServices,
  type ResolvedDecisionKey,
} from "./decision-contract.js";
export {
  batchEvaluationId,
  buildAuditRecord,
  DECISION_MAX_CONCURRENT_DEFAULT,
  DECISION_MAX_CONCURRENT_ENV,
  decisionMaxConcurrent,
  deriveEvaluationId,
  detailFromError,
  evaluateDecisionForRun,
  fallbackReasonFromError,
} from "./decision-evaluation.js";

/** `POST /api/internal/decisions/evaluate` body (docs/26 §8.1, phase 1 kind only). */
export const decisionEvaluateSchema = z
  .object({
    runId: z.string().trim().min(1).max(160),
    kind: z.literal("review_triage"),
  })
  .strict();

export const DECISION_EVALUATE_PATH = "/api/internal/decisions/evaluate";

/**
 * AT-JEV-056: internal trigger for one decision-audit retention sweep. The
 * worker owns the cadence (its maintenance tick), the web owns the policy and
 * the SQL, exactly like `POST /api/internal/jobs/pending` re-queues stale jobs.
 * Same internal-token auth as the other `/api/internal/*` routes.
 */
export const DECISION_AUDIT_RETENTION_PATH = "/api/internal/decisions/audit/retention";

/**
 * docs/26 §16.1: read-only decision-plane monitoring. Unlike the two internal
 * routes above it is a normal session route (the app's global `preHandler`
 * authenticates `/api/*`), because the data is an owner-agnostic operational
 * aggregate with no per-run and no per-owner detail — the same audience as
 * `GET /api/system/status`. It never returns a key, an outbound payload, a run
 * id or an evaluation id.
 */
export const DECISION_METRICS_PATH = "/api/decisions/metrics";

function asPruneStore(audit: DecisionAuditStoreLike): DecisionAuditPruneStore | undefined {
  const candidate = audit as Partial<DecisionAuditPruneStore>;
  return typeof candidate.pruneOlderThan === "function" ? (candidate as DecisionAuditPruneStore) : undefined;
}

export interface DecisionRouteDeps extends DecisionServices {
  internalAuthorized: (request: FastifyRequest) => boolean;
}

/** Registers the decision-plane routes with an injected worker guard. */
export function registerDecisionRoutes(app: FastifyInstance, deps: DecisionRouteDeps) {
  app.register(async (internal) => {
    internal.addHook("preHandler", async (request, reply) => {
      if (!deps.internalAuthorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    });
    registerInternalDecisionRoutes(internal, deps);
  });
  registerDecisionReadRoutes(app, deps);
}

export function registerInternalDecisionRoutes(app: FastifyInstance, deps: DecisionServices) {
  /**
   * AT-JEV-072: the evaluate route always runs behind an admission controller.
   * The cap comes from `PI_DECISION_MAX_CONCURRENT` (default 4); the warn sink is
   * the app logger. Built ONCE per registration so the counter is process-wide
   * (one controller per app), and so the WeakMap-keyed warning throttle sees a
   * stable deps identity.
   */
  const evaluateDeps: DecisionServices = {
    ...deps,
    admission: deps.admission ?? createAdmissionController({ maxConcurrent: decisionMaxConcurrent(deps.env) }),
    warn: deps.warn ?? ((message, details) => app.log.warn(details, message)),
  };

  app.post(DECISION_EVALUATE_PATH, async (request, reply) => {
    const parsed = decisionEvaluateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const result = await evaluateDecisionForRun(parsed.data, evaluateDeps);
    return reply.code(result.status).send(result.body);
  });

  /**
   * AT-JEV-056 (docs/27 §7.6): one throttled retention sweep, triggered by the
   * worker's maintenance loop. It is idempotent and safe to call often: the
   * sweeper is off by default (`PI_DECISION_AUDIT_RETENTION_DAYS=0`) and
   * throttled otherwise, and it never throws — a failure is reported as a warn
   * line and as `sweep: null` here. The response echoes the cleanup record
   * (policy values, cutoff, deleted count, deleted window) so the caller can
   * carry it; note the durable-audit gap documented in
   * `decision-engine/audit-retention.ts`.
   */
  const pruneStore = asPruneStore(deps.audit);
  const sweepAuditRetention = pruneStore
    ? createDecisionAuditRetentionSweeper({
        store: pruneStore,
        env: deps.env,
        ...(deps.now ? { now: deps.now } : {}),
        warn: (message, details) => app.log.warn(details, message),
      })
    : undefined;
  app.post(DECISION_AUDIT_RETENTION_PATH, async (request, reply) => {
    if (!sweepAuditRetention) {
      // Only a store without the retention seam (an old/injected fake) lands
      // here; the production store implements it.
      return reply.code(501).send({ ok: false, error: "Decision audit retention is not supported by this store" });
    }
    const sweep = await sweepAuditRetention();
    return { ok: true, skipped: sweep === undefined, sweep: sweep ?? null };
  });
}

export function registerDecisionReadRoutes(app: FastifyInstance, deps: DecisionServices) {
  app.get<{ Params: { runId: string }; Querystring: { limit?: string } }>(
    "/api/runs/:runId/decisions",
    async (request, reply) => {
      const run = deps.store.getRun(request.params.runId, deps.ownerKeysFor(request));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const requested = Number(request.query?.limit ?? DECISION_AUDIT_DEFAULT_ROWS);
      const limit = Number.isFinite(requested) ? requested : DECISION_AUDIT_DEFAULT_ROWS;
      const decisions = (await deps.audit.listByRun(run.id, Math.min(Math.max(limit, 1), DECISION_AUDIT_MAX_ROWS)))
        .map(projectDecision);
      // Redacted audit projection only: no outbound payload, no key, no idempotency key.
      return { decisions };
    },
  );

  /**
   * docs/26 §16.1: read-only decision-plane monitoring for the operations
   * dashboard. Session-authenticated (see `sessionAuthorized`), aggregate-only.
   *
   * The window comes from `PI_DECISION_METRICS_WINDOW_HOURS` (env, invalid ⇒
   * default) — there is no query parameter to escape. A store without the
   * `listRecent` seam, or a failing read, degrades to `available: false` with an
   * explicit empty metrics shape and a warn line: this route never 500s and
   * never guesses a value.
   */
  app.get(DECISION_METRICS_PATH, async (request, reply) => {
    if (!deps.sessionAuthorized?.(request)) return reply.code(401).send({ error: "Unauthorized" });
    const loaded = deps.loadConfig(deps.env);
    const enabled = loaded.ok && loaded.config.engine !== "disabled";
    const config = resolveDecisionMetricsConfig(deps.env);
    const warn = deps.warn ?? ((message, details) => app.log.warn(details, message));
    const circuits = () => deps.circuits?.() ?? decisionCircuitSnapshot();
    const listRecent = deps.audit.listRecent?.bind(deps.audit);
    if (!listRecent) {
      warn("decision metrics unavailable: the audit store has no listRecent seam", {});
      const degraded = await readDecisionMetrics({
        enabled: false,
        windowHours: config.windowHours,
        environment: deps.env,
        listRecent: async () => [],
        circuits,
        ...(deps.now ? { now: deps.now } : {}),
        warn,
      });
      const body: DecisionMetricsResponse = {
        schemaVersion: 1,
        available: false,
        enabled,
        window: degraded.window,
        computedAt: degraded.computedAt,
        metrics: degraded.metrics,
      };
      return body;
    }
    const read = await readDecisionMetrics({
      enabled,
      windowHours: config.windowHours,
      environment: deps.env,
      listRecent,
      circuits,
      ...(deps.now ? { now: deps.now } : {}),
      warn,
    });
    const body: DecisionMetricsResponse = {
      schemaVersion: 1,
      available: read.available,
      enabled: read.enabled,
      window: read.window,
      computedAt: read.computedAt,
      metrics: read.metrics,
    };
    return body;
  });
}
