import type { FastifyRequest } from "fastify";
import type { Run } from "../shared/types.js";
import type { Alert } from "./alerts.js";
import type { AdmissionController } from "./decision-engine/admission.js";
import type { DecisionAuditStoreLike } from "./decision-engine/audit-store.js";
import type { DecisionMetricCircuit } from "./decision-engine/metrics.js";
import type { ReviewTriageBatch, ReviewTriageInput } from "./decision-engine/review-triage.js";
import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionEngineConfig,
  DecisionEvaluationRecord,
  DecisionKind,
  DecisionMode,
  DecisionProvider,
  DecisionStatus,
  FallbackReason,
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

export interface DecisionServices {
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
  /**
   * docs/26 §16.1: session gate for the read-only metrics route. Unlike the
   * internal routes (worker bearer token) the metrics surface is for a logged-in
   * session; production wires `(request) => Boolean(auth.user(request))`, which
   * the app's global `preHandler` has already populated for `/api/*`. It is a
   * seam (not a hard dependency on `Authenticator`) so a bare-Fastify test can
   * assert the 401. Absent ⇒ the route fails closed with 401.
   */
  sessionAuthorized?: (request: FastifyRequest) => boolean;
  /**
   * Read-only circuit snapshot for the metrics route. Defaults to
   * `decisionCircuitSnapshot()` (the in-process breakers); injectable so a test
   * can assert the rollup without mutating adapter state.
   */
  circuits?: () => readonly DecisionMetricCircuit[];
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
  deps: Pick<DecisionServices, "env" | "readVaultKey">,
): Promise<ResolvedDecisionKey> {
  for (const provider of DECISION_KEY_PROVIDERS) {
    const key = await deps.readVaultKey?.(userId, provider);
    if (key !== undefined && key !== "") return { key, source: "vault" };
  }
  const envKey = envDecisionApiKey(deps.env);
  return envKey === undefined ? { key: undefined, source: null } : { key: envKey, source: "env" };
}
