/**
 * Cross-round finding identity (incident `run_e7c565d6335a4bc7`).
 *
 * The reviewer raised one and the same defect across rounds 2–6, but each round
 * recorded it under a different id (`story-unblock-state-not-restored` / `F1` /
 * `STORY-BLOCK-001`) and reworded the title slightly. Because identity was bound
 * to the model-provided id, every round looked like a fresh problem: the
 * repeated-severe threshold never fired, the convergence guard never fired, and
 * the run burned six rounds without converging.
 *
 * Identity must therefore come from the *content* of the finding, not from the
 * id the model happened to choose. This module is pure and shared by the worker
 * (merge/streak bookkeeping) and the server (durable `stable_key` column), so
 * both sides derive exactly the same key.
 */

/** Placeholder used when the reviewer could not attribute the problem to a file. */
export const NO_FILE_TOKEN = "<no-file>";

/** Minimal shape needed to derive identity; tolerates extra fields. */
export interface FindingIdentityInput {
  file?: string | null;
  title?: string | null;
  /** Accepted (and ignored) so callers can pass a full `Finding`. */
  requiredChange?: string;
}

/**
 * Normalizes a file path: trims, converts Windows separators, lowercases and
 * strips any number of leading `./`. A null/empty/`.` path becomes the
 * placeholder token so an unattributed problem still has a stable key.
 */
export function normalizeFindingFile(file: string | null | undefined): string {
  if (file === null || file === undefined) return NO_FILE_TOKEN;
  let value = String(file).trim().replace(/\\/g, "/").toLowerCase();
  while (value.startsWith("./")) value = value.slice(2);
  return value === "" ? NO_FILE_TOKEN : value;
}

/**
 * Normalizes a title: lowercases, drops a leading list marker (`- `, `1. `,
 * `- [ ] `), collapses whitespace and strips trailing punctuation (ASCII and
 * Chinese 句号). Wording differences that do not change the defect therefore
 * still produce the same key.
 */
export function normalizeFindingTitle(title: string | null | undefined): string {
  let value = String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  value = value.replace(/^(?:[-*+•]\s+(?:\[[ x]\]\s+)?|\d+[.)、]\s+)/, "");
  value = value.replace(/[.。!！?？;；:：,，、]+$/, "").trim();
  return value;
}

/**
 * Stable, human-readable identity: `<normalized file>|<normalized title>`.
 * Deliberately ignores severity, line number, evidence, required change and the
 * model-provided id, so a reworded/re-id'd repeat keeps the same identity.
 */
export function findingFingerprint(finding: FindingIdentityInput): string {
  return `${normalizeFindingFile(finding.file)}|${normalizeFindingTitle(finding.title)}`;
}
