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
import { api, type SystemStatusResponse } from "./api";
import {
  SYSTEM_UNAVAILABLE,
  SYSTEM_UNKNOWN,
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

const REFRESH_MS = 15_000;

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) return SYSTEM_UNKNOWN;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return SYSTEM_UNKNOWN;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
};

/** SYS-01: read-only system status dashboard with 15s auto-refresh. */
export function SystemStatusPage() {
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
      setError((cause as Error).message || "加载系统状态失败。");
    } finally {
      setRefreshing(false);
    }
  }, []);

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
          <h1>系统状态</h1>
          <p>只读的系统运行概览：版本与部署、数据库与 Worker 健康、队列与任务、当日用量成本，以及最近 24 小时的异常。任何无法读取的值都会明确标注为「未知 / 不可用」，不展示任何密钥或服务器路径。</p>
        </div>
        <div className="sys-controls">
          <span className="sys-updated">更新于 {status ? formatTimestamp(status.at) : SYSTEM_UNKNOWN}</span>
          <button type="button" className="button secondary" onClick={() => setPaused((value) => !value)}>
            {paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "继续自动刷新" : "暂停自动刷新"}
          </button>
          <button type="button" className="button primary" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}手动刷新
          </button>
        </div>
      </section>

      {error && <div className="form-error">系统状态不可用：{error}</div>}
      {!status && !error && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>正在加载系统状态…</span></div>}

      {status && (
        <div className="sys-grid">
          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">RELEASE</span><h3>版本与部署</h3></div><Rocket size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span>Web 版本</span><strong>{formatVersion(status.versions.web)}</strong></div>
              <div className="sys-row"><span>Worker 版本</span><strong>{formatVersion(status.versions.worker)}</strong></div>
              <div className="sys-row"><span>回滚标签</span><strong>{deployments?.rollbackTags.length ? deployments.rollbackTags.join("、") : SYSTEM_UNKNOWN}</strong></div>
              <div className="sys-row"><span>部署日志</span><strong>{!deployments ? SYSTEM_UNKNOWN : deployments.log.available ? `${deployments.records.length} 条` : SYSTEM_UNAVAILABLE}</strong></div>
              {deployments?.records.length ? (
                <ul className="sys-list">
                  {deployments.records.slice(0, 3).map((record, index) => (
                    <li key={`${record.raw}-${index}`}>
                      <code>{record.version ?? "—"}</code>
                      <span>{record.role ?? record.status ?? "记录"}</span>
                      <small>{record.at ? formatTimestamp(record.at) : ""}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">INFRASTRUCTURE</span><h3>基础设施</h3></div><Server size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span><Database size={12} />数据库</span><strong className={database?.status === "ok" ? "is-ok" : "is-warn"}>{databaseLabel(database)}</strong></div>
              <div className="sys-row"><span><Server size={12} />Worker</span><strong className={worker?.status === "ok" ? "is-ok" : "is-warn"}>{workerLabel(worker)}</strong></div>
              <div className="sys-row"><span>Worker 活跃任务</span><strong>{worker?.status === "ok" && typeof worker.activeJobs === "number" ? worker.activeJobs : SYSTEM_UNKNOWN}</strong></div>
              <div className="sys-row"><span>磁盘空间</span><strong>{worker?.status === "ok" ? storageLabel(worker.storage) : SYSTEM_UNKNOWN}</strong></div>
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">QUEUE &amp; RUNS</span><h3>队列与任务</h3></div><ListChecks size={15} /></div>
            <div className="sys-body">
              {queue?.status === "ok" ? (
                <div className="sys-chips">
                  {jobStateRows(queue.byState).map((row) => (
                    <span key={row.key} className="sys-chip"><em>{row.label}</em><strong>{row.count}</strong></span>
                  ))}
                </div>
              ) : <div className="sys-row"><span>作业队列</span><strong className="is-warn">{SYSTEM_UNAVAILABLE}</strong></div>}
              <div className="sys-row"><span>最老排队时长</span><strong>{queue?.status === "ok" ? formatAge(queue.oldestQueuedAgeMs) : SYSTEM_UNKNOWN}</strong></div>
              <div className="sys-row"><span>任务总数</span><strong>{runs?.status === "ok" ? runs.total : SYSTEM_UNAVAILABLE}</strong></div>
              <div className="sys-row"><span>活跃任务</span><strong>{runs?.status === "ok" ? activeRunsSummary(runs.active) : SYSTEM_UNKNOWN}</strong></div>
              {runs?.status === "ok"
                ? <div className="sys-hint">运行结果：已通过 {runs.byState.completed} · 需要人工 {runs.byState.needs_human} · 失败 {runs.byState.failed} · 取消 {runs.byState.cancelled}</div>
                : <div className="sys-hint">运行状态统计不可用。</div>}
            </div>
          </section>

          <section className="panel sys-card">
            <div className="panel-head"><div><span className="eyebrow">USAGE</span><h3>用量与成本</h3></div><DollarSign size={15} /></div>
            <div className="sys-body">
              <div className="sys-row"><span>统计日期（UTC）</span><strong>{usage?.date ?? SYSTEM_UNKNOWN}</strong></div>
              <div className="sys-row"><span>模型调用</span><strong>{usage?.status === "ok" ? (usage.modelCalls === null ? SYSTEM_UNKNOWN : `${usage.modelCalls} 次`) : SYSTEM_UNAVAILABLE}</strong></div>
              <div className="sys-row"><span>Token（输入 / 输出）</span><strong>{usage?.status === "ok" ? `${formatCompactNumber(usage.inputTokens)} / ${formatCompactNumber(usage.outputTokens)}` : SYSTEM_UNAVAILABLE}</strong></div>
              <div className="sys-row"><span>Token 合计</span><strong>{usage?.status === "ok" ? formatCompactNumber(usage.totalTokens) : SYSTEM_UNAVAILABLE}</strong></div>
              <div className="sys-row"><span>估算成本</span><strong>{usage?.status === "ok" ? formatCost(usage.estimatedCost) : SYSTEM_UNAVAILABLE}</strong></div>
              <div className="sys-hint">按当日有更新的任务累计（{usage?.scannedRuns ?? 0} 个）估算{usage?.truncated ? "，已达扫描上限" : ""}。</div>
            </div>
          </section>

          <section className="panel sys-card sys-card-wide">
            <div className="panel-head"><div><span className="eyebrow">FAILURES · LAST {failures?.windowHours ?? 24}H</span><h3>最近 24 小时异常</h3></div><AlertTriangle size={15} /></div>
            <div className="sys-body">
              {failures?.status === "ok" ? (
                <>
                  <div className="sys-chips">
                    {failureCategoryRows(failures.byCategory).map((row) => (
                      <span key={row.key} className={`sys-chip ${row.count > 0 ? "is-warn" : ""}`}><em>{row.label}</em><strong>{row.count}</strong></span>
                    ))}
                  </div>
                  {failures.recent.length ? (
                    <ul className="sys-list">
                      {failures.recent.map((event, index) => (
                        <li key={`${event.at}-${event.type}-${index}`}>
                          <small>{formatTimestamp(event.at)}</small>
                          <code>{failureCategoryLabel(event.category)}</code>
                          <span>{event.summary}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="sys-hint">最近 24 小时没有异常事件。</div>}
                  {failures.truncated ? <div className="sys-hint">已达扫描上限，计数为下界。</div> : null}
                </>
              ) : <div className="sys-row"><span>异常统计</span><strong className="is-warn">{SYSTEM_UNAVAILABLE}</strong></div>}
            </div>
          </section>
        </div>
      )}

      <div className="sys-footnote"><Activity size={12} />系统状态每 15 秒自动刷新；暂停后仍可手动刷新。所有数值均为只读聚合，不包含密钥、环境变量或服务器路径。</div>
    </div>
  );
}
