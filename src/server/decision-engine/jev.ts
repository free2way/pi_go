/**
 * TypeSafe System One (Jev) adapter (docs/26 §7/§12/§15).
 *
 * A thin `fetch` wrapper: it maps provider-agnostic questions to the System One
 * request shape, shares ONE total time budget across all attempts, honours the
 * documented retry table, and reports failures through the standard
 * {@link FallbackReason} enum. The API key is read at call time from the server
 * environment and is never placed in an evaluation, a detail string or a log:
 * error details carry a status code or a self-authored category, never the
 * Authorization header or a raw provider body.
 *
 * The circuit breaker is per configuration fingerprint, so changing the base
 * URL/model/key-staleness resets it (`401/403` opens until the config changes).
 */

import { checkPayloadLimits, questionSchemaHash, redactText } from "./redaction.js";
import { mapProviderResponse } from "./response-schema.js";
import type { DecisionEngine, DecisionEngineConfig, DecisionEvaluation, DecisionQuestion, DecisionRequest, DecisionStatus, FallbackReason } from "./types.js";
import type { EngineDeps } from "./disabled.js";

/** Consecutive provider-attributable failures before the breaker opens. */
export const BREAKER_THRESHOLD = 5;
/** How long the breaker stays open before a single half-open probe. */
export const BREAKER_COOLDOWN_MS = 60_000;
/** Base jittered backoff between the two attempts. */
export const RETRY_BASE_MS = 100;
/** The retry table allows at most one retry per evaluation. */
export const MAX_RETRIES = 1;

export interface JevDeps extends EngineDeps {
  fetchImpl?: typeof fetch;
  /**
   * Additive key seam: when provided (production wires it to the credential
   * vault, falling back to `TYPESAFE_API_KEY`), it is the ONLY key source. When
   * absent the adapter keeps reading `process.env.TYPESAFE_API_KEY` at call time.
   * The returned value never leaves this module.
   */
  resolveApiKey?: () => string | undefined;
  /**
   * Breaker isolation scope: the *identity of the credential source* (e.g.
   * `vault:<userId>` / `env`), never the key. Without it a single user's revoked
   * key would latch the shared breaker for every other caller.
   */
  breakerScope?: string;
}

export interface ProviderQuestion {
  type: "noul" | "choice" | "score";
  criteria?: Record<string, string> | Array<{ name: string; description: string }>;
}

export interface ProviderRequestBody {
  state: unknown;
  model: string;
  questions: Record<string, ProviderQuestion>;
}

export type ProviderRequestBuild =
  | { ok: true; body: ProviderRequestBody }
  | { ok: false; detail: string };

/** Minimum/maximum score levels System One accepts. */
export const SCORE_LEVEL_MIN = 2;
export const SCORE_LEVEL_MAX = 10;

/**
 * Maps one DecisionQuestion to the provider's fixed shape. Probability becomes
 * `noul` (with `criteria.true/false` only when meanings were supplied), choice
 * becomes a `criteria` map and score becomes an ordered `criteria` array.
 */
export function mapQuestionToProvider(question: DecisionQuestion): ProviderQuestion | { error: string } {
  switch (question.type) {
    case "probability": {
      const criteria: Record<string, string> = {};
      if (question.trueMeaning !== undefined) criteria.true = question.trueMeaning;
      if (question.falseMeaning !== undefined) criteria.false = question.falseMeaning;
      return Object.keys(criteria).length > 0 ? { type: "noul", criteria } : { type: "noul" };
    }
    case "choice":
      return { type: "choice", criteria: Object.fromEntries(question.options.map((option) => [option, option])) };
    case "score": {
      if (question.levels.length < SCORE_LEVEL_MIN || question.levels.length > SCORE_LEVEL_MAX) {
        return { error: `score question needs ${SCORE_LEVEL_MIN}..${SCORE_LEVEL_MAX} levels` };
      }
      return {
        type: "score",
        criteria: question.levels.map((level) => ({ name: level.value, description: level.description })),
      };
    }
    default:
      return { error: "unknown question type" };
  }
}

/** Builds the System One body `{state, model, questions}` (no key inside). */
export function buildProviderRequestBody(request: DecisionRequest, config: DecisionEngineConfig): ProviderRequestBuild {
  const questions: Record<string, ProviderQuestion> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const mapped = mapQuestionToProvider(question);
    if ("error" in mapped) return { ok: false, detail: `question "${id}" is not mappable: ${mapped.error}` };
    questions[id] = mapped;
  }
  return { ok: true, body: { state: request.state, model: config.model, questions } };
}

/** Reads the platform key at call time; the value never leaves this module. */
function readApiKey(): string | undefined {
  const value = process.env.TYPESAFE_API_KEY;
  const trimmed = value === undefined ? "" : String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The key source for one engine instance: the injected resolver (vault-first,
 * env fallback) when present, otherwise the process environment. It is read at
 * every call so a rotated vault credential takes effect without a restart.
 */
export type ApiKeyResolver = () => string | undefined;

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Three-state breaker. `onAuthFailure` locks it open until `reset()` (i.e. until
 * the configuration changes); `allow()` grants exactly one half-open probe.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private failures = 0;
  private openedAt = 0;
  private authLocked = false;
  private probeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? BREAKER_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? BREAKER_COOLDOWN_MS;
    this.clock = options.now ?? (() => Date.now());
  }

  private isOpen(): boolean {
    return this.authLocked || this.failures >= this.threshold;
  }

  private cooldownElapsed(): boolean {
    return this.clock() - this.openedAt >= this.cooldownMs;
  }

  state(): CircuitState {
    if (!this.isOpen()) return "closed";
    if (this.authLocked) return "open";
    if (this.probeInFlight || this.cooldownElapsed()) return "half_open";
    return "open";
  }

  allow(): boolean {
    if (!this.isOpen()) return true;
    if (this.authLocked || !this.cooldownElapsed() || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  onProviderFailure(): void {
    this.probeInFlight = false;
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.clock();
  }

  onAuthFailure(): void {
    this.probeInFlight = false;
    this.failures = Math.max(this.failures, this.threshold);
    this.openedAt = this.clock();
    this.authLocked = true;
  }

  /**
   * Releases a half-open probe that produced no provider verdict (contract
   * error, abort, budget exhaustion). The breaker stays open and waits another
   * cooldown before the next probe.
   */
  onInconclusive(): void {
    if (!this.probeInFlight) return;
    this.probeInFlight = false;
    this.openedAt = this.clock();
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.authLocked = false;
    this.probeInFlight = false;
  }
}

const breakers = new Map<string, CircuitBreaker>();

/**
 * Breaker identity. `scope` is the credential source the caller resolved the key
 * from (e.g. `vault:<userId>` or `env`), so one user's revoked/bad key can never
 * latch the breaker for everyone else — a real cross-tenant hazard found in
 * review: the breaker used to be keyed on `baseUrl|model|hasApiKey` alone, and an
 * auth failure latches it until a reset. It carries no key material: only the
 * *identity of the source*, never the secret itself.
 */
export function circuitFingerprint(config: DecisionEngineConfig, scope = "default"): string {
  return `${scope}|${config.baseUrl}|${config.model}|${config.hasApiKey ? "key" : "no-key"}`;
}

function getBreaker(config: DecisionEngineConfig, scope: string | undefined): CircuitBreaker {
  const fingerprint = circuitFingerprint(config, scope);
  const existing = breakers.get(fingerprint);
  if (existing) return existing;
  const created = new CircuitBreaker();
  breakers.set(fingerprint, created);
  return created;
}

/** Test hook: clears every in-process breaker. */
export function resetDecisionCircuitBreakers(): void {
  breakers.clear();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffMs(attempt: number): number {
  const jitter = 0.5 + Math.random();
  return Math.round(RETRY_BASE_MS * 2 ** (attempt - 1) * jitter);
}

interface FailureEvaluationInput {
  request: DecisionRequest;
  config: DecisionEngineConfig;
  now: () => Date;
  startedAt: number;
  reason: FallbackReason;
  detail: string;
  status?: DecisionStatus;
}

function failureEvaluation(input: FailureEvaluationInput): DecisionEvaluation {
  return {
    evaluationId: input.request.evaluationId,
    runId: input.request.runId,
    kind: input.request.kind,
    mode: input.request.mode,
    provider: "typesafe",
    requestedModel: input.config.model,
    policyVersion: input.request.policyVersion,
    stateHash: input.request.stateHash,
    status: input.status ?? "fallback",
    answers: [],
    fallbackReason: input.reason,
    detail: input.detail,
    latencyMs: Math.max(0, input.now().getTime() - input.startedAt),
    createdAt: input.now().toISOString(),
  };
}

/**
 * Safe summary of a provider error response for the temporary `PI_JEV_DIAG`
 * diagnostic: HTTP-level field NAMES plus validation locations/messages only.
 * FastAPI's `HTTPValidationError.detail[]` carries `loc`/`msg`/`type`, but some
 * errors also echo the offending `input` — those keys are never read here, so
 * no `state`, question or credential content can reach the log.
 */
async function describeProviderError(response: Response): Promise<string> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  if (!record) return `bodyKind=${typeof parsed} len=${text.length}`;
  const parts: string[] = [];
  // Provider-authored strings are free text: a validation error may echo request
  // content. Run them through the same redactor used for outbound state so no
  // secret/PII can reach the log even with the diagnostic enabled.
  const safe = (value: unknown, maxChars: number) => redactText(String(value ?? "")).slice(0, maxChars);
  const detail = record.detail;
  if (Array.isArray(detail)) {
    for (const item of detail.slice(0, 8)) {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      if (!entry) continue;
      const loc = Array.isArray(entry.loc) ? entry.loc.map((value) => String(value)).join(".") : "-";
      parts.push(`loc=${loc} msg=${safe(entry.msg, 120)} type=${safe(entry.type, 40)}`);
    }
  } else if (typeof detail === "string") {
    parts.push(`detail=${safe(detail, 160)}`);
  }
  for (const key of ["error", "message", "error_type"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(`${key}=${safe(value, 160)}`);
  }
  return `keys=[${Object.keys(record).join(",")}] ${parts.join(" | ")}`;
}

/**
 * Creates the Jev engine. It never throws: every failure becomes a structured
 * fallback/rejected evaluation so the caller's existing flow keeps running.
 */
export function createJevEngine(config: DecisionEngineConfig, deps: JevDeps = {}): DecisionEngine {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveApiKey: ApiKeyResolver = deps.resolveApiKey ?? readApiKey;
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const diag = process.env.PI_JEV_DIAG === "1";

  return {
    evaluate: async (request: DecisionRequest, callerSignal?: AbortSignal): Promise<DecisionEvaluation> => {
      const startedAt = now().getTime();
      const fail = (reason: FallbackReason, detail: string, status?: DecisionStatus) =>
        failureEvaluation({ request, config, now, startedAt, reason, detail, status });

      const apiKey = resolveApiKey();
      if (!apiKey) return fail("missing_credentials", "no TypeSafe API key is configured");

      const limits = checkPayloadLimits(request.state, request.questions, {
        maxTokens: config.maxStateTokens,
        maxBytes: config.maxStateBytes,
      });
      if (!limits.ok) return fail("payload_rejected", limits.detail, "rejected");

      const built = buildProviderRequestBody(request, config);
      if (!built.ok) return fail("payload_rejected", built.detail, "rejected");

      const breaker = getBreaker(config, deps.breakerScope);
      if (!breaker.allow()) return fail("circuit_open", "circuit breaker is open");

      if (callerSignal?.aborted) {
        breaker.onInconclusive();
        return fail("aborted", "request aborted before dispatch");
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
      const onCallerAbort = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }

      const remaining = () => config.timeoutMs - (now().getTime() - startedAt);
      const callerAborted = () => callerSignal?.aborted === true;
      let retries = 0;

      try {
        for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
          if (callerAborted()) {
            breaker.onInconclusive();
            return fail("aborted", "request aborted");
          }
          if (remaining() <= 0) {
            breaker.onInconclusive();
            return fail("timeout", "total time budget exhausted");
          }

          let response: Response;
          try {
            response = await fetchImpl(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(built.body),
              signal: controller.signal,
            });
          } catch (error) {
            if (callerAborted()) return fail("aborted", "request aborted");
            if (timedOut || controller.signal.aborted) {
              breaker.onProviderFailure();
              return fail("timeout", "total time budget exhausted");
            }
            breaker.onProviderFailure();
            const kind = error instanceof Error ? error.name : "unknown";
            if (retries < MAX_RETRIES && attempt < config.maxAttempts) {
              const wait = backoffMs(attempt);
              if (wait < remaining()) {
                retries += 1;
                await delay(wait, controller.signal);
                continue;
              }
            }
            return fail("provider_unavailable", `network error (${kind})`);
          }

          if (response.ok) {
            const body = await response.json().catch(() => undefined);
            const mapped = mapProviderResponse(body, request);
            if (!mapped.ok) {
              breaker.onProviderFailure();
              return fail("contract_invalid", `provider response rejected: ${mapped.detail}`);
            }
            breaker.onSuccess();
            const evaluation: DecisionEvaluation = {
              evaluationId: request.evaluationId,
              runId: request.runId,
              kind: request.kind,
              mode: request.mode,
              provider: "typesafe",
              requestedModel: config.model,
              resolvedModel: mapped.model,
              policyVersion: request.policyVersion,
              stateHash: request.stateHash,
              status: "completed",
              answers: mapped.answers,
              latencyMs: Math.max(0, now().getTime() - startedAt),
              createdAt: now().toISOString(),
            };
            if (mapped.inputTokens !== undefined) evaluation.inputTokens = mapped.inputTokens;
            if (mapped.outputTokens !== undefined) evaluation.outputTokens = mapped.outputTokens;
            return evaluation;
          }

          const status = response.status;
          if (diag) {
            // Temporary, env-gated (`PI_JEV_DIAG=1`) diagnostic: a live 422 is
            // otherwise indistinguishable by field. `describeProviderError` logs
            // only validation locations/messages and top-level field names — it
            // never logs `input`/`ctx`/`state`/the payload or anything key-derived.
            const described = await describeProviderError(response).catch(() => "body-unreadable");
            console.warn(`[jev-diag] HTTP ${status} ${described}`);
          }
          if (status === 401 || status === 403) {
            breaker.onAuthFailure();
            return fail("authentication_failed", `provider rejected the credentials (HTTP ${status})`);
          }
          if (status === 422) {
            const schemaHash = questionSchemaHash(request.questions);
            breaker.onInconclusive();
            return fail(
              "contract_invalid",
              `provider rejected the request contract (HTTP 422, policy=${request.policyVersion}, schema=${schemaHash})`,
            );
          }
          if (status === 429) {
            breaker.onProviderFailure();
            if (retries < MAX_RETRIES && attempt < config.maxAttempts) {
              const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? backoffMs(attempt);
              if (retryAfterMs < remaining()) {
                retries += 1;
                await delay(retryAfterMs, controller.signal);
                continue;
              }
            }
            return fail("rate_limited", "provider rate limited the request (HTTP 429)");
          }
          if (status === 529 || status >= 500) {
            breaker.onProviderFailure();
            if (retries < MAX_RETRIES && attempt < config.maxAttempts) {
              const wait = backoffMs(attempt);
              if (wait < remaining()) {
                retries += 1;
                await delay(wait, controller.signal);
                continue;
              }
            }
            return fail("provider_unavailable", `provider unavailable (HTTP ${status})`);
          }
          // Any other 4xx is our request/contract, not a transient provider fault.
          breaker.onInconclusive();
          return fail("contract_invalid", `provider rejected the request (HTTP ${status})`);
        }

        breaker.onInconclusive();
        return fail(timedOut ? "timeout" : "provider_unavailable", "no attempt succeeded within the configured budget");
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
