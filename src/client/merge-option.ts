/**
 * A2/UX: the run-detail 「接受交付 → 合并到工作区默认分支」 option is admin-only
 * server-side (`planMergeGate` returns 403 `ADMIN_REQUIRED`). The UI must not
 * offer an action that can only fail, so this pure helper decides what the
 * checkbox shows. Kept React-free so it is unit-testable.
 */

import { DEFAULT_LOCALE, t, type Locale } from "../shared/i18n";

export interface MergeOptionState {
  /** Always rendered so the reason is visible; hidden only if a future flag says so. */
  show: boolean;
  /** True for non-admins (and while the identity is still loading). */
  disabled: boolean;
  /** Empty for admins; an explanation for everyone else. */
  hint: string;
}

export function mergeOptionState(user?: { isAdmin?: boolean } | null, locale: Locale = DEFAULT_LOCALE): MergeOptionState {
  if (user?.isAdmin) return { show: true, disabled: false, hint: "" };
  if (!user) {
    return { show: true, disabled: true, hint: t(locale, "merge.optionLoading") };
  }
  return {
    show: true,
    disabled: true,
    hint: t(locale, "merge.optionDenied"),
  };
}
