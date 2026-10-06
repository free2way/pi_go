import type { CredentialVerificationState, ModelInfo } from "../shared/types";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";

/**
 * AUD-08: presentation rules for credential/model verification.
 *
 * The server tells the client exactly how much is known about a provider key:
 * `live` (a real probe succeeded), `operator_asserted` (probing was disabled
 * and the operator asserted the key works) or `unchecked`. The UI must never
 * collapse the asserted/unchecked cases into a "verified" badge, so the mapping
 * lives here as a pure function that can be unit tested without a DOM.
 *
 * Copy lives in the shared catalog; an optional `locale` (default 中文) keeps
 * every existing call site and test meaningful.
 */

/** Catalog keys for the fallback copy, used only when the server sent no label. */
export const VERIFICATION_FALLBACK_KEYS: Record<CredentialVerificationState, MessageKey> = {
  live: "models.verified",
  operator_asserted: "models.asserted",
  unchecked: "models.unchecked",
};

export type VerificationTone = "ok" | "warn";

/** Minimal shape shared by `ModelInfo` and per-provider credential entries. */
export interface VerificationInput {
  verification?: CredentialVerificationState;
  asserted?: boolean;
  verified?: boolean;
  verificationLabel?: string;
}

export interface VerificationBadge {
  state: CredentialVerificationState;
  label: string;
  tone: VerificationTone;
  title: string;
}

/**
 * Resolves the verification state, tolerating responses that predate the field:
 * `asserted` wins over a bare `verified` flag, and a missing state is treated
 * as `unchecked` rather than assumed verified.
 */
export function modelVerificationState(entry: Pick<ModelInfo, "verification" | "asserted" | "verified">): CredentialVerificationState {
  if (entry.verification) return entry.verification;
  if (entry.asserted === true) return "operator_asserted";
  if (entry.verified === true) return "live";
  return "unchecked";
}

export function verificationBadge(entry: VerificationInput, locale: Locale = DEFAULT_LOCALE): VerificationBadge {
  const state = modelVerificationState({
    verification: entry.verification,
    asserted: entry.asserted,
    verified: entry.verified,
  });
  // A server-provided label wins: it is server-generated copy (docs/23 boundary).
  const label = entry.verificationLabel?.trim() || t(locale, VERIFICATION_FALLBACK_KEYS[state]);
  const title =
    state === "live"
      ? t(locale, "models.verifyLiveTitle")
      : state === "operator_asserted"
        ? t(locale, "models.verifyAssertedTitle")
        : t(locale, "models.verifyUncheckedTitle");
  return { state, label, tone: state === "live" ? "ok" : "warn", title };
}

export interface CapabilityHint {
  /** Catalog key of the hint label (the component may render it directly). */
  labelKey: MessageKey;
  label: string;
  runtimeVerified: boolean;
  title: string;
}

/**
 * Distinguishes provider-reported capabilities (from a live probe) from the
 * static catalog defaults. A runtime capability is only claimed when the
 * backing credential is itself live-verified, so an asserted/unchecked key can
 * never surface "runtime" capabilities.
 */
export function modelCapabilityHint(
  entry: Pick<ModelInfo, "capabilities" | "capabilitiesVerified" | "contextWindow" | "maxOutputTokens" | "verification" | "asserted" | "verified">,
  locale: Locale = DEFAULT_LOCALE,
): CapabilityHint | undefined {
  const hasCapabilities = entry.capabilities != null || entry.contextWindow !== undefined || entry.maxOutputTokens !== undefined;
  if (!hasCapabilities) return undefined;
  const runtimeVerified = entry.capabilitiesVerified === true && modelVerificationState(entry) === "live";
  if (runtimeVerified) {
    return {
      labelKey: "models.capabilityRuntime",
      label: t(locale, "models.capabilityRuntime"),
      runtimeVerified: true,
      title: t(locale, "models.capabilityRuntimeTitle"),
    };
  }
  return {
    labelKey: "models.capabilityCatalog",
    label: t(locale, "models.capabilityCatalog"),
    runtimeVerified: false,
    title: t(locale, "models.capabilityCatalogTitle"),
  };
}

/** Availability copy kept separate from the verification badge. */
export function availabilityLabel(
  entry: Pick<ModelInfo, "available" | "unavailableReason">,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (entry.available) return t(locale, "models.available");
  switch (entry.unavailableReason) {
    case "credential_missing":
      return t(locale, "models.unavailable.credential_missing");
    case "model_unverified":
      return t(locale, "models.unavailable.model_unverified");
    case "role_restricted":
      return t(locale, "models.unavailable.role_restricted");
    default:
      return t(locale, "models.unavailable.pending");
  }
}
