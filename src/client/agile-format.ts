import { DEFAULT_LOCALE, intlLocale, t, type Locale, type MessageKey } from "../shared/i18n";
import { type AgileRelease, type AgileSprint, type ReleaseDeployRecord } from "../shared/agile";

/** Catalog key for the sprint/release/deploy badges (labels live in the catalog). */
export const sprintStatusKey = (status: AgileSprint["status"]): MessageKey => `agile.sprintStatus.${status}` as MessageKey;
export const releaseStatusKey = (status: AgileRelease["status"]): MessageKey => `agile.releaseStatus.${status}` as MessageKey;
export const deployStatusKey = (status: ReleaseDeployRecord["status"]): MessageKey => `agile.deployStatus.${status}` as MessageKey;

export const formatTime = (value: string, locale: Locale = DEFAULT_LOCALE) =>
  new Intl.DateTimeFormat(intlLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

/** Compact human duration for cycle times (seconds in). */
export function formatDuration(seconds: number, locale: Locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds >= 86_400) return t(locale, "agile.duration.days", { value: (seconds / 86_400).toFixed(1) });
  if (seconds >= 3_600) return t(locale, "agile.duration.hours", { value: (seconds / 3_600).toFixed(1) });
  if (seconds >= 60) return t(locale, "agile.duration.minutes", { value: Math.round(seconds / 60) });
  return t(locale, "agile.duration.seconds", { value: Math.round(seconds) });
}
