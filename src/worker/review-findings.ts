import type { Finding } from "../shared/types.js";
import { findingFingerprint } from "../shared/finding-fingerprint.js";

// AUD-11 / GAP-03 / incident run_e7c565d6335a4bc7: identity is the content-based
// stable key (file + normalized title), so a reviewer that renames the id or
// rewords the title across rounds still increments the SAME finding's streak.
// The pure implementation lives in `src/shared` so the server persists the very
// same key into `run_findings.stable_key`.
export { findingFingerprint };

export interface MergeOptions {
  /** Round the incoming review belongs to (used for observation history). */
  round?: number;
  /** A review that approved the current snapshot closes the previously open findings. */
  approved?: boolean;
}

/**
 * AUD-11: merges a new review into the existing finding list.
 *
 * - A problem that was already reported keeps its identity. Matching is by the
 *   content-based stable key FIRST (file + normalized title), with the
 *   model-provided id only as a fallback, so a reworded or re-id'd repeat
 *   increments the same finding's streak instead of creating a new row.
 * - Previously reported problems are NOT silently marked resolved. They stay
 *   open until a review approves the snapshot, which is the only signal that the
 *   reviewer considers them addressed.
 * - Incoming problems always start unresolved.
 */
export function mergeFindings(
  previous: Finding[],
  incoming: Array<Omit<Finding, "resolved"> | Finding>,
  options: MergeOptions = {},
): Finding[] {
  const round = options.round ?? 1;
  const merged = previous.map((item) => ({ ...item }));
  const byId = new Map(merged.map((item, index) => [item.id, index]));
  // Index by the content key recomputed on read (so a legacy/older-stored
  // fingerprint still matches) and, additionally, by whatever key was persisted.
  const byFingerprint = new Map<string, number>();
  merged.forEach((item, index) => {
    byFingerprint.set(findingFingerprint(item), index);
    if (item.fingerprint && !byFingerprint.has(item.fingerprint)) byFingerprint.set(item.fingerprint, index);
  });
  const matched = new Set<number>();

  for (const raw of incoming) {
    const fingerprint = findingFingerprint(raw);
    const existingIndex = byFingerprint.get(fingerprint) ?? byId.get(raw.id);
    const observed: Finding = {
      ...raw,
      resolved: false,
      fingerprint,
      firstSeenRound: round,
      lastSeenRound: round,
      observations: 1,
      consecutiveRounds: 1,
    };
    if (existingIndex === undefined || merged[existingIndex] === undefined) {
      merged.push(observed);
      matched.add(merged.length - 1);
      byId.set(observed.id, merged.length - 1);
      byFingerprint.set(fingerprint, merged.length - 1);
      continue;
    }
    const current = merged[existingIndex];
    merged[existingIndex] = {
      ...current,
      // Refresh the observation while keeping the original identity.
      severity: raw.severity,
      evidence: raw.evidence,
      requiredChange: raw.requiredChange,
      title: raw.title,
      file: raw.file,
      line: raw.line,
      resolved: false,
      // Identity is content-based; refresh it to the key of the current
      // observation (equal for a correctly re-worded repeat).
      fingerprint,
      firstSeenRound: current.firstSeenRound ?? current.lastSeenRound ?? round,
      lastSeenRound: round,
      observations: (current.observations ?? 1) + 1,
      consecutiveRounds: (current.consecutiveRounds ?? 1) + 1,
    };
    matched.add(existingIndex);
    byId.set(current.id, existingIndex);
    byFingerprint.set(fingerprint, existingIndex);
  }

  if (options.approved) {
    // The reviewer approved this snapshot: everything reported before it counts
    // as addressed, while anything reported in this same review stays open.
    const reportedFingerprints = new Set(incoming.map((item) => findingFingerprint(item)));
    const reportedIds = new Set(incoming.map((item) => item.id));
    return merged.map((item) => {
      const reportedNow = reportedIds.has(item.id) || reportedFingerprints.has(findingFingerprint(item));
      if (reportedNow) return item;
      return { ...item, resolved: true, consecutiveRounds: 0 };
    });
  }
  // AT-REVIEW-010: a problem that was not re-reported this round breaks its
  // "consecutive rounds" streak (it stays open, but is no longer continuous).
  return merged.map((item, index) => (matched.has(index) || item.resolved ? item : { ...item, consecutiveRounds: 0 }));
}

/** Serialized unresolved findings, used as the repair brief when a human resumes a run. */
export function unresolvedFeedback(findings: Finding[] | undefined): string {
  const unresolved = (findings ?? []).filter((item) => !item.resolved);
  return unresolved.length ? JSON.stringify(unresolved, null, 2) : "";
}

/** GAP-03: problems reported unresolved across consecutive reviews. */
export function repeatedFindings(findings: Finding[] | undefined, threshold = 2) {
  return (findings ?? []).filter((item) => !item.resolved && (item.consecutiveRounds ?? 0) >= threshold);
}

/**
 * AT-REVIEW-010 / REVIEW-007: how many consecutive reviews may report the same
 * blocking (critical/high) problem before the run stops auto-repairing and is
 * escalated to `needs_human`. The acceptance spec only says "策略阈值" (policy
 * threshold) and documents no number, so PiGO uses 3: a single repeat is a
 * normal repair iteration, but the same severe finding in 3 consecutive rounds
 * is treated as no progress. Identity is the stable fingerprint, so this holds
 * even when the reviewer renames the id.
 */
export const severeRepeatThreshold = 3;

/** Blocking findings that must be fixed (not merely advisory). */
const severeSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high"];

/**
 * AT-REVIEW-010: unresolved severe findings reported in `threshold` consecutive
 * rounds. Resolved findings and single/occasional occurrences are excluded.
 */
export function repeatedSevereFindings(findings: Finding[] | undefined, threshold = severeRepeatThreshold) {
  return (findings ?? []).filter(
    (item) => !item.resolved && severeSeverities.includes(item.severity) && (item.consecutiveRounds ?? 0) >= threshold,
  );
}
