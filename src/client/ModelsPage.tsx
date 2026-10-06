import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConfigStatus, CredentialStatus, ModelCatalogResponse } from "../shared/types";
import { api, type DecisionEngineStatus } from "./api";
import { DEFAULT_LOCALE, localizeError, t, type Locale } from "../shared/i18n";
import { useT } from "./i18n";
import { availabilityLabel, modelCapabilityHint, verificationBadge } from "./model-verification";

const roleKey = { developer: "role.developer", reviewer: "role.reviewer" } as const;

/** Provider id whose key feeds the decision plane (docs/26 §11). */
export const DECISION_PROVIDER_ID = "typesafe";

/**
 * `/api/config/status` is the shared `ConfigStatus` plus the decision-plane
 * preflight (`src/server/decision-routes.ts`). The extra field is optional so a
 * deployment built before the decision plane still renders every card.
 */
export type ModelsPageConfig = ConfigStatus & { decisionEngine?: DecisionEngineStatus };

/** What a card's header shows: the plain id plus a friendly label when we have one. */
export interface ProviderIdentity {
  /** Always the API value, so operators can match it against logs and env. */
  id: string;
  /** Friendly label; equals `id` for every provider that is not the decision plane. */
  label: string;
  /** True only for the decision-plane provider, which is not in the model catalog. */
  decisionPlane: boolean;
}

/**
 * A card is rendered for every provider in `catalogue ∪ stored credentials`.
 * Providers that have a credential but no catalogue models (the decision-plane
 * `typesafe` key, which never enters the developer/reviewer catalog) must stay
 * visible — otherwise a saved key could never be rotated or deleted.
 * Ordering follows the catalogue so the existing cards stay where they were.
 */
export function providerIdsForCards(
  catalog: Pick<ModelCatalogResponse, "models"> | undefined,
  status: Pick<CredentialStatus, "providers"> | undefined,
): string[] {
  const ids = (catalog?.models ?? []).map((entry) => entry.provider);
  for (const item of status?.providers ?? []) ids.push(item.provider);
  return [...new Set(ids)];
}

/**
 * Friendly identity for the decision-plane provider; every provider that is not
 * in the catalog keeps its plain id (the label is derived, never invented).
 */
export function providerIdentity(provider: string, locale: Locale = DEFAULT_LOCALE): ProviderIdentity {
  const decisionPlane = provider === DECISION_PROVIDER_ID;
  return {
    id: provider,
    label: decisionPlane ? t(locale, "models.decisionProviderLabel") : provider,
    decisionPlane,
  };
}

export interface DecisionPlaneNotice {
  engine: DecisionEngineStatus["engine"] | "unknown";
  mode: DecisionEngineStatus["mode"] | "unknown";
  /** True only when the deployment reports `PI_DECISION_ENGINE=jev`. */
  enabled: boolean;
  /** `引擎 {engine} · 模式 {mode}` — rendered only when a status was reported. */
  state: string;
  /** Why storing a key is (not) the same as activating the decision plane. */
  hint: string;
}

/**
 * docs/26 §11: entering a key must never read as activation. The card reports
 * what the deployment says (`engine`/`mode`) and, unless the engine is `jev`,
 * states that deployment still has to enable `PI_DECISION_ENGINE=jev`. There is
 * deliberately no client-side switch — enabling stays an operator action.
 */
export function decisionPlaneNotice(
  decision: DecisionEngineStatus | undefined,
  locale: Locale = DEFAULT_LOCALE,
): DecisionPlaneNotice {
  const engine = decision?.engine ?? "unknown";
  const mode = decision?.mode ?? "unknown";
  const enabled = decision?.engine === "jev";
  return {
    engine,
    mode,
    enabled,
    state: t(locale, "models.decisionEngineState", { engine, mode }),
    hint: enabled ? t(locale, "models.decisionEngineEnabledHint") : t(locale, "models.decisionEngineDisabledHint"),
  };
}

export function ModelsPage({ config, onChanged }: { config?: ModelsPageConfig; onChanged: () => void }) {
  const { t, locale } = useT();
  const [catalog, setCatalog] = useState<ModelCatalogResponse>();
  const [status, setStatus] = useState<CredentialStatus>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busyProvider, setBusyProvider] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [models, credentials] = await Promise.all([api.models(), api.credentialStatus()]);
      setCatalog(models);
      setStatus(credentials);
      setError("");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  const providers = providerIdsForCards(catalog, status);
  const credentialFor = (provider: string) => status?.providers.find((item) => item.provider === provider);

  const saveProvider = async (provider: string) => {
    const apiKey = (keys[provider] || "").trim();
    if (apiKey.length < 12) {
      setError(t("models.keyTooShort"));
      return;
    }
    setBusyProvider(provider);
    setError("");
    try {
      await api.saveCredentials({ provider, apiKey });
      setKeys((current) => ({ ...current, [provider]: "" }));
      await load();
      onChanged();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusyProvider("");
    }
  };

  const removeProvider = async (provider: string) => {
    if (!window.confirm(t("models.deleteKeyConfirm", { provider }))) return;
    setBusyProvider(provider);
    setError("");
    try {
      await api.deleteCredentials(provider);
      await load();
      onChanged();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusyProvider("");
    }
  };

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">MODELS &amp; CREDENTIALS</span>
          <h1>{t("nav.models")}</h1>
          <p>{t("models.subtitle")}</p>
        </div>
      </section>

      <div className={`ws-strip ${config?.realRunsAvailable ? "is-ready" : ""}`}>
        {config?.realRunsAvailable ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
        <div>
          <strong>{config?.realRunsAvailable ? t("config.realReady") : t("models.realNotReady")}</strong>
          <span>{config?.realRunsAvailable ? t("models.readyHint") : t("models.notReadyHint")}</span>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("models.loading")}</span></div>}

      <div className="model-grid">
        {providers.map((provider) => {
          const identity = providerIdentity(provider, locale);
          const credential = credentialFor(provider);
          const entries = (catalog?.models ?? []).filter((entry) => entry.provider === provider);
          const providerBadge = credential ? verificationBadge(credential, locale) : undefined;
          const notice = identity.decisionPlane ? decisionPlaneNotice(config?.decisionEngine, locale) : undefined;
          return (
            <article className="panel model-card" key={provider}>
              <div className="panel-head">
                <div><span className="eyebrow">{identity.id.toUpperCase()}</span><h3>{identity.label}</h3></div>
                <div className="model-head-tags">
                  {providerBadge && <span className={`model-verify ${providerBadge.tone}`} title={providerBadge.title}>{providerBadge.label}</span>}
                  {notice && config?.decisionEngine && (
                    <span className={`model-verify ${notice.enabled ? "ok" : "warn"}`} title={notice.hint}>{notice.state}</span>
                  )}
                  <span className={`model-credential ${credential ? "is-set" : ""}`}>{credential ? credential.masked : t("models.keyMissing")}</span>
                </div>
              </div>
              {entries.length > 0 ? (
                <div className="model-list">
                  {entries.map((entry) => {
                    const badge = verificationBadge(entry, locale);
                    const capability = modelCapabilityHint(entry, locale);
                    return (
                      <div className="model-row" key={entry.id}>
                        <div className="model-name"><strong>{entry.label}</strong><code>{entry.provider}/{entry.model}</code></div>
                        <div className="model-tags">
                          {entry.roles.map((role) => <span key={role}>{t(roleKey[role])}</span>)}
                          {entry.reasoning && <span>{t("models.reasoning")}</span>}
                          {/* AUD-08: availability and credential verification are distinct signals. */}
                          <span className={entry.available ? "ok" : "warn"}>{availabilityLabel(entry, locale)}</span>
                          <span className={badge.tone} title={badge.title}>{badge.label}</span>
                          {capability && <span className={capability.runtimeVerified ? "ok" : "warn"} title={capability.title}>{capability.label}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="model-list">
                  {notice ? (
                    <>
                      {/* A stored key alone never activates anything: state what this credential is for. */}
                      <p className="credential-help" style={{ margin: 0 }}>{t("models.decisionProviderNote")}</p>
                      <p className="credential-help" style={{ margin: 0, color: notice.enabled ? undefined : "#d9a06c" }}>{notice.hint}</p>
                    </>
                  ) : (
                    <p className="credential-help" style={{ margin: 0 }}>{t("models.providerNoModels")}</p>
                  )}
                </div>
              )}
              <div className="model-credential-form">
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label={t("models.enterKeyLabel", { provider: identity.label })}
                  placeholder={t(credential ? "models.rotateKey" : "models.enterKey")}
                  value={keys[provider] || ""}
                  onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))}
                />
                <button type="button" className="button primary" disabled={busyProvider === provider || !(keys[provider] || "").trim()} onClick={() => void saveProvider(provider)}>
                  {busyProvider === provider ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{t("models.saveKey")}
                </button>
                {credential && (
                  <button type="button" className="button danger-text" disabled={busyProvider === provider} onClick={() => void removeProvider(provider)}>{t("models.deleteKey")}</button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {catalog && (
        <p className="credential-help">
          {t("models.defaults", {
            developer: `${catalog.defaultDeveloper.provider}/${catalog.defaultDeveloper.model}`,
            reviewer: `${catalog.defaultReviewer.provider}/${catalog.defaultReviewer.model}`,
          })}
        </p>
      )}
    </div>
  );
}
