/**
 * B6 — pure formatting for the cleanup UI. The v0.22 mismatch was a wording bug:
 * the batch confirmation promised "worktree 保留" while the server deleted the
 * run directory. Keeping the confirmation text and the outcome labels here (and
 * tested without React) makes the UI state exactly what the request will do.
 *
 * Text lives in the shared catalog; the optional `locale` (default 中文) keeps
 * the helpers usable from non-React tests.
 */

import { DEFAULT_LOCALE, t, type Locale } from "../shared/i18n";

export type CleanupStorage = "removed" | "kept";

/** Confirmation for the batch cleanup action; mirrors the `deleteRunDirectory` intent. */
export function batchCleanupConfirmMessage(input: { count: number; deleteRunDirectory: boolean }, locale: Locale = DEFAULT_LOCALE): string {
  const heading = t(locale, "cleanup.batchHeading", { count: input.count });
  const body = input.deleteRunDirectory ? t(locale, "cleanup.removeRecords") : t(locale, "cleanup.keepRecords");
  return `${heading}\n\n${body}`;
}

/** Confirmation for the sidebar "cleanup finished runs" action. */
export function cleanupFinishedConfirmMessage(input: { olderThanDays: number; deleteRunDirectory: boolean }, locale: Locale = DEFAULT_LOCALE): string {
  const heading = t(locale, "cleanup.finishedHeading", { days: input.olderThanDays });
  const body = input.deleteRunDirectory ? t(locale, "cleanup.removeRecordsEvents") : t(locale, "cleanup.keepRecordsEvents");
  return `${heading}\n\n${body}`;
}

/** Per-run label for the post-action summary. */
export function cleanupStorageLabel(storage?: CleanupStorage, locale: Locale = DEFAULT_LOCALE): string {
  if (storage === "removed") return t(locale, "cleanup.storage.removed");
  if (storage === "kept") return t(locale, "cleanup.storage.kept");
  return t(locale, "cleanup.storage.unknown");
}

/** Aggregate line for the post-action summary. */
export function summarizeCleanupStorage(results: Array<{ storage?: CleanupStorage }>, locale: Locale = DEFAULT_LOCALE): string {
  const removed = results.filter((result) => result.storage === "removed").length;
  const kept = results.filter((result) => result.storage === "kept").length;
  return t(locale, "cleanup.storageSummary", { removed, kept });
}

/** Per-run detail lines, bounded so a 50-run batch alert stays readable. */
export function cleanupStorageDetailLines(
  results: Array<{ runId: string; storage?: CleanupStorage }>,
  limit = 10,
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  return results
    .slice(0, limit)
    .map((result) => `${result.runId.slice(0, 12)}：${cleanupStorageLabel(result.storage, locale)}`);
}
