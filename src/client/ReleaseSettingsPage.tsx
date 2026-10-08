import { CheckCircle2, LoaderCircle, Rocket, Save, ShieldCheck, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeError } from "../shared/i18n";
import type { ReleaseWebhookSettingsStatus } from "../shared/types";
import { api } from "./api";
import { useT } from "./i18n";

export function ReleaseSettingsPage({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<ReleaseWebhookSettingsStatus>();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [publicOrigin, setPublicOrigin] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "save" | "delete">("load");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.releaseSettings().then((next) => {
      if (!active) return;
      setStatus(next);
      setWebhookUrl(next.webhookUrl ?? "");
      setPublicOrigin(next.publicOrigin ?? window.location.origin);
      setBusy("");
    }).catch((cause) => {
      if (!active) return;
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("releaseSettings.loadFailed")));
      setBusy("");
    });
    return () => { active = false; };
  }, [locale, t]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const next = await api.saveReleaseSettings({
        webhookUrl: webhookUrl.trim(),
        publicOrigin: publicOrigin.trim(),
        ...(webhookToken.trim() ? { webhookToken: webhookToken.trim() } : {}),
      });
      setStatus(next);
      setWebhookToken("");
      setMessage(t("releaseSettings.saved"));
      onChanged();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("releaseSettings.saveFailed")));
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!window.confirm(t("releaseSettings.deleteConfirm"))) return;
    setBusy("delete");
    setError("");
    setMessage("");
    try {
      const next = await api.deleteReleaseSettings();
      setStatus(next);
      setWebhookUrl(next.webhookUrl ?? "");
      setPublicOrigin(next.publicOrigin ?? window.location.origin);
      setWebhookToken("");
      setMessage(t(next.source === "environment" ? "releaseSettings.envRestored" : "releaseSettings.deleted"));
      onChanged();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("releaseSettings.deleteFailed")));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="workspaces-page release-settings-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">RELEASE PIPELINE</span>
          <h1>{t("nav.releaseSettings")}</h1>
          <p>{t("releaseSettings.subtitle")}</p>
        </div>
        <span className={`release-settings-state ${status?.configured ? "is-ready" : ""}`}>
          {status?.configured ? <CheckCircle2 size={14} /> : <Rocket size={14} />}
          {t(status?.configured ? "releaseSettings.ready" : "releaseSettings.notReady")}
        </span>
      </section>

      <section className="panel release-settings-card">
        <div className="panel-head">
          <div><span className="eyebrow">WEBHOOK</span><h3>{t("releaseSettings.formTitle")}</h3></div>
          <Webhook size={16} />
        </div>
        {busy === "load" ? <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("releaseSettings.loading")}</span></div> : (
          <form className="release-settings-form" onSubmit={(event) => void save(event)}>
            <label>
              <span>{t("releaseSettings.webhookUrl")}</span>
              <input type="url" required placeholder="https://deploy.example.com/hooks/pigo" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} disabled={Boolean(busy)} />
              <small>{t("releaseSettings.webhookHint")}</small>
            </label>
            <label>
              <span>{t("releaseSettings.token")}</span>
              <input type="password" minLength={12} placeholder={status?.tokenConfigured ? t("releaseSettings.tokenPreserve") : t("releaseSettings.tokenRequired")} value={webhookToken} onChange={(event) => setWebhookToken(event.target.value)} disabled={Boolean(busy)} />
              <small>{t("releaseSettings.tokenHint")}</small>
            </label>
            <label>
              <span>{t("releaseSettings.publicOrigin")}</span>
              <input type="url" required placeholder="https://pigo.example.com" value={publicOrigin} onChange={(event) => setPublicOrigin(event.target.value)} disabled={Boolean(busy)} />
              <small>{t("releaseSettings.originHint")}</small>
            </label>
            <div className="release-settings-security"><ShieldCheck size={15} /><span>{t("releaseSettings.security")}</span></div>
            {status ? <div className="release-settings-meta">{t("releaseSettings.source", { source: t(`releaseSettings.source.${status.source}`) })}{status.updatedAt ? ` · ${new Date(status.updatedAt).toLocaleString()}` : ""}</div> : null}
            {error ? <div className="form-error">{error}</div> : null}
            {message ? <div className="form-success">{message}</div> : null}
            <div className="release-settings-actions">
              <button type="submit" className="button primary" disabled={Boolean(busy)}>{busy === "save" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{t("common.save")}</button>
              {status?.source === "web" ? <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void remove()}>{busy === "delete" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("releaseSettings.delete")}</button> : null}
            </div>
          </form>
        )}
      </section>

      <section className="panel release-guide-card">
        <div className="panel-head">
          <div><span className="eyebrow">STAGING → PRODUCTION</span><h3>{t("releaseSettings.guideTitle")}</h3></div>
          <Rocket size={16} />
        </div>
        <div className="release-guide-grid">
          <article><em>01</em><div><strong>{t("releaseSettings.guide.configure")}</strong><p>{t("releaseSettings.guide.configureDetail")}</p></div></article>
          <article><em>02</em><div><strong>{t("releaseSettings.guide.staging")}</strong><p>{t("releaseSettings.guide.stagingDetail")}</p></div></article>
          <article><em>03</em><div><strong>{t("releaseSettings.guide.verify")}</strong><p>{t("releaseSettings.guide.verifyDetail")}</p></div></article>
          <article><em>04</em><div><strong>{t("releaseSettings.guide.production")}</strong><p>{t("releaseSettings.guide.productionDetail")}</p></div></article>
        </div>
        <div className="release-protocol">
          <h4>{t("releaseSettings.protocolTitle")}</h4>
          <p>{t("releaseSettings.protocolRequest")}</p>
          <pre>{`Authorization: Bearer <Webhook Token>\nX-PiGO-Delivery-Id: <deliveryId>\nX-PiGO-Signature: sha256=<HMAC-SHA256>`}</pre>
          <p>{t("releaseSettings.protocolPayload")}</p>
          <pre>{`{\n  "event": "run.release_requested | release.published",\n  "environment": "staging | production",\n  "deliveryId": "...",\n  "attempt": 1,\n  "callbackUrl": "https://pigo.example.com/api/internal/.../release-result"\n}`}</pre>
          <p>{t("releaseSettings.protocolResponse")}</p>
          <p>{t("releaseSettings.protocolCallback")}</p>
          <pre>{`{ "deliveryId": "...", "attempt": 1, "status": "succeeded | failed", "detail": "...", "url": "https://..." }`}</pre>
        </div>
      </section>
    </div>
  );
}
