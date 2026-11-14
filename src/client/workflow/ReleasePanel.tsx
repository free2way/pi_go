import { Activity, ArrowUpRight, Check, CircleDot, GitBranch, LoaderCircle, RotateCcw, Rocket, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { localizeError } from "../../shared/i18n";
import { useT } from "../i18n";
import type { CurrentUser, Run, RunEvent } from "../../shared/types";
import { api } from "../api";
import { browserDeploymentUrl, RELEASE_PROGRESS_STAGES, releaseProgressEventStage, releaseProgressStepState, type ReleaseProgressStage } from "../release-progress";
import { ReleaseEvidence } from "../ReleaseEvidence";

import { formatClock, formatDuration } from "./display";

function ReleaseProgressDialog({
  open,
  run,
  events,
  targetEnvironment,
  started,
  busy,
  error,
  requestStartedAt,
  onStart,
  onClose,
}: {
  open: boolean;
  run: Run;
  events: RunEvent[];
  targetEnvironment: "staging" | "production";
  started: boolean;
  busy: boolean;
  error: string;
  requestStartedAt?: number;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const [, setClock] = useState(0);
  const release = run.release;
  const status = !started
    ? "ready"
    : busy || release?.status === "publishing" || release?.status === "triggered"
      ? "running"
      : release?.status === "succeeded"
        ? "succeeded"
        : "failed";
  const releaseEvents = useMemo(() => events.filter((event) => {
    if (!event.type.startsWith("run.release_")) return false;
    if (!release) return false;
    const deliveryId = typeof event.meta?.deliveryId === "string" ? event.meta.deliveryId : undefined;
    const attempt = typeof event.meta?.attempt === "number" ? event.meta.attempt : undefined;
    return (!deliveryId || deliveryId === release.deliveryId) && (!attempt || attempt === release.attempt);
  }).slice(-12), [events, release]);
  const observedStages = releaseEvents.map(releaseProgressEventStage).filter((stage): stage is ReleaseProgressStage => Boolean(stage));
  const latestStageIndex = observedStages.length ? RELEASE_PROGRESS_STAGES.indexOf(observedStages.at(-1)!) : -1;
  const elapsedFrom = release?.startedAt ? Date.parse(release.startedAt) : requestStartedAt;
  const elapsedMs = started && elapsedFrom && Number.isFinite(elapsedFrom)
    ? Math.max(0, (release?.finishedAt ? Date.parse(release.finishedAt) : Date.now()) - elapsedFrom)
    : 0;

  useEffect(() => {
    if (!open || status !== "running") return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [open, status]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;
  const deploymentUrl = browserDeploymentUrl(release?.url);
  const progressState = (index: number) => !started ? "waiting" : releaseProgressStepState({
    index,
    latestStageIndex,
    releaseStatus: release?.status,
    running: status === "running",
  });
  const statusLabel = t(`release.progress.status.${status}`);

  return (
    <aside className="release-progress-window" role="dialog" aria-modal="false" aria-labelledby="release-progress-title">
      <div className="release-progress-head">
        <div>
          <span className="eyebrow">LIVE RELEASE</span>
          <h3 id="release-progress-title">{t("release.progress.title")}</h3>
        </div>
        <div className="release-progress-head-actions">
          <span className={`release-progress-status is-${status}`}>{status === "running" && <i />}{statusLabel}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("release.progress.close")} title={t("release.progress.close")}><X size={16} /></button>
        </div>
      </div>

      <div className="release-progress-summary">
        <div><span>{t("release.environment")}</span><strong>{targetEnvironment}</strong></div>
        <div><span>commit</span><strong>{run.merge?.commit.slice(0, 12) ?? "—"}</strong></div>
        <div><span>attempt</span><strong>{started ? release?.attempt ?? "…" : (release?.attempt ?? 0) + 1}</strong></div>
        <div><span>{t("release.progress.elapsed")}</span><strong>{started ? formatDuration(elapsedMs) : "—"}</strong></div>
      </div>

      {!started ? (
        <div className="release-progress-confirm">
          <Rocket size={20} />
          <div><strong>{t("release.progress.readyTitle")}</strong><p>{t("release.progress.readyHelp")}</p></div>
        </div>
      ) : (
        <div className="release-progress-body">
          <ol className="release-progress-timeline">
            <li className={release ? "is-done" : "is-active"}><span>{release ? <Check size={12} /> : <LoaderCircle className="spin" size={12} />}</span><div><strong>{t("release.progress.request")}</strong><small>{release?.deliveryId ?? t("release.progress.requesting")}</small></div></li>
            {RELEASE_PROGRESS_STAGES.map((stage, index) => {
              const state = progressState(index);
              return (
                <li className={`is-${state}`} key={stage}>
                  <span>{state === "done" ? <Check size={12} /> : state === "failed" ? <X size={12} /> : state === "active" ? <LoaderCircle className="spin" size={12} /> : <CircleDot size={11} />}</span>
                  <div><strong>{t(`release.progress.stage.${stage}`)}</strong><small>{state === "active" ? t("release.progress.running") : state === "done" ? t("release.progress.done") : state === "failed" ? t("release.progress.failed") : t("release.progress.waiting")}</small></div>
                </li>
              );
            })}
            <li className={`is-${status === "succeeded" ? "done" : status === "failed" ? "failed" : "waiting"}`}>
              <span>{status === "succeeded" ? <Check size={12} /> : status === "failed" ? <X size={12} /> : <CircleDot size={11} />}</span>
              <div><strong>{t("release.progress.result")}</strong><small>{release?.detail ?? t(status === "running" ? "release.progress.awaitingResult" : "release.progress.waiting")}</small></div>
            </li>
          </ol>
          {releaseEvents.length > 0 && (
            <div className="release-progress-log">
              <div><span>{t("release.progress.events")}</span><small>{t("release.progress.liveHint")}</small></div>
              {releaseEvents.map((event) => (
                <p key={event.seq}><time>{formatClock(event.at, locale)}</time><span>{releaseProgressEventStage(event) ? t(`release.progress.stage.${releaseProgressEventStage(event)}`) : event.message}</span></p>
              ))}
            </div>
          )}
          {release?.status === "succeeded" && <ReleaseEvidence value={release} />}
        </div>
      )}
      {error ? <div className="form-error release-progress-error">{error}</div> : null}
      <div className="release-progress-actions">
        <button type="button" className="button secondary" onClick={onClose}>{t("release.progress.close")}</button>
        {!started && <button type="button" className="button primary" onClick={onStart}><Rocket size={14} />{t("release.progress.start")}</button>}
        {started && deploymentUrl && <a className="button secondary" href={deploymentUrl} target="_blank" rel="noreferrer">{t("release.viewDeploy")}<ArrowUpRight size={13} /></a>}
      </div>
      {started && <p className="release-progress-footnote">{t("release.progress.closeHint")}</p>}
    </aside>
  );
}

/** Explicit administrator gate between reviewed code, local merge and release. */
export function ReleasePanel({ run, events, user, configured, onUpdated }: {
  run: Run;
  events: RunEvent[];
  user?: CurrentUser;
  configured?: boolean;
  onUpdated: (run: Run) => void;
}) {
  const { t, locale } = useT();
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [busy, setBusy] = useState<"" | "merge" | "publish" | "rollback">("");
  const [error, setError] = useState("");
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("");
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressStarted, setProgressStarted] = useState(false);
  const [progressEnvironment, setProgressEnvironment] = useState<"staging" | "production">("staging");
  const [requestStartedAt, setRequestStartedAt] = useState<number>();
  const [, setReleaseClock] = useState(0);
  useEffect(() => {
    if (run.release?.status !== "publishing" && run.release?.status !== "triggered") return;
    const remaining = 2 * 60_000 - (Date.now() - Date.parse(run.release.startedAt));
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setReleaseClock((value) => value + 1), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [run.release?.status, run.release?.startedAt]);
  if (run.state !== "completed" || run.mode !== "real") return null;

  const release = run.release;
  const deploymentUrl = browserDeploymentUrl(release?.url);
  const canPromote = release?.status === "succeeded" && release.environment === "staging";
  const stalePublishing = (release?.status === "publishing" || release?.status === "triggered")
    && Date.now() - Date.parse(release.startedAt) >= 2 * 60_000;
  const canRetry = release?.status === "failed" || stalePublishing;
  const inProgress = (release?.status === "publishing" || release?.status === "triggered") && !stalePublishing;
  const rollback = run.rollback;
  const staleRollback = (rollback?.status === "publishing" || rollback?.status === "triggered")
    && Date.now() - Date.parse(rollback.startedAt) >= 2 * 60_000;
  const rollbackInProgress = (rollback?.status === "publishing" || rollback?.status === "triggered") && !staleRollback;
  const rollbackRetry = rollback?.status === "failed" || staleRollback;
  const merge = async () => {
    if (!window.confirm(t("release.mergeConfirm", { title: run.title }))) return;
    setBusy("merge");
    setError("");
    try {
      onUpdated(await api.mergeRun(run.id, { confirm: true }));
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusy("");
    }
  };
  const openPublish = () => {
    const target: "staging" | "production" = canPromote || release?.environment === "production"
      ? "production"
      : release ? "staging" : environment;
    setProgressEnvironment(target);
    setProgressStarted(false);
    setRequestStartedAt(undefined);
    setError("");
    setProgressOpen(true);
  };
  const openExistingProgress = () => {
    setProgressEnvironment(release?.environment === "production" ? "production" : "staging");
    setProgressStarted(Boolean(release));
    setRequestStartedAt(release?.startedAt ? Date.parse(release.startedAt) : undefined);
    setError("");
    setProgressOpen(true);
  };
  const publish = async () => {
    const target = progressEnvironment;
    setProgressStarted(true);
    setRequestStartedAt(Date.now());
    setBusy("publish");
    setError("");
    try {
      onUpdated(await api.publishRun(run.id, { environment: target, confirm: true, ...(canRetry ? { retry: true } : {}) }));
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusy("");
    }
  };
  const submitRollback = async () => {
    const reason = rollbackReason.trim();
    if (reason.length < 3) {
      setError(t("release.rollback.reasonRequired"));
      return;
    }
    setBusy("rollback");
    setError("");
    try {
      onUpdated(await api.rollbackRun(run.id, { confirm: true, reason, ...(rollbackRetry ? { retry: true } : {}) }));
      setRollbackOpen(false);
      setRollbackReason("");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusy("");
    }
  };

  const statusLabel = !release
    ? run.merge ? t("release.statusMergedAwaiting") : t("release.statusAwaitingMerge")
    : release.status === "succeeded"
      ? t("release.statusSucceeded")
      : release.status === "failed"
        ? t("release.statusFailed")
        : release.status === "triggered"
          ? t("release.statusTriggered")
          : t("release.statusPublishing");

  return (
    <section className="panel release-panel">
      <div className="panel-head">
        <div><span className="eyebrow">CODE RELEASE</span><h3>{t("release.title")}</h3></div>
        <div className="release-head-actions">
          {release && <button type="button" className="release-progress-open" onClick={openExistingProgress}><Activity size={13} />{t("release.progress.open")}</button>}
          <span className={`release-status release-${release?.status ?? (run.merge ? "ready" : "waiting")}`}>{statusLabel}</span>
        </div>
      </div>
      <div className="release-grid">
        <div><span>{t("release.reviewSnapshot")}</span><strong>{run.reviewSnapshot?.slice(0, 12) ?? run.baseSha?.slice(0, 12) ?? t("common.unknown")}</strong></div>
        <div><span>{t("release.mergeResult")}</span><strong>{run.merge ? `${run.merge.commit.slice(0, 12)} → ${run.merge.targetBranch}` : t("release.notMerged")}</strong></div>
        <div><span>{t("release.environment")}</span><strong>{release?.environment ?? environment}</strong></div>
        <div><span>{t("release.deliveryId")}</span><strong>{release?.deliveryId ?? t("release.deliveryIdGenerated")}</strong></div>
      </div>
      {release?.detail ? <p className="release-detail">{release.detail}</p> : null}
      {deploymentUrl ? <a className="release-link" href={deploymentUrl} target="_blank" rel="noreferrer">{t("release.viewDeploy")} <ArrowUpRight size={13} /></a> : null}
      {release?.status === "succeeded" && !deploymentUrl ? <small className="release-config-hint">{t("release.publicUrlUnavailable")}</small> : null}
      {release?.status === "succeeded" ? <ReleaseEvidence value={release} /> : null}
      {rollback ? (
        <div className={`release-rollback-status is-${rollback.status}`}>
          <RotateCcw size={13} />
          <div><strong>{t(`release.rollback.status.${rollback.status}`)}</strong><small>{rollback.detail ?? rollback.reason}</small></div>
        </div>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}
      {user?.isAdmin ? (
        <div className="release-actions">
          {!run.merge ? (
            <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void merge()}>
              {busy === "merge" ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}{t("release.mergeAction")}
            </button>
          ) : null}
          {run.merge && (release?.status !== "succeeded" || canPromote) ? (
            <>
              {!release ? (
                <select aria-label={t("release.environment")} value={environment} onChange={(event) => setEnvironment(event.target.value === "production" ? "production" : "staging")} disabled={Boolean(busy)}>
                  <option value="staging">{t("release.environment.staging")}</option>
                  <option value="production">{t("release.environment.production")}</option>
                </select>
              ) : null}
              <button type="button" className="button primary" disabled={Boolean(busy) || inProgress || configured === false} onClick={openPublish}>
                {busy === "publish" || inProgress ? <LoaderCircle className="spin" size={14} /> : <Rocket size={14} />}{t(canPromote ? "release.promoteProduction" : canRetry ? "release.retry" : inProgress ? "release.inProgress" : "release.confirm")}
              </button>
            </>
          ) : null}
          {release?.status === "succeeded" && release.environment === "production" && !rollbackOpen ? (
            <button type="button" className="button secondary" disabled={Boolean(busy) || rollbackInProgress || configured === false} onClick={() => { setError(""); setRollbackOpen(true); }}>
              {busy === "rollback" || rollbackInProgress ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
              {t(rollbackRetry ? "release.rollback.retry" : rollbackInProgress ? "release.rollback.inProgress" : "release.rollback.open")}
            </button>
          ) : null}
          {rollbackOpen ? (
            <div className="release-rollback-form">
              <label htmlFor={`rollback-reason-${run.id}`}>{t("release.rollback.reason")}</label>
              <textarea id={`rollback-reason-${run.id}`} value={rollbackReason} maxLength={2_000} autoFocus placeholder={t("release.rollback.reasonPlaceholder")} onChange={(event) => setRollbackReason(event.target.value)} disabled={Boolean(busy)} />
              <small>{t("release.rollback.help", { commit: release?.commit.slice(0, 12) ?? "—" })}</small>
              <div>
                <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { setRollbackOpen(false); setRollbackReason(""); }}>{t("common.cancel")}</button>
                <button type="button" className="button primary" disabled={Boolean(busy) || rollbackReason.trim().length < 3} onClick={() => void submitRollback()}>
                  {busy === "rollback" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{t("release.rollback.confirm")}
                </button>
              </div>
            </div>
          ) : null}
          {configured === false ? <small className="release-config-hint">{t("release.notConfigured")}</small> : null}
        </div>
      ) : <small className="release-config-hint">{t("release.adminOnly")}</small>}
      <ReleaseProgressDialog
        open={progressOpen}
        run={run}
        events={events}
        targetEnvironment={progressEnvironment}
        started={progressStarted}
        busy={busy === "publish"}
        error={error}
        requestStartedAt={requestStartedAt}
        onStart={() => void publish()}
        onClose={() => setProgressOpen(false)}
      />
    </section>
  );
}
