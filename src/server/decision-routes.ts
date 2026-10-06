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
  type DecisionAuditStoreLike,
} from "./decision-engine/audit-store.js";
import { canonicalJson, questionSchemaHash, sha256Hex, stateManifest } from "./decision-engine/redaction.js";
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
  deps?: { fetchImpl?: typeof fetch; resolveApiKey?: () => string | undefined },
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
    // AT-JEV-003: no vault key and no env key — actionable reason, no value.
    return { engine: "disabled", mode: "off", configured: false, policyVersion: null, reason: "missing_credentials" };
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
 * Core of the internal evaluate route. Returns the business-safe result for
 * every outcome; only `runId` lookup failure is a request error. Each batch is
 * evaluated, persisted and evented independently: an over-limit or failing batch
 * never prevents the remaining batches from being recorded and never fails the
 * run (docs/26 §9.2/§15.1).
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
    // Read by the engine at call time; the resolver returns the key resolved for
    // THIS run, so a rotated vault credential is picked up on the next evaluation.
    resolveApiKey = () => resolved.key;
  }

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
    // A builder that produced nothing is a refusal, never a silent success.
    return {
      status: 200,
      body: disabledResponse({
        runId: run.id,
        kind: input.kind,
        mode: config.mode,
        status: "fallback",
        fallbackReason: "payload_rejected",
        detail: "the review-triage builder produced no batch",
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

  const engine = deps.createEngine(config, resolveApiKey ? { resolveApiKey } : undefined);
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
    // A concurrent duplicate persisted the row first; it also owns the events.
    if (created) await appendDecisionEvents(persisted, run, deps, { index: entry.index, count: entries.length });
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

/** Registers both decision-plane routes on the app. */
export function registerDecisionRoutes(app: FastifyInstance, deps: DecisionRouteDeps) {
  app.post(DECISION_EVALUATE_PATH, async (request, reply) => {
    if (!deps.internalAuthorized(request)) return reply.code(401).send({ error: "Unauthorized" });
    const parsed = decisionEvaluateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const result = await evaluateDecisionForRun(parsed.data, deps);
    return reply.code(result.status).send(result.body);
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
