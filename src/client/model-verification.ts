import type { CredentialVerificationState, ModelInfo } from "../shared/types";

/**
 * AUD-08: presentation rules for credential/model verification.
 *
 * The server tells the client exactly how much is known about a provider key:
 * `live` (a real probe succeeded), `operator_asserted` (probing was disabled
 * and the operator asserted the key works) or `unchecked`. The UI must never
 * collapse the asserted/unchecked cases into a "verified" badge, so the mapping
 * lives here as a pure function that can be unit tested without a DOM.
 */

/** Fallback copy used only when the server did not send `verificationLabel`. */
export const VERIFICATION_FALLBACK_LABEL: Record<CredentialVerificationState, string> = {
  live: "已验证",
  operator_asserted: "未校验（操作者断言）",
  unchecked: "未校验",
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

export function verificationBadge(entry: VerificationInput): VerificationBadge {
  const state = modelVerificationState({
    verification: entry.verification,
    asserted: entry.asserted,
    verified: entry.verified,
  });
  const label = entry.verificationLabel?.trim() || VERIFICATION_FALLBACK_LABEL[state];
  const title =
    state === "live"
      ? "该 provider 凭据已通过实时 /models 探测"
      : state === "operator_asserted"
        ? "探针已关闭，操作者断言该 Key 可用；未经实时校验，不代表已验证"
        : "该 provider 凭据尚未通过实时校验";
  return { state, label, tone: state === "live" ? "ok" : "warn", title };
}

export interface CapabilityHint {
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
): CapabilityHint | undefined {
  const hasCapabilities = entry.capabilities != null || entry.contextWindow !== undefined || entry.maxOutputTokens !== undefined;
  if (!hasCapabilities) return undefined;
  const runtimeVerified = entry.capabilitiesVerified === true && modelVerificationState(entry) === "live";
  if (runtimeVerified) {
    return {
      label: "能力·运行时",
      runtimeVerified: true,
      title: "上下文窗口/输出上限等能力参数由 provider 运行时探测确认",
    };
  }
  return {
    label: "能力·目录",
    runtimeVerified: false,
    title: "能力参数来自静态目录默认值，未经运行时探测确认",
  };
}

/** Availability copy kept separate from the verification badge. */
export function availabilityLabel(
  entry: Pick<ModelInfo, "available" | "unavailableReason">,
): string {
  if (entry.available) return "可用";
  switch (entry.unavailableReason) {
    case "credential_missing":
      return "缺凭据";
    case "model_unverified":
      return "模型未校验";
    case "role_restricted":
      return "角色受限";
    default:
      return "待校验";
  }
}
