/**
 * Decision-plane internal API + read-only query API (docs/26 §8/§13).
 *
 * Two surfaces live here:
 *
 *  - `POST /api/internal/decisions/evaluate` — called by the worker with the
 *    internal token only (the app's `preHandler` deliberately skips session auth
 *    for `/api/internal/*`, so a browser session can never reach it). It loads
 *    the run owner-agnostically, resolves the configuration, splits the review
 *    into payload-safe batches, and either returns a business-safe
 *    `disabled`/`fallback` result without any outbound call, or persists one
 *    audit row plus one event pair per batch and returns the evaluations. A Jev
 *    failure in one batch never fails another batch and never fails the
 *    development task (docs/26 §1.5).
 *  - `GET /api/runs/:runId/decisions` — the owner-scoped, redacted audit
 *    projection. It never returns the outbound payload and never a key.
 *
 * The orchestration is separated from the Fastify registration and takes its
 * collaborators as dependencies (the same split as `release-deploy.ts`), so the
 * whole flow — auth, idempotency, events, redaction — is testable without a
 * network, a database or the real adapter.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Run } from "../shared/types.js";
import {
  DECISION_AUDIT_DEFAULT_ROWS,
  DECISION_AUDIT_MAX_ROWS,
  type DecisionAuditPruneStore,
  type DecisionAuditStoreLike,
} from "./decision-engine/audit-store.js";
import { createDecisionAuditRetentionSweeper } from "./decision-engine/audit-retention.js";
import { createAdmissionController, type AdmissionController } from "./decision-engine/admission.js";
import { canonicalJson, questionSchemaHash, sha256Hex, stateManifest } from "./decision-engine/redaction.js";
import type { Alert } from "./alerts.js";
import {
  runReviewTriageBatches,
  type ReviewTriageBatch,
  type ReviewTriageInput,
} from "./decision-engine/review-triage.js";
import {
  FALLBACK_REASONS,
  type DecisionAnswer,
  type DecisionEngine,
  type DecisionEngineConfig,
  type DecisionEvaluation,
  type DecisionEvaluationRecord,
  type DecisionKind,
  type DecisionMode,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionStatus,
  type FallbackReason,
} from "./decision-engine/types.js";

/** The subset of `RunStoreLike` the decision routes need. */
export interface DecisionRunStore {
  getRun(id: string, owner?: string | string[]): Run | undefined;
  appendEvent(
    event: { runId: string; round: number; source: "system" | "developer" | "checks" | "reviewer"; type: string; message: string; at: string; meta?: Record<string, unknown> },
    options?: { deliveryId?: string },
  ): Promise<unknown>;
}

/** Frozen contract of `loadDecisionEngineConfig` (docs/26 §11). */
export type DecisionConfigLoad =
  | { ok: true; config: DecisionEngineConfig }
  | { ok: false; reason: FallbackReason; detail: string };

/** Frozen contract of `buildReviewTriageBatches` (docs/26 §9.2). */
export type BuildDecisionBatches = (input: ReviewTriageInput) => ReviewTriageBatch[];

/** Frozen contract of `createDecisionEngine`. */
export type CreateDecisionEngine = (
  config: DecisionEngineConfig,
  deps?: { fetchImpl?: typeof fetch; resolveApiKey?: () => string | undefined; breakerScope?: string },
) => DecisionEngine;

/**
 * Provider ids a decision-plane key may be stored under, in resolution order.
 * `typesafe` is canonical; `jev` is accepted as an alias for operators who keyed
 * the credential by the engine name.
 */
export const DECISION_KEY_PROVIDERS = ["typesafe", "jev"] as const;

export interface DecisionRouteDeps {
  store: DecisionRunStore;
  audit: DecisionAuditStoreLike;
  env: NodeJS.ProcessEnv;
  loadConfig: (env: NodeJS.ProcessEnv) => DecisionConfigLoad;
  createEngine: CreateDecisionEngine;
  /**
   * Splits one review into independent, payload-safe batches (docs/26 §9.2).
   * Production wires `buildReviewTriageBatches`; tests inject a fake (or a
   * deliberately over-limit batch) without a provider or a network.
   */
  buildBatches: BuildDecisionBatches;
  /**
   * Internal-token guard. The route is registered by `index.ts` with
   * `(request) => safeTokenMatch(request.headers.authorization)`, exactly like
   * the other `/api/internal/*` routes — a browser session (cookie/JWT) never
   * satisfies it.
   */
  internalAuthorized: (request: FastifyRequest) => boolean;
  /** Same owner scoping as every other run route (`ownerKeysFor` in index.ts). */
  ownerKeysFor: (request: FastifyRequest) => string | string[];
  /**
   * Per-user credential-vault reader, injectable so tests need no vault. It is
   * consulted ONLY when the effective engine is `jev`: `disabled`/`mock` must
   * never cause a key lookup (no probe, no extra query). The returned value is
   * used only to build the engine's key resolver and never enters a projection,
   * an event or a log. MAY be async: the production wiring resolves the legacy
   * owner key (AT-REL-002) before reading the vault, like `jobCredentialsFor`.
   */
  readVaultKey?: (userId: string, provider: string) => string | undefined | Promise<string | undefined>;
  /** Injectable clock so the disabled path's `createdAt` is deterministic in tests. */
  now?: () => Date;
  /**
   * AT-JEV-081: alert sink for a model-alias drift (the requested alias starts
   * resolving to a new version). Production passes
   * `(alert) => alerts.raise(alert)` so the existing `AlertManager` owns
   * deduplication/cooldown; tests inject a spy. When omitted nothing is raised —
   * drift detection still runs, it just has no sink to report to.
   */
  raiseAlert?: (alert: Alert) => void;
  /**
   * AT-JEV-072: the decision plane's own pre-dispatch concurrency gate. The
   * evaluate route acquires one slot before it builds a batch or calls the
   * provider, and releases it when the request finishes (success, fallback or
   * throw). `registerDecisionRoutes` ALWAYS installs one (cap from
   * `PI_DECISION_MAX_CONCURRENT`, default 4), so the production route is always
   * bounded; a direct `evaluateDecisionForRun` caller that omits it runs
   * unbounded (the pre-existing behaviour) so the core stays unit-testable in
   * isolation.
   */
  admission?: AdmissionController;
  /**
   * Structured log sink for the (process-throttled) admission rejection warn.
   * `registerDecisionRoutes` wires `app.log.warn`; direct callers default to
   * `console.warn`, matching `createDecisionAuditRetentionSweeper`.
   */
  warn?: (message: string, details: Record<string, unknown>) => void;
}

/** Whitelisted, redacted projection of one audit row (docs/26 §8.2). */
export interface DecisionProjection {
  evaluationId: string;
  runId: string;
  kind: DecisionKind;
  mode: DecisionMode;
  provider: DecisionProvider;
  requestedModel: string;
  resolvedModel?: string;
  policyVersion: string;
  stateHash: string;
  questionSchemaHash: string;
  status: DecisionStatus;
  answers: DecisionAnswer[];
  appliedOutcome?: string;
  fallbackReason?: FallbackReason;
  detail?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  createdAt: string;
  stateManifest: Record<string, unknown>;
}

/**
 * The evaluate response. The `disabled`/fallback-without-config paths have no
 * evaluation id, model or hashes yet, so those stay optional here while the
 * persisted projection always fills them in.
 *
 * The top level mirrors the FIRST batch (the previous single-evaluation shape,
 * docs/26 §8.1); `batches` carries every batch of this review in order.
 */
export type DecisionEvaluateResponse = Partial<Omit<DecisionProjection, "stateManifest">> & {
  runId: string;
  kind: DecisionKind;
  mode: DecisionMode;
  provider: DecisionProvider;
  status: DecisionStatus;
  answers: DecisionAnswer[];
  latencyMs: number;
  createdAt: string;
  stateManifest?: Record<string, unknown>;
  /** One entry per payload-safe batch (docs/26 §9.2); `[0]` is mirrored above. */
  batches?: DecisionProjection[];
};

export type DecisionEvaluateOutcome =
  | { status: 200; body: DecisionEvaluateResponse }
  | { status: 404; body: { error: string } };

export interface DecisionEngineStatus {
  engine: DecisionEngineConfig["engine"];
  mode: DecisionMode;
  /** Engine is `jev` and a key is resolvable — the key itself is never surfaced. */
  configured: boolean;
  /**
   * Where the resolvable key came from, so the UI can explain itself: `vault`
   * (per-user credential vault or its `jev` alias), `env` (`TYPESAFE_API_KEY`),
   * or `null` when nothing resolves. Only reported for the `jev` engine.
   */
  keySource?: "vault" | "env" | null;
  policyVersion: string | null;
  /**
   * Present only when the configuration was rejected (docs/26 §11/AT-JEV-003):
   * the standard reason makes the preflight actionable ("missing_credentials")
   * without exposing any value.
   */
  reason?: FallbackReason;
}

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
 * Deterministic evaluation id: `runId + kind + policyVersion + stateHash`
 * (docs/26 §8.3). It is also the audit row's primary key, its `idempotency_key`
 * and the event delivery prefix, so a worker replay of the same state can never
 * double-charge the provider or the audit trail.
 */
export function deriveEvaluationId(input: {
  runId: string;
  kind: DecisionKind;
  policyVersion: string;
  stateHash: string;
}): string {
  const digest = sha256Hex(canonicalJson([input.runId, input.kind, input.policyVersion, input.stateHash]));
  return `de_${digest.slice(0, 32)}`;
}

/**
 * Deterministic, content-derived id for one batch of a review. A single batch
 * keeps the documented `runId + kind + policyVersion + stateHash` id; with
 * several batches the 1-based index is folded in, so two batches that happen to
 * redact to the same state can never collide on a single audit row.
 */
export function batchEvaluationId(input: {
  runId: string;
  kind: DecisionKind;
  policyVersion: string;
  stateHash: string;
  index: number;
  count: number;
}): string {
  const basis = input.count > 1 ? `${input.stateHash}#b${input.index + 1}` : input.stateHash;
  return deriveEvaluationId({
    runId: input.runId,
    kind: input.kind,
    policyVersion: input.policyVersion,
    stateHash: basis,
  });
}

/** Standard fallback category for a thrown error (never free-form). */
export function fallbackReasonFromError(error: unknown): FallbackReason {
  const candidate = (error as { reason?: unknown } | undefined)?.reason ?? (error as { code?: unknown } | undefined)?.code;
  return typeof candidate === "string" && (FALLBACK_REASONS as readonly string[]).includes(candidate)
    ? (candidate as FallbackReason)
    : "unknown";
}

/** Safe, bounded human detail for a failure — never a raw provider body. */
export function detailFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, 300);
}

/** Redacted projection of a stored audit row; the single read shape for both APIs. */
export function projectDecision(record: DecisionEvaluationRecord): DecisionProjection {
  return {
    evaluationId: record.evaluationId,
    runId: record.runId,
    kind: record.kind,
    mode: record.mode,
    provider: record.provider,
    requestedModel: record.requestedModel,
    ...(record.resolvedModel ? { resolvedModel: record.resolvedModel } : {}),
    policyVersion: record.policyVersion,
    stateHash: record.stateHash,
    questionSchemaHash: record.questionSchemaHash,
    status: record.status,
    answers: record.answers ?? [],
    ...(record.appliedOutcome ? { appliedOutcome: record.appliedOutcome } : {}),
    ...(record.fallbackReason ? { fallbackReason: record.fallbackReason } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    latencyMs: record.latencyMs,
    ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens } : {}),
    ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens } : {}),
    // Absent (never 0) when the cost cannot be computed reliably (AT-JEV-062).
    ...(record.estimatedCostUsd !== undefined ? { estimatedCostUsd: record.estimatedCostUsd } : {}),
    createdAt: record.createdAt,
    stateManifest: record.stateManifest ?? {},
  };
}

/**
 * Additive `decisionEngine` block for `/api/config/status`. Only the shape of
 * the configuration is reported: never the key, never the base URL (which can
 * embed credentials), never any env value. A rejected configuration degrades to
 * the documented default plus the standard reason, so the preflight can say
 * "unavailable: missing_credentials" without echoing anything (AT-JEV-003).
 *
 * `vaultKey` is presence-only information for the CALLING user (the vault key
 * itself stays in `index.ts`): with `engine=jev` it makes `configured` true and
 * reports `keySource: "vault"` even when `TYPESAFE_API_KEY` is unset.
 */
export function decisionEngineStatus(
  loaded: DecisionConfigLoad,
  options: { vaultKey?: boolean } = {},
): DecisionEngineStatus {
  if (!loaded.ok) {
    return { engine: "disabled", mode: "off", configured: false, policyVersion: null, reason: loaded.reason };
  }
  if (loaded.config.engine !== "jev") {
    // disabled/mock never use a key: report the shape only, never a key source.
    return {
      engine: loaded.config.engine,
      mode: loaded.config.mode,
      configured: false,
      policyVersion: loaded.config.policyVersion,
    };
  }
  const keySource: "vault" | "env" | null = options.vaultKey ? "vault" : loaded.config.hasApiKey ? "env" : null;
  if (keySource === null) {
    // AT-JEV-003: no vault key and no env key. The deployment config IS enabled
    // (`jev`/mode), only the credential for THIS user is missing — reporting the
    // engine as `disabled` would tell the operator to flip PI_DECISION_ENGINE
    // when it is already set. Keep the configured engine/mode and let
    // `configured`/`reason` carry the actionable part, with no key value.
    return {
      engine: "jev",
      mode: loaded.config.mode,
      configured: false,
      keySource: null,
      policyVersion: loaded.config.policyVersion,
      reason: "missing_credentials",
    };
  }
  return {
    engine: "jev",
    mode: loaded.config.mode,
    configured: true,
    keySource,
    policyVersion: loaded.config.policyVersion,
  };
}

/** A non-blank `TYPESAFE_API_KEY`, or undefined. The value is never logged. */
export function envDecisionApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.TYPESAFE_API_KEY;
  const trimmed = value === undefined ? "" : String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ResolvedDecisionKey {
  key: string | undefined;
  source: "vault" | "env" | null;
}

/**
 * Key resolution order for one run (vault first, env fallback):
 * `vault[ownerId].typesafe` → `vault[ownerId].jev` → `TYPESAFE_API_KEY` → none.
 *
 * Callers must only invoke this for the `jev` engine; the returned `key` stays
 * inside the evaluate route (it is handed to the engine's resolver) and is never
 * projected, evented, audited or logged.
 */
export async function resolveDecisionApiKey(
  userId: string,
  deps: Pick<DecisionRouteDeps, "env" | "readVaultKey">,
): Promise<ResolvedDecisionKey> {
  for (const provider of DECISION_KEY_PROVIDERS) {
    const key = await deps.readVaultKey?.(userId, provider);
    if (key !== undefined && key !== "") return { key, source: "vault" };
  }
  const envKey = envDecisionApiKey(deps.env);
  return envKey === undefined ? { key: undefined, source: null } : { key: envKey, source: "env" };
}

function disabledResponse(input: {
  runId: string;
  kind: DecisionKind;
  mode: DecisionMode;
  status: DecisionStatus;
  fallbackReason: FallbackReason;
  detail?: string;
  createdAt: string;
}): DecisionEvaluateResponse {
  return {
    runId: input.runId,
    kind: input.kind,
    mode: input.mode,
    provider: "disabled",
    status: input.status,
    answers: [],
    fallbackReason: input.fallbackReason,
    ...(input.detail ? { detail: input.detail } : {}),
    latencyMs: 0,
    createdAt: input.createdAt,
  };
}

function isDecisionStatus(value: unknown): value is DecisionStatus {
  return value === "completed" || value === "fallback" || value === "rejected" || value === "disabled";
}

function isProvider(value: unknown): value is DecisionProvider {
  return value === "typesafe" || value === "disabled" || value === "mock";
}

function isDecisionMode(value: unknown): value is DecisionMode {
  return value === "off" || value === "shadow" || value === "assist" || value === "enforce";
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Persists-facing record for one engine evaluation. Immutable policy rules are
 * enforced here, not in the adapter: shadow always reports `appliedOutcome:
 * "none"` (docs/26 §9.4 rule 5) and the identity fields come from the request,
 * never from the provider response.
 */
export function buildAuditRecord(input: {
  evaluation: DecisionEvaluation;
  request: DecisionRequest;
  run: Run;
  kind: DecisionKind;
  config: DecisionEngineConfig;
  fallbackLatencyMs: number;
}): DecisionEvaluationRecord {
  const { evaluation, request, run, kind, config } = input;
  const latencyMs = finiteOrUndefined(evaluation.latencyMs) ?? input.fallbackLatencyMs;
  const status: DecisionStatus = isDecisionStatus(evaluation.status) ? evaluation.status : "fallback";
  // The engine reports the EFFECTIVE mode (the policy clamps the request to the
  // configured ceiling and demotes `enforce` to `assist`), so prefer it.
  const mode: DecisionMode = isDecisionMode(evaluation.mode) ? evaluation.mode : config.mode;
  const fallbackReason: FallbackReason | undefined =
    evaluation.fallbackReason ?? (status === "fallback" ? "unknown" : undefined);
  const inputTokens = finiteOrUndefined(evaluation.inputTokens);
  const outputTokens = finiteOrUndefined(evaluation.outputTokens);
  const cost = finiteOrUndefined(evaluation.estimatedCostUsd);
  return {
    evaluationId: request.evaluationId,
    runId: run.id,
    kind,
    mode,
    provider: isProvider(evaluation.provider) ? evaluation.provider : "typesafe",
    requestedModel: evaluation.requestedModel || config.model,
    ...(evaluation.resolvedModel ? { resolvedModel: evaluation.resolvedModel } : {}),
    policyVersion: config.policyVersion,
    stateHash: request.stateHash,
    questionSchemaHash: questionSchemaHash(request.questions),
    stateManifest: stateManifest(request.state, request.questions),
    answers: Array.isArray(evaluation.answers) ? evaluation.answers : [],
    status,
    // Shadow never applies anything; assist/enforce may report a real outcome.
    appliedOutcome: mode === "shadow" ? "none" : evaluation.appliedOutcome,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(evaluation.detail ? { detail: String(evaluation.detail).slice(0, 500) } : {}),
    latencyMs: Math.max(0, Math.round(latencyMs)),
    ...(inputTokens !== undefined ? { inputTokens: Math.max(0, Math.trunc(inputTokens)) } : {}),
    ...(outputTokens !== undefined ? { outputTokens: Math.max(0, Math.trunc(outputTokens)) } : {}),
    // Only a finite, non-negative response value is stored; otherwise the column
    // stays NULL (the audit store enforces the same rule at the SQL boundary).
    ...(cost !== undefined && cost >= 0 ? { estimatedCostUsd: cost } : {}),
    createdAt: typeof evaluation.createdAt === "string" && evaluation.createdAt ? evaluation.createdAt : new Date().toISOString(),
    idempotencyKey: request.evaluationId,
  };
}

/**
 * The `requested` event is always followed by exactly one outcome event, in that
 * order, with deterministic delivery ids so a replay cannot duplicate the pair
 * (AT-JEV-063). Meta carries identifiers, the 1-based batch position, status and
 * measurements only — never a key and never the outbound payload.
 *
 * `decision.disagreed` is intentionally not emitted in this phase: it belongs to
 * the review pipeline's deterministic-vs-model comparison (AT-JEV-022), which
 * this gateway does not perform.
 */
async function appendDecisionEvents(
  record: DecisionEvaluationRecord,
  run: Run,
  deps: DecisionRouteDeps,
  batch: { index: number; count: number },
) {
  const batchMeta = { batchIndex: batch.index + 1, batchCount: batch.count };
  await deps.store.appendEvent(
    {
      runId: run.id,
      round: run.round,
      source: "system",
      type: "decision.requested",
      message: `决策评估已发起（${record.kind} · ${record.mode}）`,
      at: new Date().toISOString(),
      meta: {
        evaluationId: record.evaluationId,
        kind: record.kind,
        mode: record.mode,
        requestedModel: record.requestedModel,
        ...batchMeta,
      },
    },
    { deliveryId: `decision:${record.evaluationId}:requested` },
  );
  const completed = record.status === "completed";
  const type = completed ? "decision.completed" : "decision.fallback";
  const message = completed
    ? `决策评估完成（${record.resolvedModel ?? record.requestedModel} · ${record.latencyMs}ms）`
    : `决策评估已回退：${record.fallbackReason ?? "unknown"}`;
  await deps.store.appendEvent(
    {
      runId: run.id,
      round: run.round,
      source: "system",
      type,
      message,
      at: new Date().toISOString(),
      meta: {
        evaluationId: record.evaluationId,
        kind: record.kind,
        mode: record.mode,
        status: record.status,
        ...batchMeta,
        ...(record.fallbackReason ? { fallbackReason: record.fallbackReason } : {}),
        ...(record.resolvedModel ? { resolvedModel: record.resolvedModel } : {}),
        latencyMs: record.latencyMs,
        ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens } : {}),
        ...(record.estimatedCostUsd !== undefined ? { estimatedCostUsd: record.estimatedCostUsd } : {}),
      },
    },
    { deliveryId: `decision:${record.evaluationId}:outcome` },
  );
}

/**
 * AT-JEV-081: warns once when a requested model alias (`jev-latest`) starts
 * resolving to a new version. The newly persisted COMPLETED row is compared with
 * the newest completed row previously stored for the same alias; a missing
 * baseline (first observation), an equal version or either side lacking a
 * `resolved_model` raises nothing.
 *
 * The alert carries identifiers and version strings only — never a key and never
 * any part of the outbound payload. Drift detection is observational: any query
 * failure degrades to "no alert" and must never affect the evaluation response
 * or the row that was already persisted.
 */
async function raiseModelDriftIfNeeded(
  record: DecisionEvaluationRecord,
  deps: DecisionRouteDeps,
  at: string,
): Promise<void> {
  const resolvedModel = record.resolvedModel?.trim();
  if (!resolvedModel) return;
  let previous: DecisionEvaluationRecord | undefined;
  try {
    previous = await deps.audit.findLatestCompletedByRequestedModel(record.requestedModel, record.evaluationId);
  } catch {
    // Deliberately silent: the evaluation is already persisted and must return
    // normally. Logging here would need a new logger dependency for no benefit.
    return;
  }
  const previousResolvedModel = previous?.resolvedModel?.trim();
  if (!previousResolvedModel || previousResolvedModel === resolvedModel) return;
  deps.raiseAlert?.({
    key: "jev_model_drift",
    severity: "warning",
    message: `Jev 模型别名漂移：${record.requestedModel} 由 ${previousResolvedModel} 变为 ${resolvedModel}`,
    details: {
      requestedModel: record.requestedModel,
      previousResolvedModel,
      resolvedModel,
      evaluationId: record.evaluationId,
      at,
    },
  });
}

/**
 * AT-JEV-092: a credential rejection (HTTP 401/403 → `authentication_failed`) is
 * the ONE decision-plane failure an operator must act on, so it gets its own
 * CRITICAL alert instead of disappearing among the self-healing fallbacks. The
 * adapter has already locked its circuit breaker at that point (no retry, no
 * further outbound call), and a NEW key is the only cure — hence the actionable
 * message. A fresh key + a restart recovers (see `circuitFingerprint` in
 * `jev.ts`: the breaker is cached per config fingerprint, not per key value).
 *
 * ONLY a real outbound rejection qualifies. `disabled` / `missing_credentials`
 * mean "no key is configured locally": that is a configuration problem, it never
 * reaches the provider and it must NOT page anyone as a revoked credential.
 * `payload_rejected`/`contract_invalid`/`circuit_open` are equally excluded:
 * this guard is the single, explicit discriminator.
 *
 * Deduplication and cooldown stay in `AlertManager` (production wires
 * `alerts.raise`): this helper is called once per newly persisted row and never
 * de-duplicates on its own. It raises nothing when no sink is injected.
 *
 * Details carry identifiers only — never the key, the Authorization header, the
 * outbound payload or a provider error body.
 */
function raiseAuthenticationFailureIfNeeded(
  record: DecisionEvaluationRecord,
  deps: DecisionRouteDeps,
  at: string,
): void {
  if (record.status !== "fallback" && record.status !== "rejected") return;
  if (record.fallbackReason !== "authentication_failed") return;
  deps.raiseAlert?.({
    key: "jev_authentication_failed",
    severity: "critical",
    message: "Jev 凭据被拒绝（HTTP 401/403）：决策评估暂停，请在「模型与凭据」页更换 TypeSafe key",
    details: {
      provider: record.provider,
      evaluationId: record.evaluationId,
      runId: record.runId,
      at,
    },
  });
}

/**
 * Business-safe fallback for a batch that was never dispatched (`payload_rejected`
 * for an over-limit finding set) or whose engine call threw. It is persisted and
 * evented exactly like a provider fallback, so one bad batch is visible in the
 * audit trail without affecting the others or the review pipeline.
 */
function buildFallbackEvaluation(input: {
  evaluationId: string;
  runId: string;
  kind: DecisionKind;
  config: DecisionEngineConfig;
  stateHash: string;
  reason: FallbackReason;
  detail?: string;
  latencyMs: number;
}): DecisionEvaluation {
  return {
    evaluationId: input.evaluationId,
    runId: input.runId,
    kind: input.kind,
    mode: input.config.mode,
    provider: input.config.engine === "mock" ? "mock" : "typesafe",
    requestedModel: input.config.model,
    policyVersion: input.config.policyVersion,
    stateHash: input.stateHash,
    status: "fallback",
    answers: [],
    fallbackReason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
    latencyMs: input.latencyMs,
    createdAt: new Date().toISOString(),
  };
}

/**
 * AT-JEV-072: the decision plane's own concurrency cap, read at the route layer
 * (like the audit-retention knobs), NOT folded into the strict
 * `loadDecisionEngineConfig` schema: a bad value must degrade to the documented
 * default here rather than reject the whole configuration.
 *
 * Why 4: the worker clamps `PI_MAX_ACTIVE_JOBS` to [1, 4] and runs at most one
 * in-flight triage call per active run, so 4 is the *normal* peak. The cap is
 * therefore meant to cover normal load and only bite on an anomalous burst.
 */
export const DECISION_MAX_CONCURRENT_ENV = "PI_DECISION_MAX_CONCURRENT";
export const DECISION_MAX_CONCURRENT_DEFAULT = 4;

/**
 * Resolves the cap from the environment. Absent/blank/non-numeric/`0`/negative
 * all fall back to {@link DECISION_MAX_CONCURRENT_DEFAULT}; `0` is deliberately
 * NOT an "unlimited" escape hatch here (that stays a pure-module capability,
 * reachable only by calling `createAdmissionController` directly).
 */
export function decisionMaxConcurrent(env: NodeJS.ProcessEnv): number {
  const rawValue = env[DECISION_MAX_CONCURRENT_ENV];
  const value = rawValue === undefined ? Number.NaN : Number(String(rawValue).trim());
  if (!Number.isFinite(value) || value < 1) return DECISION_MAX_CONCURRENT_DEFAULT;
  return Math.floor(value);
}

/**
 * One admission rejection warn per process per minute. The throttle state is
 * keyed by the deps object (one per app/process in production), so an operator
 * cannot be flooded by a sustained burst while a fresh test still observes the
 * first line.
 */
const ADMISSION_WARN_INTERVAL_MS = 60_000;
const admissionWarnState = new WeakMap<DecisionRouteDeps, { lastWarnAt: number }>();

/** Emits at most one warn per window, carrying the live admission counters. */
function warnAdmissionRejected(deps: DecisionRouteDeps, admission: AdmissionController, nowMs: number): void {
  let state = admissionWarnState.get(deps);
  if (!state) {
    state = { lastWarnAt: 0 };
    admissionWarnState.set(deps, state);
  }
  if (nowMs - state.lastWarnAt < ADMISSION_WARN_INTERVAL_MS) return;
  state.lastWarnAt = nowMs;
  const warn = deps.warn ?? ((message: string, details: Record<string, unknown>) => console.warn(`${message} ${JSON.stringify(details)}`));
  warn("decision-plane admission control rejected a request; it fell back safely", {
    inFlight: admission.inFlight,
    maxConcurrent: admission.maxConcurrent,
    rejected: admission.rejected,
  });
}

/**
 * Core of the internal evaluate route. Returns the business-safe result for
 * every outcome; only `runId` lookup failure is a request error. Each batch is
 * evaluated, persisted and evented independently: an over-limit or failing batch
 * never prevents the remaining batches from being recorded and never fails the
 * run (docs/26 §9.2/§15.1).
 *
 * AT-JEV-072: when an admission controller is wired, this function reserves a
 * slot AFTER the cheap config/credential gates and BEFORE any batch construction,
 * provider call or audit write. A saturated plane short-circuits with the same
 * business-safe shape as the `missing_credentials` early return: HTTP 200,
 * `status:"fallback"`, `fallbackReason:"rate_limited"`, zero outbound calls and
 * zero audit rows. Whatever happens afterwards (fallback, throw, success), the
 * slot is released in `finally`, so a failure can never leak capacity.
 */
export async function evaluateDecisionForRun(
  input: { runId: string; kind: DecisionKind },
  deps: DecisionRouteDeps,
): Promise<DecisionEvaluateOutcome> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const run = deps.store.getRun(input.runId);
  if (!run) return { status: 404, body: { error: "Run not found" } };

  const loaded = deps.loadConfig(deps.env);
  if (!loaded.ok) {
    // Invalid/rejected configuration: never a provider call, never a persisted
    // evaluation — the operator gets a standard fallback reason instead.
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: "off",
        status: "fallback",
        fallbackReason: loaded.reason,
        detail: loaded.detail,
        createdAt: now,
      }),
    };
  }
  let config = loaded.config;
  if (config.engine === "disabled" || config.mode === "off") {
    // Disabled engine / off kill switch (AT-JEV-001/002/005): business-safe
    // response with no outbound call and no audit row. `mock` stays reachable on
    // purpose — it is the documented engine for integration/E2E runs (§6.2).
    // Neither branch reads the credential vault.
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: config.mode,
        status: "disabled",
        fallbackReason: "disabled",
        createdAt: now,
      }),
    };
  }

  // Only `jev` uses a key. Resolve it per run, vault first (per-user credential
  // vault) then the platform env; `mock` never touches the vault (deliverable:
  // no lookup, no probe, no extra query for a non-jev engine).
  let resolveApiKey: (() => string | undefined) | undefined;
  // P1 (review): isolate the breaker per credential SOURCE so one user's revoked
  // key cannot latch it for every other caller. The scope is the source identity
  // (`vault:<userId>` / `env`) — never the key material.
  let breakerScope = "none";
  if (config.engine === "jev") {
    const resolved = await resolveDecisionApiKey(run.ownerId, deps);
    if (resolved.key === undefined) {
      // AT-JEV-003: no vault key and no env key — the standard, actionable
      // fallback reason, with no provider call and no audit row.
      return {
        status: 200,
        body: disabledResponse({
          runId: run.id,
          kind: input.kind,
          mode: config.mode,
          status: "fallback",
          fallbackReason: "missing_credentials",
          detail: "no TypeSafe API key is available for this run (credential vault or TYPESAFE_API_KEY)",
          createdAt: now,
        }),
      };
    }
    // `hasApiKey` means "a key is resolvable for this request"; the key material
    // itself is never stored in the config object.
    config = { ...config, hasApiKey: true };
    breakerScope = resolved.source === "vault" ? `vault:${run.ownerId}` : resolved.source === "env" ? "env" : "none";
    // Read by the engine at call time; the resolver returns the key resolved for
    // THIS run, so a rotated vault credential is picked up on the next evaluation.
    resolveApiKey = () => resolved.key;
  }

  // AT-JEV-072 admission gate. Placed after the local configuration/credential
  // gates (a `disabled`/`missing_credentials` request never reaches the provider
  // anyway, so it must not consume a slot) and before any batch construction,
  // provider call or audit write. Same business-safe early-return shape as
  // `missing_credentials` above: HTTP 200, no audit row, no event, no outbound
  // call — the worker can simply retry, and its next round re-triggers the
  // evaluation.
  const admission = deps.admission;
  if (admission && !admission.tryAcquire()) {
    warnAdmissionRejected(deps, admission, Date.now());
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: config.mode,
        status: "fallback",
        fallbackReason: "rate_limited",
        detail:
          `decision-plane concurrency limit reached (in flight ${admission.inFlight}/${admission.maxConcurrent}, ` +
          `rejected ${admission.rejected}); the request safely fell back without any outbound call — ` +
          "retry shortly, the next worker round will re-trigger it",
        createdAt: now,
      }),
    };
  }

  // Everything below holds the admission slot (when wired); the `finally` is the
  // single release point, so no early return or thrown error can leak capacity.
  try {
    return await evaluateAdmittedBatches(input, deps, run, config, resolveApiKey, breakerScope, now);
  } finally {
    admission?.release();
  }
}

/**
 * The admitted portion of one evaluate request (docs/26 §9.2/§15.1): build the
 * payload-safe batches, dispatch them, persist one audit row per batch and
 * return the projection. Split out of `evaluateDecisionForRun` so the admission
 * `try/finally` can wrap it without touching the many existing early returns.
 */
async function evaluateAdmittedBatches(
  input: { runId: string; kind: DecisionKind },
  deps: DecisionRouteDeps,
  run: Run,
  config: DecisionEngineConfig,
  resolveApiKey: (() => string | undefined) | undefined,
  breakerScope: string,
  now: string,
): Promise<DecisionEvaluateOutcome> {
  // The batch builder owns redaction/allowlisting and the payload limits. Its
  // evaluationId input is provisional: the real per-batch id must incorporate
  // the builder's `stateHash` (docs/26 §8.3), so it is re-derived below.
  const provisionalId = deriveEvaluationId({
    runId: run.id,
    kind: input.kind,
    policyVersion: config.policyVersion,
    stateHash: "pending",
  });
  let batches: ReviewTriageBatch[];
  try {
    batches = deps.buildBatches({
      run,
      mode: config.mode,
      policyVersion: config.policyVersion,
      maxFindings: config.reviewMaxFindings,
      evaluationId: provisionalId,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // Payload/redaction/contract refusal from the builder: fallback, no call.
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: config.mode,
        status: "fallback",
        fallbackReason: fallbackReasonFromError(error),
        detail: detailFromError(error),
        createdAt: now,
      }),
    };
  }
  if (!Array.isArray(batches) || batches.length === 0) {
    // Nothing to triage (the run has no unresolved findings) or a builder that
    // produced nothing: a business-safe no-op, never a silent success, and never
    // an outbound call with an empty question set.
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: config.mode,
        status: "fallback",
        fallbackReason: "payload_rejected",
        detail: "nothing to triage: no unresolved findings produced a batch",
        createdAt: now,
      }),
    };
  }

  const entries = batches.map((batch, index) => {
    const evaluationId = batchEvaluationId({
      runId: run.id,
      kind: input.kind,
      policyVersion: config.policyVersion,
      stateHash: batch.request.stateHash,
      index,
      count: batches.length,
    });
    return { batch, index, evaluationId, request: { ...batch.request, evaluationId } };
  });

  // Idempotency is per batch: the same state in the same policy version returns
  // the stored row without a second provider call and without a second event pair.
  const existing = await Promise.all(
    entries.map((entry) => deps.audit.findByIdempotencyKey(entry.evaluationId)),
  );

  const engine = deps.createEngine(config, resolveApiKey ? { resolveApiKey, breakerScope } : undefined);
  const thrown = new Map<string, FallbackReason>();
  const dispatchStarted = Date.now();
  const runResult = await runReviewTriageBatches({
    batches: entries
      .filter((_entry, index) => !existing[index])
      .map((entry) => ({ ...entry.batch, evaluationId: entry.evaluationId, request: entry.request })),
    engine: {
      evaluate: async (request, signal) => {
        try {
          return await engine.evaluate(request, signal);
        } catch (error) {
          // The batched runner reports a thrown batch as `unknown`; keep the
          // standard, more precise category for the audit row.
          thrown.set(request.evaluationId, fallbackReasonFromError(error));
          throw error;
        }
      },
    },
  });
  const outcomeById = new Map(runResult.outcomes.map((outcome) => [outcome.evaluationId, outcome.evaluation]));
  const failureById = new Map(runResult.failures.map((failure) => [failure.evaluationId, failure.reason]));

  const records: DecisionEvaluationRecord[] = [];
  for (const [index, entry] of entries.entries()) {
    const stored = existing[index];
    if (stored) {
      records.push(stored);
      continue;
    }
    const outcome = outcomeById.get(entry.evaluationId);
    const skipped = !entry.batch.withinLimits;
    const evaluation =
      outcome ??
      buildFallbackEvaluation({
        evaluationId: entry.evaluationId,
        runId: run.id,
        kind: input.kind,
        config,
        stateHash: entry.request.stateHash,
        reason:
          thrown.get(entry.evaluationId) ??
          failureById.get(entry.evaluationId) ??
          (skipped ? "payload_rejected" : "unknown"),
        ...(skipped && entry.batch.detail ? { detail: entry.batch.detail } : {}),
        latencyMs: skipped ? 0 : Date.now() - dispatchStarted,
      });
    const record = buildAuditRecord({
      evaluation,
      request: entry.request,
      run,
      kind: input.kind,
      config,
      fallbackLatencyMs: skipped ? 0 : Date.now() - dispatchStarted,
    });
    const { record: persisted, created } = await deps.audit.insert(record);
    // A concurrent duplicate persisted the row first; it also owns the events
    // and the drift signal, so a replay never re-raises the alert (AT-JEV-081).
    if (created) {
      await appendDecisionEvents(persisted, run, deps, { index: entry.index, count: entries.length });
      if (persisted.status === "completed") await raiseModelDriftIfNeeded(persisted, deps, now);
      // AT-JEV-092: exactly one alert per newly persisted credential rejection
      // (`AlertManager` owns the 900s per-key cooldown). A replay never reaches
      // this branch because the idempotency lookup above returns the stored row.
      raiseAuthenticationFailureIfNeeded(persisted, deps, now);
    }
    records.push(persisted);
  }

  return {
    status: 200,
    body: {
      // The top level mirrors the previous single-evaluation shape (docs/26 §8.1).
      ...projectDecision(records[0]),
      batches: records.map(projectDecision),
    },
  };
}

/**
 * AT-JEV-056: probes the audit store for the retention seam. It is checked
 * structurally (not added to `DecisionAuditStoreLike`) so every existing fake —
 * tests that only exercise the read/write surface — keeps compiling.
 */
function asPruneStore(audit: DecisionAuditStoreLike): DecisionAuditPruneStore | undefined {
  const candidate = audit as Partial<DecisionAuditPruneStore>;
  return typeof candidate.pruneOlderThan === "function" ? (candidate as DecisionAuditPruneStore) : undefined;
}

/** Registers both decision-plane routes on the app. */
export function registerDecisionRoutes(app: FastifyInstance, deps: DecisionRouteDeps) {
  /**
   * AT-JEV-072: the evaluate route always runs behind an admission controller.
   * The cap comes from `PI_DECISION_MAX_CONCURRENT` (default 4); the warn sink is
   * the app logger. Built ONCE per registration so the counter is process-wide
   * (one controller per app), and so the WeakMap-keyed warning throttle sees a
   * stable deps identity.
   */
  const evaluateDeps: DecisionRouteDeps = {
    ...deps,
    admission: deps.admission ?? createAdmissionController({ maxConcurrent: decisionMaxConcurrent(deps.env) }),
    warn: deps.warn ?? ((message, details) => app.log.warn(details, message)),
  };

  app.post(DECISION_EVALUATE_PATH, async (request, reply) => {
    if (!deps.internalAuthorized(request)) return reply.code(401).send({ error: "Unauthorized" });
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
    if (!deps.internalAuthorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    if (!sweepAuditRetention) {
      // Only a store without the retention seam (an old/injected fake) lands
      // here; the production store implements it.
      return reply.code(501).send({ ok: false, error: "Decision audit retention is not supported by this store" });
    }
    const sweep = await sweepAuditRetention();
    return { ok: true, skipped: sweep === undefined, sweep: sweep ?? null };
  });

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
}
