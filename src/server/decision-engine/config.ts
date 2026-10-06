/**
 * Decision-plane configuration (docs/26 §11).
 *
 * Strict by construction: an explicitly-set-but-invalid value fails the whole
 * load (`ok:false`) — it never degrades to a宽松 default. Only *absent* (or
 * empty) variables fall back to the documented defaults, so an operator cannot
 * typo their way into sending data somewhere unexpected.
 *
 * `TYPESAFE_API_KEY` is presence-only here: the config carries `hasApiKey`, never
 * the value (the adapter reads the secret at call time). Error details never
 * echo any variable value, so a mis-typed key can never reach a log.
 */

import { z } from "zod";
import type { DecisionEngineConfig, DecisionMode, FallbackReason } from "./types.js";

export type DecisiveEngine = "disabled" | "mock" | "jev";

/** Documented defaults (docs/26 §11 + review corrections). */
export const DECISION_ENGINE_DEFAULTS = {
  engine: "disabled" as DecisiveEngine,
  mode: "off" as DecisionMode,
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 3000,
  maxAttempts: 2,
  /** state + longest question budget (provider is 32k for the two combined). */
  maxStateTokens: 24000,
  /** secondary hard guard on the serialized outbound payload. */
  maxStateBytes: 262144,
  reviewMaxFindings: 50,
  shadowSampleRate: 1,
  policyVersion: "review-triage-v1",
  allowSource: false,
} as const;

export type LoadDecisionEngineConfigResult =
  | { ok: true; config: DecisionEngineConfig }
  | { ok: false; reason: FallbackReason; detail: string };

const ENGINE_VALUES = ["disabled", "mock", "jev"] as const;
const MODE_VALUES = ["off", "shadow", "assist", "enforce"] as const;

/** Returns the raw variable only when it is present and non-blank. */
function raw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

function intField(extra: Partial<{ min: number; max: number }> = {}) {
  return z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((value) => Number(value))
    .pipe(z.number().int().positive().min(extra.min ?? 1).max(extra.max ?? Number.MAX_SAFE_INTEGER));
}

const sampleRate = z
  .string()
  .refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
  }, "must be a number between 0 and 1")
  .transform((value) => Number(value));

/** Only the literal `false` is accepted in this phase (docs/26 §11). */
const allowSourceRaw = z.enum(["false", "true"]);

const urlString = z
  .string()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const nonEmpty = z.string().min(1);

/** Zod schema for the picked, already-trimmed env values (absent ⇒ defaults). */
export const decisionEngineEnvSchema = z.object({
  PI_DECISION_ENGINE: z.enum(ENGINE_VALUES),
  PI_JEV_MODE: z.enum(MODE_VALUES),
  PI_JEV_BASE_URL: urlString,
  PI_JEV_MODEL: nonEmpty,
  PI_JEV_TIMEOUT_MS: intField(),
  PI_JEV_MAX_ATTEMPTS: intField(),
  PI_JEV_STATE_MAX_TOKENS: intField(),
  PI_JEV_STATE_MAX_BYTES: intField(),
  PI_JEV_REVIEW_MAX_FINDINGS: intField(),
  PI_JEV_SHADOW_SAMPLE_RATE: sampleRate,
  PI_JEV_POLICY_VERSION: nonEmpty,
  PI_JEV_ALLOW_SOURCE: allowSourceRaw,
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Loads and strictly validates the decision-plane configuration.
 *
 * Failure reasons are limited to the standard enum: parse failures are
 * `invalid_configuration`; `engine=jev` without a key is `missing_credentials`.
 */
export function loadDecisionEngineConfig(env: NodeJS.ProcessEnv): LoadDecisionEngineConfigResult {
  const baseUrl = raw(env, "PI_JEV_BASE_URL") ?? DECISION_ENGINE_DEFAULTS.baseUrl;
  const hasApiKey = raw(env, "TYPESAFE_API_KEY") !== undefined;

  const parsed = decisionEngineEnvSchema.safeParse({
    PI_DECISION_ENGINE: raw(env, "PI_DECISION_ENGINE") ?? DECISION_ENGINE_DEFAULTS.engine,
    PI_JEV_MODE: raw(env, "PI_JEV_MODE") ?? DECISION_ENGINE_DEFAULTS.mode,
    PI_JEV_BASE_URL: baseUrl,
    PI_JEV_MODEL: raw(env, "PI_JEV_MODEL") ?? DECISION_ENGINE_DEFAULTS.model,
    PI_JEV_TIMEOUT_MS: raw(env, "PI_JEV_TIMEOUT_MS") ?? String(DECISION_ENGINE_DEFAULTS.timeoutMs),
    PI_JEV_MAX_ATTEMPTS: raw(env, "PI_JEV_MAX_ATTEMPTS") ?? String(DECISION_ENGINE_DEFAULTS.maxAttempts),
    PI_JEV_STATE_MAX_TOKENS: raw(env, "PI_JEV_STATE_MAX_TOKENS") ?? String(DECISION_ENGINE_DEFAULTS.maxStateTokens),
    PI_JEV_STATE_MAX_BYTES: raw(env, "PI_JEV_STATE_MAX_BYTES") ?? String(DECISION_ENGINE_DEFAULTS.maxStateBytes),
    PI_JEV_REVIEW_MAX_FINDINGS: raw(env, "PI_JEV_REVIEW_MAX_FINDINGS") ?? String(DECISION_ENGINE_DEFAULTS.reviewMaxFindings),
    PI_JEV_SHADOW_SAMPLE_RATE: raw(env, "PI_JEV_SHADOW_SAMPLE_RATE") ?? String(DECISION_ENGINE_DEFAULTS.shadowSampleRate),
    PI_JEV_POLICY_VERSION: raw(env, "PI_JEV_POLICY_VERSION") ?? DECISION_ENGINE_DEFAULTS.policyVersion,
    PI_JEV_ALLOW_SOURCE: raw(env, "PI_JEV_ALLOW_SOURCE") ?? "false",
  });

  if (!parsed.success) {
    return { ok: false, reason: "invalid_configuration", detail: describeIssues(parsed.error) };
  }

  const values = parsed.data;
  if (values.PI_JEV_ALLOW_SOURCE === "true") {
    // Docs/26 §11: sending source is not allowed in this phase at all.
    return {
      ok: false,
      reason: "invalid_configuration",
      detail: "PI_JEV_ALLOW_SOURCE must be false; sending source/diff is not permitted in this phase",
    };
  }

  if (values.PI_DECISION_ENGINE === "jev" && !hasApiKey) {
    return {
      ok: false,
      reason: "missing_credentials",
      detail: "PI_DECISION_ENGINE=jev requires TYPESAFE_API_KEY to be configured",
    };
  }

  return {
    ok: true,
    config: {
      engine: values.PI_DECISION_ENGINE,
      mode: values.PI_JEV_MODE,
      baseUrl,
      model: values.PI_JEV_MODEL,
      timeoutMs: values.PI_JEV_TIMEOUT_MS,
      maxAttempts: values.PI_JEV_MAX_ATTEMPTS,
      maxStateTokens: values.PI_JEV_STATE_MAX_TOKENS,
      maxStateBytes: values.PI_JEV_STATE_MAX_BYTES,
      reviewMaxFindings: values.PI_JEV_REVIEW_MAX_FINDINGS,
      shadowSampleRate: values.PI_JEV_SHADOW_SAMPLE_RATE,
      policyVersion: values.PI_JEV_POLICY_VERSION,
      allowSource: false,
      hasApiKey,
    },
  };
}
