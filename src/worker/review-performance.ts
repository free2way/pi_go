import type { PiSessionRole } from "./pi-session.js";

export type ThinkingLevel = "low" | "medium" | "high";

/** Reviewer defaults to medium; high remains an explicit operator choice. */
export const defaultReviewerThinking: ThinkingLevel = "medium";

/** Strict parser; an invalid value never silently increases reasoning effort. */
export function parseThinkingLevel(
  value: string | undefined,
  fallback: ThinkingLevel,
): ThinkingLevel {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : fallback;
}

/**
 * A late reviewer failure is expensive to replay because the current Pi CLI has
 * no resumable stream/RPC transport. Fast failures retain the normal retry path.
 */
export const defaultReviewerRetryMaxElapsedMs = 120_000;

export function reviewerRetryMaxElapsedMs(
  value: string | undefined = process.env.PI_REVIEW_RETRY_MAX_ELAPSED_SECONDS,
): number {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return defaultReviewerRetryMaxElapsedMs;
  const seconds = Number(raw);
  // 0 explicitly disables the late-failure guard.
  return seconds === 0 ? Number.POSITIVE_INFINITY : Math.max(1, seconds) * 1_000;
}

export function shouldRetryProviderAttempt(input: {
  role: PiSessionRole;
  elapsedMs: number;
  reviewerMaxElapsedMs: number;
}): boolean {
  return input.role !== "reviewer" || input.elapsedMs <= input.reviewerMaxElapsedMs;
}
