/**
 * Provider response contract (docs/26 §6.3/§7).
 *
 * The only place the TypeSafe answer shape is understood. It maps a strict,
 * zod-validated response onto the provider-agnostic {@link DecisionAnswer}:
 *
 *   noul       → probability + derived certainty (NO provider confidence)
 *   choice     → value + probabilities + confidence (option whitelist)
 *   score      → weightedScore + nearest-level value + probabilities + confidence
 *
 * Nothing is partially applied: one malformed/unknown/missing answer rejects the
 * whole evaluation (`contract_invalid`). Numbers must be finite, probabilities
 * inside [0,1], distributions summing to ~1, and every option/level must come
 * from the question the server itself defined. Error details name the question
 * id and the reason — never the raw provider body.
 */

import { z } from "zod";
import { noulCertainty, type DecisionAnswer, type DecisionQuestion, type DecisionRequest } from "./types.js";

/** Allowed deviation of a distribution's sum from 1. */
export const DISTRIBUTION_TOLERANCE = 0.01;

const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);

const optionalKind = z.string().optional();

/** Noul (yes/no): the provider reports only P(true). */
export const noulAnswerSchema = z
  .object({
    type: optionalKind,
    probability,
    value: z.boolean().optional(),
    confidence: probability.optional(),
  })
  .strict();

/** Choice: chosen option + full distribution + confidence. */
export const choiceAnswerSchema = z
  .object({
    type: optionalKind,
    choice: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
    probabilities: distribution.optional(),
    distribution: distribution.optional(),
    confidence: probability,
  })
  .strict();

/** Score: probability-weighted value across the ordered levels + confidence. */
export const scoreAnswerSchema = z
  .object({
    type: optionalKind,
    score: z.number().optional(),
    weighted_score: z.number().optional(),
    probabilities: distribution.optional(),
    distribution: distribution.optional(),
    confidence: probability,
  })
  .strict();

export const providerUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
});

export const providerResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: providerUsageSchema.optional(),
});

export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export type ProviderResponseMapping =
  | {
      ok: true;
      model: string;
      answers: DecisionAnswer[];
      inputTokens?: number;
      outputTokens?: number;
    }
  | { ok: false; detail: string };

function distributionOf(
  questionId: string,
  primary: Record<string, number> | undefined,
  alias: Record<string, number> | undefined,
  allowed: string[],
  label: string,
): { ok: true; probabilities: Record<string, number> } | { ok: false; detail: string } {
  if (primary && alias) return { ok: false, detail: `${questionId}: both probabilities and distribution were provided` };
  const values = primary ?? alias;
  if (!values || Object.keys(values).length === 0) return { ok: false, detail: `${questionId}: missing ${label} distribution` };
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(values)) {
    if (!allowedSet.has(key)) return { ok: false, detail: `${questionId}: unknown ${label} "${key}"` };
  }
  const entries = Object.values(values);
  if (!entries.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    return { ok: false, detail: `${questionId}: ${label} probability out of range` };
  }
  const sum = entries.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) {
    return { ok: false, detail: `${questionId}: ${label} distribution sums to ${sum.toFixed(4)}` };
  }
  return { ok: true, probabilities: { ...values } };
}

function kindMatches(questionId: string, type: string | undefined, accepted: string[]): string | undefined {
  if (type === undefined) return undefined;
  if (accepted.includes(type)) return undefined;
  return `${questionId}: unexpected answer type "${type}"`;
}

function mapProbability(questionId: string, raw: unknown): { ok: true; answer: DecisionAnswer } | { ok: false; detail: string } {
  const parsed = noulAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, detail: `${questionId}: malformed noul answer` };
  const kindError = kindMatches(questionId, parsed.data.type, ["noul", "probability"]);
  if (kindError) return { ok: false, detail: kindError };
  const p = parsed.data.probability;
  return {
    ok: true,
    answer: {
      questionId,
      type: "probability",
      value: p >= 0.5,
      probability: p,
      certainty: noulCertainty(p),
      // Deliberately no `confidence`: Noul has none.
    },
  };
}

function mapChoice(
  questionId: string,
  question: Extract<DecisionQuestion, { type: "choice" }>,
  raw: unknown,
): { ok: true; answer: DecisionAnswer } | { ok: false; detail: string } {
  const parsed = choiceAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, detail: `${questionId}: malformed choice answer` };
  const data = parsed.data;
  const kindError = kindMatches(questionId, data.type, ["choice"]);
  if (kindError) return { ok: false, detail: kindError };
  if (data.choice && data.value && data.choice !== data.value) {
    return { ok: false, detail: `${questionId}: conflicting choice/value` };
  }
  const chosen = data.choice ?? data.value;
  if (!chosen) return { ok: false, detail: `${questionId}: missing choice` };
  if (!question.options.includes(chosen)) return { ok: false, detail: `${questionId}: unknown option "${chosen}"` };
  const dist = distributionOf(questionId, data.probabilities, data.distribution, question.options, "option");
  if (!dist.ok) return dist;
  return {
    ok: true,
    answer: {
      questionId,
      type: "choice",
      value: chosen,
      probabilities: dist.probabilities,
      confidence: data.confidence,
    },
  };
}

function mapScore(
  questionId: string,
  question: Extract<DecisionQuestion, { type: "score" }>,
  raw: unknown,
): { ok: true; answer: DecisionAnswer } | { ok: false; detail: string } {
  const parsed = scoreAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, detail: `${questionId}: malformed score answer` };
  const data = parsed.data;
  const kindError = kindMatches(questionId, data.type, ["score"]);
  if (kindError) return { ok: false, detail: kindError };
  if (data.score !== undefined && data.weighted_score !== undefined && data.score !== data.weighted_score) {
    return { ok: false, detail: `${questionId}: conflicting score/weighted_score` };
  }
  const weightedScore = data.score ?? data.weighted_score;
  if (weightedScore === undefined) return { ok: false, detail: `${questionId}: missing score` };
  if (!Number.isFinite(weightedScore)) return { ok: false, detail: `${questionId}: non-finite score` };
  const levels = question.levels.map((level) => level.value);
  if (levels.length < 2) return { ok: false, detail: `${questionId}: score question needs at least two levels` };
  const dist = distributionOf(questionId, data.probabilities, data.distribution, levels, "level");
  if (!dist.ok) return dist;

  // Levels are ordered low→high; `weightedScore` is the position scale
  // (0..levels-1). Anything outside that range is a contract violation rather
  // than a guess at an unknown provider scale.
  const maxIndex = levels.length - 1;
  if (!(weightedScore >= 0 && weightedScore <= maxIndex)) {
    return { ok: false, detail: `${questionId}: weighted score ${weightedScore} outside level range` };
  }
  const clamped = Math.min(maxIndex, Math.max(0, Math.round(weightedScore)));

  return {
    ok: true,
    answer: {
      questionId,
      type: "score",
      value: levels[clamped],
      weightedScore,
      probabilities: dist.probabilities,
      confidence: data.confidence,
    },
  };
}

function mapAnswer(
  questionId: string,
  question: DecisionQuestion,
  raw: unknown,
): { ok: true; answer: DecisionAnswer } | { ok: false; detail: string } {
  switch (question.type) {
    case "probability":
      return mapProbability(questionId, raw);
    case "choice":
      return mapChoice(questionId, question, raw);
    case "score":
      return mapScore(questionId, question, raw);
    default:
      return { ok: false, detail: `${questionId}: unknown question type` };
  }
}

/**
 * Validates a provider response against the request's fixed questions. Fails
 * wholesale on any mismatch — the caller maps the failure to `contract_invalid`.
 */
export function mapProviderResponse(raw: unknown, request: DecisionRequest): ProviderResponseMapping {
  const envelope = providerResponseSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, detail: "provider response envelope does not match the contract" };

  const { model, answers: rawAnswers, usage } = envelope.data;
  const requestedIds = Object.keys(request.questions);
  for (const key of Object.keys(rawAnswers)) {
    if (!Object.prototype.hasOwnProperty.call(request.questions, key)) {
      return { ok: false, detail: `unexpected answer for unknown question "${key}"` };
    }
  }

  const answers: DecisionAnswer[] = [];
  for (const questionId of requestedIds) {
    if (!Object.prototype.hasOwnProperty.call(rawAnswers, questionId)) {
      return { ok: false, detail: `missing answer for question "${questionId}"` };
    }
    const mapped = mapAnswer(questionId, request.questions[questionId], rawAnswers[questionId]);
    if (!mapped.ok) return mapped;
    answers.push(mapped.answer);
  }

  const result: ProviderResponseMapping = { ok: true, model, answers };
  if (usage?.input_tokens !== undefined) result.inputTokens = usage.input_tokens;
  if (usage?.output_tokens !== undefined) result.outputTokens = usage.output_tokens;
  return result;
}
