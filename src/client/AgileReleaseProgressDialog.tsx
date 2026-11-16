import { ArrowUpRight, Check, CircleDot, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { type AgileRelease } from "../shared/agile";
import { agileReleaseProgressView, type AgileReleaseProgressState } from "./agile-view";
import { browserDeploymentUrl } from "./release-progress";
import { ReleaseEvidence } from "./ReleaseEvidence";
import { formatDuration, formatTime } from "./agile-format";

export function AgileReleaseProgressDialog({ open, release, error, onClose }: {
  open: boolean;
  release?: AgileRelease;
  error: string;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const [, setClock] = useState(0);
  const deploy = release?.deploy;
  const view = agileReleaseProgressView(deploy);
  const startedAt = deploy?.startedAt ?? deploy?.at;
  const elapsedMs = startedAt
    ? Math.max(0, (deploy?.finishedAt ? Date.parse(deploy.finishedAt) : Date.now()) - Date.parse(startedAt))
    : 0;
  const deploymentUrl = browserDeploymentUrl(deploy?.url);

  useEffect(() => {
    if (!open || view.status !== "running") return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [open, view.status]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open || !release) return null;
  const stepIcon = (state: AgileReleaseProgressState) => state === "done"
    ? <Check size={12} />
    : state === "failed"
      ? <X size={12} />
      : state === "active"
        ? <LoaderCircle className="spin" size={12} />
        : <CircleDot size={11} />;
  const stepLabel = (state: AgileReleaseProgressState) => t(state === "active"
    ? "release.progress.running"
    : state === "done"
      ? "release.progress.done"
      : state === "failed"
        ? "release.progress.failed"
        : "release.progress.waiting");

  return (
    <aside className="release-progress-window" role="dialog" aria-modal="false" aria-labelledby="agile-release-progress-title">
      <div className="release-progress-head">
        <div>
          <span className="eyebrow">AGILE RELEASE</span>
          <h3 id="agile-release-progress-title">{t("agile.publish.title", { version: release.version, name: release.name })}</h3>
        </div>
        <div className="release-progress-head-actions">
          <span className={`release-progress-status is-${view.status}`}>{view.status === "running" && <i />}{t(`release.progress.status.${view.status}`)}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("release.progress.close")} title={t("release.progress.close")}><X size={16} /></button>
        </div>
      </div>
      <div className="release-progress-summary">
        <div><span>{t("agile.releaseManage.version")}</span><strong>{release.version}</strong></div>
        <div><span>{t("release.environment")}</span><strong>{deploy?.environment ?? "—"}</strong></div>
        <div><span>attempt</span><strong>{deploy?.attempt ?? "—"}</strong></div>
        <div><span>{t("release.progress.elapsed")}</span><strong>{startedAt ? formatDuration(elapsedMs / 1_000, locale) : "—"}</strong></div>
      </div>
      <div className="release-progress-body">
        <ol className="release-progress-timeline">
          <li className={`is-${view.request}`}><span>{stepIcon(view.request)}</span><div><strong>{t("release.progress.request")}</strong><small>{deploy?.deliveryId ?? t("release.progress.requesting")}</small></div></li>
          <li className={`is-${view.registration}`}><span>{stepIcon(view.registration)}</span><div><strong>{t("agile.publish.progress.registration")}</strong><small>{view.registration === "active" ? t("agile.publish.progress.registrationHelp") : stepLabel(view.registration)}</small></div></li>
          <li className={`is-${view.result}`}><span>{stepIcon(view.result)}</span><div><strong>{t("release.progress.result")}</strong><small>{deploy?.detail ?? t(view.status === "running" ? "release.progress.awaitingResult" : "release.progress.waiting")}</small></div></li>
        </ol>
        {deploy && (
          <div className="release-progress-log">
            <div><span>{t("release.progress.events")}</span><small>{t(deploy.status === "pending" ? "release.progress.awaitingResult" : `release.progress.status.${view.status}`)}</small></div>
            <p><time>{formatTime(deploy.at, locale)}</time><span>{deploy.detail}</span></p>
          </div>
        )}
        {deploy?.status === "ok" && <ReleaseEvidence value={deploy} />}
      </div>
      {error ? <div className="form-error release-progress-error">{error}</div> : null}
      <div className="release-progress-actions">
        <button type="button" className="button secondary" onClick={onClose}>{t("release.progress.close")}</button>
        {deploymentUrl && <a className="button secondary" href={deploymentUrl} target="_blank" rel="noreferrer">{t("release.viewDeploy")}<ArrowUpRight size={13} /></a>}
      </div>
      <p className="release-progress-footnote">{t("release.progress.closeHint")}</p>
    </aside>
  );
}
