import type { Finding } from "../shared/types.js";

/** Previous findings count as addressed once a new review arrives; new findings start unresolved. */
export function mergeFindings(previous: Finding[], incoming: Array<Omit<Finding, "resolved"> | Finding>): Finding[] {
  return [
    ...previous.map((item) => ({ ...item, resolved: true })),
    ...incoming.map((item) => ({ ...item, resolved: false })),
  ];
}

/** Serialized unresolved findings, used as the repair brief when a human resumes a run. */
export function unresolvedFeedback(findings: Finding[] | undefined): string {
  const unresolved = (findings ?? []).filter((item) => !item.resolved);
  return unresolved.length ? JSON.stringify(unresolved, null, 2) : "";
}
