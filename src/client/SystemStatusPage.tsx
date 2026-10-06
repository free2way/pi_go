import {
  Activity,
  AlertTriangle,
  Database,
  DollarSign,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { localizeError } from "../shared/i18n";
import { api, type SystemStatusResponse } from "./api";
import { useT } from "./i18n";
import {
  activeRunsSummary,
  databaseLabel,
  failureCategoryLabel,
  failureCategoryRows,
  formatAge,
  formatCompactNumber,
  formatCost,
  formatVersion,
  jobStateRows,
  storageLabel,
  workerLabel,
} from "./system-status-view";
import { DEFAULT_LOCALE, intlLocale, t, type Locale } from "../shared/i18n";

const REFRESH_MS = 15_000;

const formatTimestamp = (value: string | null | undefined, locale: Locale = DEFAULT_LOCALE) => {
  if (!value) return t(locale, "system.unknown");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return t(locale, "system.unknown");
  return new Intl.DateTimeFormat(intlLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
};

/** SYS-01: read-only system status dashboard with 15s auto-refresh. */
export function SystemStatusPage() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<SystemStatusResponse>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await api.systemStatus());
      setError("");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("system.loadFailed")));
    } finally {
      setRefreshing(false);
    }
  }, [locale, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [paused, load]);

  const deployments = status?.deployments ?? null;
  const database = status?.infrastructure.database;
  const worker = status?.infrastructure.worker;
  const queue = status?.queue;
  const runs = status?.runs;
  const usage = status?.usage;
  const failures = status?.failures;

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">SYSTEM STATUS</span>
          <h1>{t("nav.system")}</h1>
          <p>{t("system.subtitle")}</p>
        </div>
        <div className="sys-controls">
          <span className="sys-updated">{t("system.updatedAt", { time: status ? formatTimestamp(status.at, locale) : t("system.unknown") })}</span>
          <button type="button" className="button secondary" onClick={() => setPaused((value) => !value)}>
            {paused ? <Play size={13} /> : <Pause size={13} />}{t(paused ? "system.resumeAuto" : "system.pauseAuto")}
          </button>
          <button type="button" className="button primary" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{t("system.refresh")}
          </button>
        </div>
      </section>

      {error && <div className="form-error">{t("system.errorPrefix", { message: error })}</div>}
      {!status && !error && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("system.loading")}</span></div>}

      {status && (
        <div className="sys-grid">
          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">RELEASE</span><h3>{t("system.release.title")}</h3></div><Rocket size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span>{t("system.release.web")}</span><strong>{formatVersion(status.versions.web)}</strong></div>
              <div className="sys-row"><span>{t("system.release.worker")}</span><strong>{formatVersion(status.versions.worker)}</strong></div>
              <div className="sys-row"><span>{t("system.release.rollbackTags")}</span><strong>{deployments?.rollbackTags.length ? deployments.rollbackTags.join("、") : t("system.unknown")}</strong></div>
              <div className="sys-row"><span>{t("system.release.deployLog")}</span><strong>{!deployments ? t("system.unknown") : deployments.log.available ? t("system.recordsCount", { count: deployments.records.length }) : t("system.unavailable")}</strong></div>
              {deployments?.records.length ? (
                <ul className="sys-list">
                  {deployments.records.slice(0, 3).map((record, index) => (
                    <li key={`${record.raw}-${index}`}>
                      <code>{record.version ?? "—"}</code>
                      <span>{record.role ?? record.status ?? t("system.record")}</span>
                      <small>{record.at ? formatTimestamp(record.at, locale) : ""}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">INFRASTRUCTURE</span><h3>{t("system.infra.title")}</h3></div><Server size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span><Database size={12} />{t("system.infra.database")}</span><strong className={database?.status === "ok" ? "is-ok" : "is-warn"}>{databaseLabel(database, locale)}</strong></div>
              <div className="sys-row"><span><Server size={12} />Worker</span><strong className={worker?.status === "ok" ? "is-ok" : "is-warn"}>{workerLabel(worker, locale)}</strong></div>
              <div className="sys-row"><span>{t("system.infra.activeJobs")}</span><strong>{worker?.status === "ok" && typeof worker.activeJobs === "number" ? worker.activeJobs : t("system.unknown")}</strong></div>
              <div className="sys-row"><span>{t("system.infra.storage")}</span><strong>{worker?.status === "ok" ? storageLabel(worker.storage, locale) : t("system.unknown")}</strong></div>
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">QUEUE &amp; RUNS</span><h3>{t("system.queue.title")}</h3></div><ListChecks size={15} /></div>
            <div className="sys-body">
              {queue?.status === "ok" ? (
                <div className="sys-chips">
                  {jobStateRows(queue.byState, locale).map((row) => (
                    <span key={row.key} className="sys-chip"><em>{row.label}</em><strong>{row.count}</strong></span>
                  ))}
                </div>
              ) : <div className="sys-row"><span>{t("system.queue.jobs")}</span><strong className="is-warn">{t("system.unavailable")}</strong></div>}
              <div className="sys-row"><span>{t("system.queue.oldest")}</span><strong>{queue?.status === "ok" ? formatAge(queue.oldestQueuedAgeMs, locale) : t("system.unknown")}</strong></div>
              <div className="sys-row"><span>{t("system.queue.total")}</span><strong>{runs?.status === "ok" ? runs.total : t("system.unavailable")}</strong></div>
              <div className="sys-row"><span>{t("system.queue.active")}</span><strong>{runs?.status === "ok" ? activeRunsSummary(runs.active, locale) : t("system.unknown")}</strong></div>
              {runs?.status === "ok"
                ? <div className="sys-hint">{t("system.queue.outcomes", { completed: runs.byState.completed, needsHuman: runs.byState.needs_human, failed: runs.byState.failed, cancelled: runs.byState.cancelled })}</div>
                : <div className="sys-hint">{t("system.queue.outcomesUnavailable")}</div>}
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">USAGE</span><h3>{t("system.usage.title")}</h3></div><DollarSign size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span>{t("system.usage.date")}</span><strong>{usage?.date ?? t("system.unknown")}</strong></div>
              <div className="sys-row"><span>{t("system.usage.modelCalls")}</span><strong>{usage?.status === "ok" ? (usage.modelCalls === null ? t("system.unknown") : t("system.usage.calls", { count: usage.modelCalls })) : t("system.unavailable")}</strong></div>
              <div className="sys-row"><span>{t("system.usage.tokens")}</span><strong>{usage?.status === "ok" ? `${formatCompactNumber(usage.inputTokens, locale)} / ${formatCompactNumber(usage.outputTokens, locale)}` : t("system.unavailable")}</strong></div>
              <div className="sys-row"><span>{t("system.usage.totalTokens")}</span><strong>{usage?.status === "ok" ? formatCompactNumber(usage.totalTokens, locale) : t("system.unavailable")}</strong></div>
              <div className="sys-row"><span>{t("system.usage.cost")}</span><strong>{usage?.status === "ok" ? formatCost(usage.estimatedCost, locale) : t("system.unavailable")}</strong></div>
              <div className="sys-hint">{t("system.usage.hint", { count: usage?.scannedRuns ?? 0, truncated: usage?.truncated ? t("system.usage.truncated") : "" })}</div>
            </div>
          </section>

          <section className="panel sys-card sys-card-wide">
            <div className="panel-head"><div><span className="eyebrow">FAILURES · LAST {failures?.windowHours ?? 24}H</span><h3>{t("system.failures.title")}</h3></div><AlertTriangle size={15} /></div>
            <div className="sys-body">
              {failures?.status === "ok" ? (
                <>
                  <div className="sys-chips">
                    {failureCategoryRows(failures.byCategory, locale).map((row) => (
                      <span key={row.key} className={`sys-chip ${row.count > 0 ? "is-warn" : ""}`}><em>{row.label}</em><strong>{row.count}</strong></span>
                    ))}
                  </div>
                  {failures.recent.length ? (
                    <ul className="sys-list">
                      {failures.recent.map((event, index) => (
                        <li key={`${event.at}-${event.type}-${index}`}>
                          <small>{formatTimestamp(event.at, locale)}</small>
                          <code>{failureCategoryLabel(event.category, locale)}</code>
                          <span>{event.summary}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="sys-hint">{t("system.failures.empty")}</div>}
                  {failures.truncated ? <div className="sys-hint">{t("system.failures.truncated")}</div> : null}
                </>
              ) : <div className="sys-row"><span>{t("system.failures.stat")}</span><strong className="is-warn">{t("system.unavailable")}</strong></div>}
            </div>
          </section>
        </div>
      )}

      <div className="sys-footnote"><Activity size={12} />{t("system.footnote")}</div>
    </div>
  );
}
