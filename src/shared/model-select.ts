import type { MessageKey } from "./i18n";
import type { ModelInfo, ModelRole } from "./types";

/**
 * Single source of truth for "can this (provider, model) pair actually be used
 * for this role?".
 *
 * The server decides with `validateModelSelection` (src/server/model-catalog.ts)
 * over the allow-list + credential availability. The client only ever sees the
 * `/api/models` projection (`ModelInfo`), so this predicate mirrors the same
 * acceptance rules against exactly the data that projection carries:
 *
 *   server rule (`validateModelSelection`)        data needed here
 *   --------------------------------------------  -------------------------
 *   MODEL_NOT_FOUND   entry absent from catalog   `entry == null`
 *   MODEL_NOT_ALLOWED role missing on the entry    `entry.roles`
 *   MODEL_UNAVAILABLE credential not configured    `unavailableReason`
 *   MODEL_NOT_AVAILABLE credential/model unverified`unavailableReason`
 *   ok                otherwise                    `available === true`
 *
 * It is conservative by construction: anything that is not explicitly accepted
 * (`available === true` with the role present) is treated as NOT selectable, so
 * the UI can never offer a pair the run preflight is about to reject because of
 * a field it did not understand.
 *
 * Residual (documented, not mirrored): the server also returns
 * `MODEL_CONFIG_INVALID` when the *catalog as a whole* covers no model for a
 * role, and `PERSONAL_CREDENTIALS_REQUIRED` when a provider key exists in the
 * catalogue but not in the operator's vault. Both are handled at the dialog
 * level (an empty/not-covered role is surfaced as a configuration notice) rather
 * than guessed per entry.
 */
export type ModelSelectCode = "MODEL_NOT_FOUND" | "MODEL_NOT_ALLOWED" | "MODEL_UNAVAILABLE" | "MODEL_NOT_AVAILABLE";

/** Every role a real run can be preflighted for (see `preflightRunModels`). */
export const MODEL_ROLES: readonly ModelRole[] = ["developer", "reviewer"];

export interface ModelSelectionDecision {
  /** True only when the preflight would accept this pair for the role. */
  selectable: boolean;
  /** The preflight code this pair would fail with, or null when selectable. */
  code: ModelSelectCode | null;
  /** Catalog key of the concise, operator-facing explanation, or null. */
  reasonKey: MessageKey | null;
}

const NOT_SELECTABLE = (code: ModelSelectCode, reasonKey: MessageKey): ModelSelectionDecision => ({
  selectable: false,
  code,
  reasonKey,
});

/**
 * Mirrors `validateModelSelection` for a single role using only `ModelInfo`.
 * `entry` is `undefined` when the pair is absent from the catalogue
 * (`MODEL_NOT_FOUND`).
 */
export function modelSelectionDecision(
  entry: Pick<ModelInfo, "roles" | "available" | "unavailableReason"> | null | undefined,
  role: ModelRole,
): ModelSelectionDecision {
  if (!entry) return NOT_SELECTABLE("MODEL_NOT_FOUND", "createRun.modelUnavailable.catalog");
  if (!Array.isArray(entry.roles) || !entry.roles.includes(role)) {
    // The catalogue entry exists but does not carry this role: the preflight
    // reports MODEL_NOT_ALLOWED (or MODEL_CONFIG_INVALID when no entry at all
    // covers the role, handled by the caller).
    return NOT_SELECTABLE("MODEL_NOT_ALLOWED", "createRun.modelUnavailable.role");
  }
  if (entry.available !== true) {
    switch (entry.unavailableReason) {
      case "credential_missing":
        return NOT_SELECTABLE("MODEL_UNAVAILABLE", "createRun.missingCredentialSuffix");
      case "credential_unverified":
        return NOT_SELECTABLE("MODEL_NOT_AVAILABLE", "createRun.modelUnavailable.unverified");
      case "model_unverified":
        return NOT_SELECTABLE("MODEL_NOT_AVAILABLE", "createRun.modelUnavailable.model");
      case "role_restricted":
        return NOT_SELECTABLE("MODEL_NOT_ALLOWED", "createRun.modelUnavailable.role");
      default:
        // Unknown/older reason: stay conservative instead of guessing.
        return NOT_SELECTABLE("MODEL_NOT_AVAILABLE", "createRun.modelUnavailable.unknown");
    }
  }
  return { selectable: true, code: null, reasonKey: null };
}

/** Convenience boolean form of {@link modelSelectionDecision}. */
export function isModelSelectableForRole(
  entry: Pick<ModelInfo, "roles" | "available" | "unavailableReason"> | null | undefined,
  role: ModelRole,
): boolean {
  return modelSelectionDecision(entry, role).selectable;
}

/**
 * Entries the catalogue exposes for `role` (the UI must not invent pairs that
 * are not in the allow-list at all: those stay absent, matching MODEL_NOT_FOUND).
 */
export function catalogEntriesForRole<T extends Pick<ModelInfo, "roles">>(
  entries: readonly T[] | undefined,
  role: ModelRole,
): T[] {
  return (entries ?? []).filter((entry) => Array.isArray(entry.roles) && entry.roles.includes(role));
}

/** Entries the preflight would accept for `role` (enabled options). */
export function selectableModelsForRole<T extends Pick<ModelInfo, "roles" | "available" | "unavailableReason">>(
  entries: readonly T[] | undefined,
  role: ModelRole,
): T[] {
  return catalogEntriesForRole(entries, role).filter((entry) => isModelSelectableForRole(entry, role));
}

/**
 * True when the catalogue covers no *selectable* model for the role — the client
 * analogue of the server's MODEL_CONFIG_INVALID. The dialog surfaces this as a
 * configuration notice instead of rendering an unexplained empty select.
 */
export function roleCovered<T extends Pick<ModelInfo, "roles" | "available" | "unavailableReason">>(
  entries: readonly T[] | undefined,
  role: ModelRole,
): boolean {
  return selectableModelsForRole(entries, role).length > 0;
}
