import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";
import { catalogEntriesForRole, modelSelectionDecision, roleCovered, type ModelSelectCode } from "../shared/model-select";
import type { ModelInfo, ModelRole } from "../shared/types";

/**
 * AUD-09: the create-run dialog may only offer (provider, model) pairs the run
 * preflight will accept, and every pair it cannot offer must be visibly disabled
 * with the reason (never silently dropped when the operator would need to know
 * why).
 *
 * This module is the pure, DOM-free half of that rule: it turns the
 * `/api/models` projection into render-ready options using the shared
 * `modelSelectionDecision` predicate. Entries the catalogue does not expose for
 * the role at all stay absent (the server would answer `MODEL_NOT_FOUND`, so
 * there is nothing to explain); entries that are exposed but unusable are kept
 * and disabled with a localized explanation.
 */

export interface ModelOption {
  id: string;
  role: ModelRole;
  provider: string;
  model: string;
  label: string;
  /** `provider/model`, kept next to the label so two same-named models differ. */
  pair: string;
  /** True only when `POST /api/runs` would accept this pair for the role. */
  selectable: boolean;
  /** The preflight code this pair would fail with, or null when selectable. */
  code: ModelSelectCode | null;
  reasonKey: MessageKey | null;
  /** Localized explanation suffix; empty when selectable. */
  reason: string;
}

/**
 * Options for one role. Ordering follows the catalogue so the server default
 * stays where the API put it.
 */
export function buildRoleModelOptions(
  entries: readonly ModelInfo[] | undefined,
  role: ModelRole,
  locale: Locale = DEFAULT_LOCALE,
): ModelOption[] {
  return catalogEntriesForRole(entries, role).map((entry) => {
    const decision = modelSelectionDecision(entry, role);
    return {
      id: entry.id,
      role,
      provider: entry.provider,
      model: entry.model,
      label: entry.label,
      pair: `${entry.provider}/${entry.model}`,
      selectable: decision.selectable,
      code: decision.code,
      reasonKey: decision.reasonKey,
      reason: decision.reasonKey ? t(locale, decision.reasonKey) : "",
    };
  });
}

/** `{ label } · { provider/model}{ reason }`, the visible option text. */
export function modelOptionText(option: ModelOption): string {
  return `${option.label} · ${option.pair}${option.reason}`;
}

/** Ids the dialog may submit for the role (enabled options only). */
export function selectableModelIds(entries: readonly ModelInfo[] | undefined, role: ModelRole): string[] {
  return buildRoleModelOptions(entries, role)
    .filter((option) => option.selectable)
    .map((option) => option.id);
}

/**
 * Default selection for a role: the configured default when the catalogue
 * exposes it *and* the preflight would accept it, otherwise the first selectable
 * entry, otherwise "" (which keeps the submit button disabled rather than
 * preselecting something the server rejects).
 */
export function preferredModelId(
  entries: readonly ModelInfo[] | undefined,
  role: ModelRole,
  preferred: { provider: string; model: string } | null | undefined,
): string {
  const options = buildRoleModelOptions(entries, role);
  if (preferred) {
    const exact = options.find((option) => option.provider === preferred.provider && option.model === preferred.model && option.selectable);
    if (exact) return exact.id;
  }
  return options.find((option) => option.selectable)?.id ?? "";
}

/**
 * True when the catalogue exposes no pair the preflight would accept for the
 * role — the client analogue of the server's `MODEL_CONFIG_INVALID`. The dialog
 * shows `createRun.modelRoleUncovered` instead of an empty, unexplained select.
 */
export function roleUncovered(entries: readonly ModelInfo[] | undefined, role: ModelRole): boolean {
  return !roleCovered(entries, role);
}
