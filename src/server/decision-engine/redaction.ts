/**
 * Redaction, canonicalisation and payload limits (docs/26 §9.2/§14.1).
 *
 * Everything the decision plane sends outbound passes through here. Two rules
 * shape the module:
 *
 *  1. Field allowlisting decides *what* may leave (that projection lives with
 *     the request builder); redaction guarantees that whatever is left cannot
 *     contain a credential, a private key block, an Authorization header, a
 *     cookie, an email or a high-entropy secret.
 *  2. Payload limits are measured on the serialized, already-redacted form and
 *     an over-limit payload is *rejected* (`payload_rejected`) — the fixed
 *     question definitions are never silently truncated to make something fit.
 *
 * The conventions mirror the rest of PiGO: `[redacted]` is the replacement token
 * (see `redactJobSecrets` in `src/worker/index.ts` and the Fastify logger), and
 * `stateHash` is a SHA-256 over canonical JSON so key order cannot change it.
 */

import { createHash } from "node:crypto";
import type { DecisionQuestion } from "./types.js";

export const REDACTED = "[redacted]";
/** Excerpts sent to the provider are capped at 300 characters. */
export const EXCERPT_MAX_CHARS = 300;
/** Conservative chars→tokens divisor (CJK ≈ 1 token/char at 3 bytes/char). */
export const TOKENS_PER_CHAR_DIVISOR = 3;

/** One redaction rule: a regex to find and the replacement (may use `$1`). */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Ordered rules. Specific credential shapes run before the generic
 * high-entropy sweep so a classified secret keeps a meaningful replacement.
 */
const RULES: RedactionRule[] = [
  {
    name: "private_key_block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    name: "url_credentials",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replacement: REDACTED,
  },
  {
    name: "authorization_header",
    pattern: /(\bauthorization\b\s*[:=]\s*)(?:bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: "bearer_token",
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    name: "cookie_header",
    pattern: /((?:set-)?cookie\b\s*[:=]\s*)[^\r\n;]{4,}/gi,
    replacement: `$1${REDACTED}`,
  },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: REDACTED },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, replacement: REDACTED },
];

/** Candidate runs long enough to plausibly be a secret. */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{24,}/g;
const HIGH_ENTROPY_MIN_BITS = 3.5;

/** Shannon entropy (bits per character) of a candidate token. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * A long random-looking token. Requires at least one digit *and* one letter so
 * ordinary long identifiers (`StateMaxTokensConfiguration`) are not eaten, plus
 * the entropy floor so `aaaaaaaa…` / `0000…` are left alone.
 */
function looksHighEntropy(token: string): boolean {
  if (token.length < 24) return false;
  if (!/[0-9]/.test(token)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  return shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS;
}

function highEntropyRule(text: string): string {
  return text.replace(HIGH_ENTROPY_CANDIDATE, (token) => (looksHighEntropy(token) ? REDACTED : token));
}

/** Redacts one string. Safe on any text and idempotent. */
export function redactText(value: string): string {
  let output = String(value ?? "");
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, rule.replacement);
  }
  return highEntropyRule(output);
}

/** Names of the rules that matched `value` (audit/diagnostics; no values). */
export function matchedRedactionRules(value: string): string[] {
  const text = String(value ?? "");
  const matched = RULES.filter((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(text);
  }).map((rule) => rule.name);
  if (highEntropyRule(text) !== text) matched.push("high_entropy");
  return matched;
}

/** Deep-redacts every string in a JSON-ish structure, preserving shape. */
export function redactDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value as object)) return "[circular]" as unknown as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, seen)) as unknown as T;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const item = source[key];
    if (item === undefined) continue;
    output[key] = redactDeep(item, seen);
  }
  return output as unknown as T;
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    output[key] = canonicalize(source[key], seen);
  }
  return output;
}

/** Deterministic JSON: object keys sorted recursively, non-finite ⇒ null. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet())) ?? "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * SHA-256 of the canonical, redacted state. Redaction is applied defensively so
 * a caller that forgot to project cannot produce a hash over raw content.
 */
export function stateHash(state: unknown): string {
  return sha256Hex(canonicalJson(redactDeep(state)));
}

/** SHA-256 of the versioned question definitions (options/levels included). */
export function questionSchemaHash(questions: Record<string, DecisionQuestion>): string {
  return sha256Hex(canonicalJson(questions));
}

/** Conservative token estimate: bytes ÷ 3, rounded up. */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(String(text ?? ""), "utf8");
  return Math.ceil(bytes / TOKENS_PER_CHAR_DIVISOR);
}

export interface PayloadLimits {
  maxTokens: number;
  maxBytes: number;
}

export interface PayloadMeasurement {
  /** Tokens of the serialized state alone. */
  stateTokens: number;
  /** Tokens of the largest single question definition. */
  longestQuestionTokens: number;
  /** `stateTokens + longestQuestionTokens` (the provider's 32k-shaped budget). */
  tokens: number;
  /** Bytes of the serialized `{state, questions}` payload. */
  bytes: number;
}

/** Redacted, bounded excerpt for a provider payload. */
export function redactExcerpt(value: string | null | undefined, maxChars = EXCERPT_MAX_CHARS): string {
  const text = redactText(String(value ?? "")).trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function questionList(questions: Record<string, DecisionQuestion> | undefined) {
  return Object.entries(questions ?? {});
}

/**
 * Measures the outbound payload: state tokens + the longest question, plus the
 * serialized byte count. Never returns any payload content.
 */
export function measurePayload(
  state: unknown,
  questions: Record<string, DecisionQuestion> | undefined,
): PayloadMeasurement {
  const stateTokens = estimateTokens(canonicalJson(state));
  const longestQuestionTokens = questionList(questions).reduce(
    (max, [, question]) => Math.max(max, estimateTokens(canonicalJson(question))),
    0,
  );
  const bytes = Buffer.byteLength(canonicalJson({ state, questions: questions ?? {} }), "utf8");
  return { stateTokens, longestQuestionTokens, tokens: stateTokens + longestQuestionTokens, bytes };
}

export type PayloadLimitCheck =
  | { ok: true; measurement: PayloadMeasurement }
  | { ok: false; reason: "payload_rejected"; detail: string; measurement: PayloadMeasurement };

/**
 * Enforces both payload guards. Over-limit ⇒ `payload_rejected`; the caller must
 * fall back, never truncate the question set to squeeze under the cap.
 */
export function checkPayloadLimits(
  state: unknown,
  questions: Record<string, DecisionQuestion> | undefined,
  limits: PayloadLimits,
): PayloadLimitCheck {
  const measurement = measurePayload(state, questions);
  if (measurement.tokens > limits.maxTokens) {
    return {
      ok: false,
      reason: "payload_rejected",
      detail: `state + longest question estimated at ${measurement.tokens} tokens > ${limits.maxTokens}`,
      measurement,
    };
  }
  if (measurement.bytes > limits.maxBytes) {
    return {
      ok: false,
      reason: "payload_rejected",
      detail: `serialized payload ${measurement.bytes} bytes > ${limits.maxBytes}`,
      measurement,
    };
  }
  return { ok: true, measurement };
}

const MANIFEST_FIELD_LIMIT = 200;

interface ManifestAccumulator {
  fields: Set<string>;
  counts: Record<string, number>;
  truncated: boolean;
}

function walkManifest(value: unknown, path: string, acc: ManifestAccumulator, depth: number): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    if (acc.fields.size < MANIFEST_FIELD_LIMIT) acc.fields.add(path || "value");
    return;
  }
  if (depth > 8) return;
  if (Array.isArray(value)) {
    if (acc.fields.size < MANIFEST_FIELD_LIMIT) acc.fields.add(path || "[]");
    acc.counts[path || "[]"] = value.length;
    value.forEach((item, index) => walkManifest(item, `${path}[${index}]`, acc, depth + 1));
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    if (acc.fields.size < MANIFEST_FIELD_LIMIT) acc.fields.add(path || "{}");
    return;
  }
  for (const key of keys) {
    if (acc.fields.size >= MANIFEST_FIELD_LIMIT) {
      acc.truncated = true;
      return;
    }
    walkManifest(record[key], path ? `${path}.${key}` : key, acc, depth + 1);
  }
}

/**
 * Field names, array counts and sizes of the outbound payload — never a value.
 * This is what the audit row stores (`state_manifest_json`).
 */
export function stateManifest(
  state: unknown,
  questions?: Record<string, DecisionQuestion>,
): Record<string, unknown> {
  const acc: ManifestAccumulator = { fields: new Set(), counts: {}, truncated: false };
  walkManifest(state, "", acc, 0);
  const stateJson = canonicalJson(state);
  const questionEntries = questionList(questions);
  return {
    fields: [...acc.fields].sort(),
    counts: acc.counts,
    fieldsTruncated: acc.truncated,
    stateBytes: Buffer.byteLength(stateJson, "utf8"),
    stateChars: stateJson.length,
    stateTokens: estimateTokens(stateJson),
    questionCount: questionEntries.length,
    questionIds: questionEntries.map(([id]) => id).sort(),
    questions: questionEntries.map(([id, question]) => ({
      id,
      type: question.type,
      optionCount: question.type === "choice" ? question.options.length : undefined,
      levelCount: question.type === "score" ? question.levels.length : undefined,
    })),
  };
}
