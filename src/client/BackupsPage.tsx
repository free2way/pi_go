import { History, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BackupEntry, BackupOverview } from "../shared/backups";
import { intlLocale, type MessageKey } from "../shared/i18n";
import { api } from "./api";
import { useT } from "./i18n";

export function BackupPanel({ overview, busy, onAction }: {
  overview: BackupOverview; busy: boolean; onAction: (action: "delete" | "restore", entry: BackupEntry) => void;
}) {
  const { t, locale } = useT();
  return <>
    {!overview.backups.length && <p>{t("backups.empty")}</p>}
    <div className="backup-list">{overview.backups.map(entry => <article className="backup-entry" key={entry.id}>
      <div><strong>{new Date(entry.createdAt).toLocaleString(intlLocale(locale))}</strong>
        <small>{entry.id}</small><span>{t(`backups.state.${entry.state}`)}</span>
        <small>{(entry.bytes / 1024 / 1024).toFixed(2)} MiB · {entry.files} files</small>
        {entry.protected && <strong className="backup-protected"><ShieldCheck size={14} />{t("backups.latest")}</strong>}
      </div>
      {entry.state === "deleted" ? <button className="button secondary" disabled={busy} onClick={() => onAction("restore", entry)}><Undo2 size={14} />{t("backups.undo")}</button>
        : <button className="button secondary" disabled={busy || entry.protected || entry.state === "creating"} onClick={() => onAction("delete", entry)}><Trash2 size={14} />{t("common.delete")}</button>}
    </article>)}</div>
    <h2>{t("backups.audit")}</h2>
    <ul className="backup-audit">{overview.audit.map((event, index) => <li key={`${event.at}-${index}`}>
      <time>{new Date(event.at).toLocaleString(intlLocale(locale))}</time>{" · "}
      {t(`backups.audit.${event.action}` as MessageKey)}{" · "}<code>{event.backupId}</code>{" · "}<span>{event.actorId}</span>
    </li>)}</ul>
  </>;
}

export function BackupsPage({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useT();
  const [overview, setOverview] = useState<BackupOverview>();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const showError = useCallback((cause: unknown) => {
    const code = (cause as { code?: string })?.code;
    const keys = ["BACKUP_BUSY", "BACKUP_LATEST_PROTECTED", "BACKUP_INTEGRITY_FAILED", "BACKUP_SPACE_LOW", "BACKUP_RATE_LIMITED"];
    setError(t(keys.includes(code || "") ? `backups.error.${code}` as MessageKey : "backups.error"));
  }, [t]);
  const load = useCallback(async () => {
    try { setOverview(await api.backups()); setError(""); } catch (cause) { showError(cause); }
  }, [showError]);
  useEffect(() => {
    if (!isAdmin) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [isAdmin, load]);
  const create = async () => {
    if (!window.confirm(t("backups.createConfirm"))) return;
    setPending(true); setError("");
    try { await api.createBackup(); await load(); } catch (cause) { showError(cause); }
    finally { setPending(false); }
  };
  const action = async (kind: "delete" | "restore", entry: BackupEntry) => {
    if (!window.confirm(t(kind === "delete" ? "backups.deleteConfirm" : "backups.restoreConfirm", { id: entry.id }))) return;
    setPending(true); setError("");
    try { await (kind === "delete" ? api.deleteBackup(entry.id) : api.restoreBackup(entry.id)); await load(); }
    catch (cause) { showError(cause); } finally { setPending(false); }
  };
  return <section className="backups-page">
    <header className="backup-heading"><div><span className="eyebrow">BACKUPS</span><h1>{t("nav.backups")}</h1><p>{t("backups.subtitle")}</p></div>
      {isAdmin && <div className="backup-actions"><button className="button secondary" onClick={() => void load()}><RefreshCw size={14} />{t("backups.refresh")}</button>
        <button className="button primary" disabled={!overview || pending || overview.busy} onClick={() => void create()}><History size={14} />{t("backups.create")}</button></div>}
    </header>
    {!isAdmin ? <p>{t("backups.adminOnly")}</p> : <>
      <p className="backup-warning">{t("backups.warning")}</p><p>{t("backups.policy")}</p>
      {error && <p role="alert">{error}</p>}
      {(pending || overview?.busy) && <p role="status"><LoaderCircle size={14} className="spin" />{t("backups.busy")}</p>}
      {!overview && !error && <p>{t("backups.loading")}</p>}
      {overview && <BackupPanel overview={overview} busy={pending || overview.busy} onAction={(kind, entry) => void action(kind, entry)} />}
    </>}
  </section>;
}
