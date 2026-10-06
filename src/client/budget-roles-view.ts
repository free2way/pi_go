/**
 * AT-JEV-062 — cost rendering for the budget role table.
 *
 * The decision plane (TypeSafe/Jev) produces real calls in shadow mode but has
 * no entry in the price table, so those calls are reported with
 * `unpricedCalls > 0` and a `estimatedCost` that only covers the priced calls.
 * Rendering `$0.000` for a role whose calls are unpriced would be a lie
 * (AT-JEV-062 requires null/unknown, never `$0.00`).
 *
 * Keeping the classification here (pure, no React) makes the three states —
 * fully priced / partially priced / unknown — unit-testable, and keeps the
 * wording in the shared catalog.
 */

import { DEFAULT_LOCALE, t, type Locale } from "../shared/i18n";
import type { RunRoleUsage } from "../shared/types";

/** The fields the cost decision depends on; accepts a full `RunRoleUsage`. */
export type RoleCostEntry = Pick<RunRoleUsage, "calls" | "estimatedCost" | "unpricedCalls">;

export type RoleCostDisplay =
  /** Every call was priced: render the plain amount. */
  | { kind: "priced"; amount: number }
  /** Some calls were priced, some not: render `≥ $x` (a lower bound). */
  | { kind: "partial"; amount: number; unpricedCalls: number }
  /** No call could be priced: render "unknown" — never `$0.000`. */
  | { kind: "unknown"; unpricedCalls: number };

/** Counts are advisory data from the server; clamp to a sane non-negative integer. */
function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeAmount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Classifies a role row's cost. `unpricedCalls` missing or 0 means the row
 * predates the field (or is fully priced) and is rendered as before.
 */
export function roleCostDisplay(entry: RoleCostEntry): RoleCostDisplay {
  const amount = normalizeAmount(entry.estimatedCost);
  const unpricedCalls = normalizeCount(entry.unpricedCalls);
  const calls = normalizeCount(entry.calls);
  // `calls === 0 && unpricedCalls > 0` is also unknown: a price of `$0.000`
  // there would claim "free" rather than "not priced".
  if (unpricedCalls > 0 && unpricedCalls >= calls) return { kind: "unknown", unpricedCalls };
  if (unpricedCalls > 0) return { kind: "partial", amount, unpricedCalls };
  return { kind: "priced", amount };
}

/** The COST cell text for one role row. */
export function roleCostLabel(entry: RoleCostEntry, locale: Locale = DEFAULT_LOCALE): string {
  const display = roleCostDisplay(entry);
  if (display.kind === "unknown") return t(locale, "budget.costUnknown");
  if (display.kind === "partial") return `≥ $${display.amount.toFixed(3)}`;
  return `$${display.amount.toFixed(3)}`;
}

/** Total unpriced calls across all role rows, for the panel-level notice. */
export function totalUnpricedCalls(roles: readonly RoleCostEntry[] | undefined): number {
  return (roles ?? []).reduce((total, entry) => total + normalizeCount(entry.unpricedCalls), 0);
}

/**
 * Human-readable role name. Only the decision plane is remapped; every other
 * role keeps the raw identifier the server sent (e.g. `sub-agent`).
 */
export function roleDisplayName(role: string, locale: Locale = DEFAULT_LOCALE): string {
  if (role === "decision") return t(locale, "budget.roleDecision");
  return role;
}
