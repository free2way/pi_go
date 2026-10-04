import { createHash } from "node:crypto";
import type { Finding } from "../shared/types.js";

/**
 * AUD-11 / GAP-03: stable identity for a reported problem. Reviewers often reuse
 * an id (or drop it) across rounds, so identity must not depend on the model's
 * id choice alone: severity-independent fingerprint of file + normalized title.
 */
export function findingFingerprint(finding: Pick<Finding, "file" | "title" | "requiredChange">) {
  const title = finding.title.toLowerCase().replace(/\s+/g, " ").trim();
  const required = finding.requiredChange.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  return createHash("sha256").update(`${finding.file ?? ""}\n${title}\n${required}`).digest("hex").slice(0, 32);
}

export interface MergeOptions {
  /** Round the incoming review belongs to (used for observation history). */
  round?: number;
  /** A review that approved the current snapshot closes the previously open findings. */
  approved?: boolean;
}

/**
 * AUD-11: merges a new review into the existing finding list.
 *
 * - A problem that was already reported keeps its identity (matched by id or
 *   fingerprint): severity/evidence are refreshed and the round counters grow.
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
  const byFingerprint = new Map(merged.map((item, index) => [item.fingerprint ?? findingFingerprint(item), index]));

  for (const raw of incoming) {
    const fingerprint = findingFingerprint(raw);
    const existingIndex = byId.get(raw.id) ?? byFingerprint.get(fingerprint);
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
      fingerprint: current.fingerprint ?? fingerprint,
      firstSeenRound: current.firstSeenRound ?? current.lastSeenRound ?? round,
      lastSeenRound: round,
      observations: (current.observations ?? 1) + 1,
      consecutiveRounds: (current.consecutiveRounds ?? 1) + 1,
    };
    byId.set(current.id, existingIndex);
    byFingerprint.set(current.fingerprint ?? fingerprint, existingIndex);
  }

  if (options.approved) {
    // The reviewer approved this snapshot: everything reported before it counts
    // as addressed, while anything reported in this same review stays open.
    const reportedFingerprints = new Set(incoming.map((item) => findingFingerprint(item)));
    const reportedIds = new Set(incoming.map((item) => item.id));
    return merged.map((item) => {
      const reportedNow = reportedIds.has(item.id) || reportedFingerprints.has(item.fingerprint ?? findingFingerprint(item));
      if (reportedNow) return item;
      return { ...item, resolved: true, consecutiveRounds: 0 };
    });
  }
  return merged;
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
