import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConfigStatus, CredentialStatus, ModelCatalogResponse } from "../shared/types";
import { api } from "./api";
import { localizeError } from "../shared/i18n";
import { useT } from "./i18n";
import { availabilityLabel, modelCapabilityHint, verificationBadge } from "./model-verification";

const roleKey = { developer: "role.developer", reviewer: "role.reviewer" } as const;

export function ModelsPage({ config, onChanged }: { config?: ConfigStatus; onChanged: () => void }) {
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

  const providers = [...new Set((catalog?.models ?? []).map((entry) => entry.provider))];
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
          const credential = credentialFor(provider);
          const entries = (catalog?.models ?? []).filter((entry) => entry.provider === provider);
          const providerBadge = credential ? verificationBadge(credential, locale) : undefined;
          return (
            <article className="panel model-card" key={provider}>
              <div className="panel-head">
                <div><span className="eyebrow">{provider.toUpperCase()}</span><h3>{provider}</h3></div>
                <div className="model-head-tags">
                  {providerBadge && <span className={`model-verify ${providerBadge.tone}`} title={providerBadge.title}>{providerBadge.label}</span>}
                  <span className={`model-credential ${credential ? "is-set" : ""}`}>{credential ? `${credential.masked}` : t("models.keyMissing")}</span>
                </div>
              </div>
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
              <div className="model-credential-form">
                <input
                  type="password"
                  autoComplete="new-password"
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
