import { Activity, AlertTriangle, Bot, Braces, ChevronRight, ClipboardList, Clock3, Code2, Cpu, Download, FileCode2, FolderGit2, GitBranch, History, KeyRound, ListChecks, LoaderCircle, LogOut, Menu, PanelRightClose, Play, Plus, RotateCcw, Scale, Search, ShieldCheck, Sparkles, Square, Trash2, Users, Webhook, X, Zap } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { localizeError } from "../shared/i18n";
import { useT } from "./i18n";
import { chatMessagesFromEvents, reworkBranchDetails, type ChatTab } from "../shared/chat";
import type { DecisionBrief } from "../shared/decision-brief";
import type { ConfigStatus, CurrentUser, RoundSummary, Run, RunArtifact, RunEvent } from "../shared/types";
import { api } from "./api";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { decisionBriefExpanded, decisionBriefVisible } from "./decision-brief-view";
import { runStateKey } from "./requirement-history";
import { batchCleanupConfirmMessage, cleanupFinishedConfirmMessage, cleanupStorageDetailLines, summarizeCleanupStorage } from "./run-cleanup-view";
import { MAX_BUFFERED_EVENTS, mergeRunEvents, shouldAcceptRun } from "./run-events";
import { createRunSelectionGuard, eventsForRun, isRunSelected, pickSelectedRun } from "./run-selection";
import { reworkBranchDetailsFromSummaries } from "./rounds-view";
import { PiAssistant } from "./PiAssistant";

import { AccountsPage, AgilePage, BackupsPage, DecisionsPanel, HistoryPage, ModelsPage, ReleaseSettingsPage, SystemStatusPage, WorkspacesPage } from "./routes";
import { ChatLog, ReworkDetail } from "./workflow/ChatLog";
import { CreateRunDialog } from "./workflow/CreateRunDialog";
import { ReleasePanel } from "./workflow/ReleasePanel";
import { DecisionBriefCard, HumanInterventionPanel } from "./workflow/RunDecisionPanels";
import { AcceptancePanel, ActivityPanel, BudgetPanel, ChecksPanel, DeferredNonBlockingNotice, DiffPanel, ReviewPanel, SubAgentsPanel, type RunDetailTab } from "./workflow/RunDetailPanels";
import { WorkflowTopology } from "./workflow/WorkflowTopology";
import { Logo, ProviderStatus, StatusPill, compactNumber, formatDuration, terminalStates } from "./workflow/display";

/**
 * 侧栏「最近任务」只列最近的 N 个（需求）：完整列表在「需求历史」页
 * （可搜索 / 筛状态 / 分页）。新建的运行一定是最新的，因此始终可见。
 */
const RECENT_RUNS_LIMIT = 5;

export function App({ onSignOut }: { onSignOut?: () => void } = {}) {
  const { t, locale, setLocale, locales, localeLabels } = useT();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  // 拓扑轮次模型: server-aggregated round summaries; `undefined` means the
  // endpoint was unavailable (older server / failed request) → event fallback.
  const [roundSummaries, setRoundSummaries] = useState<RoundSummary[] | undefined>(undefined);
  // 决策摘要: server-built Decision Brief; `undefined` means unavailable/loading.
  const [decisionBrief, setDecisionBrief] = useState<DecisionBrief>();
  const [briefCollapsed, setBriefCollapsed] = useState(false);
  const [highlightFinding, setHighlightFinding] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [config, setConfig] = useState<ConfigStatus>();
  const [user, setUser] = useState<CurrentUser>();
  const [tab, setTab] = useState<RunDetailTab>("activity");
  const [chatTab, setChatTab] = useState<ChatTab>("all");
  // Item-1: which rework branch's detail panel is open; Item-2: the chat round filter.
  const [reworkRound, setReworkRound] = useState<number | null>(null);
  const [chatRoundFilter, setChatRoundFilter] = useState<number | null>(null);
  const [view, setView] = useState<"run" | "agile" | "workspaces" | "models" | "history" | "system" | "release-settings" | "accounts" | "backups">("run");
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // B3: run ids selected for a batch operation.
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // B6: explicit on-disk intent for batch cleanup; checked by default (matches
  // the server's long-standing behavior of deleting the run directory).
  const [batchDeleteRunDirectory, setBatchDeleteRunDirectory] = useState(true);

  const refreshRuns = useCallback(async () => {
    const next = await api.runs();
    setRuns(next);
    setSelectedId((current) => current || next[0]?.id);
  }, []);

  /** AUD-17: accept a run snapshot only when it is not older than what is shown. */
  const applyRun = useCallback((next: Run) => {
    setRun((current) => (shouldAcceptRun(current, next) ? next : current));
    setRuns((current) => current.map((item) => (item.id === next.id && shouldAcceptRun(item, next) ? next : item)));
  }, []);

  // Every run-scoped panel (header, meta, checks, diff, budget, topology, chat)
  // reads `activeRun`, never `run` directly. While the snapshot for a newly
  // selected run is in flight, `run` still holds the previous run, so rendering
  // it is exactly what made the big title stick on the old task. Falling back to
  // the (complete) list entry makes the selection visible immediately and makes a
  // stale snapshot structurally unable to render.
  const activeRun = useMemo(
    () => (isRunSelected(run, selectedId) ? run : pickSelectedRun(runs, selectedId)),
    [run, selectedId, runs],
  );

  useEffect(() => {
    // 失败也要收敛：无 catch 的 Promise.all 在 500 时会抛出未处理拒绝
    // （e2e 曾捕获到 pageerror "Internal Server Error"），这里降级为保持外壳可用。
    void Promise.all([api.config().then(setConfig), api.me().then(setUser), refreshRuns()])
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [refreshRuns]);

  useEffect(() => {
    if (!selectedId) { setRun(undefined); setEvents([]); setArtifacts([]); setRoundSummaries(undefined); setDecisionBrief(undefined); setReworkRound(null); setChatRoundFilter(null); return; }
    // Reset for the newly selected run before any snapshot/stream data merges in,
    // so seq numbers from different runs are never mixed.
    setEvents([]);
    setArtifacts([]);
    setRoundSummaries(undefined);
    setDecisionBrief(undefined);
    setBriefCollapsed(false);
    setHighlightFinding(null);
    setReworkRound(null);
    setChatRoundFilter(null);
    // Stale-response guard: every in-flight request/stream for the previously
    // selected run is invalidated here, so a late api.run/SSE event cannot
    // overwrite the newly selected run.
    const guard = createRunSelectionGuard(selectedId);
    // The run snapshot is fetched on its own: the header/meta/topology must never
    // depend on the events/artifacts request succeeding (a single rejected member
    // of Promise.all silently dropped the whole snapshot and left the previous
    // run's title on screen forever).
    void api.run(selectedId).then((nextRun) => {
      if (!guard.acceptRun(nextRun)) return;
      applyRun(nextRun);
    }).catch(() => undefined);
    void Promise.all([api.events(selectedId), api.artifacts(selectedId)]).then(([nextEvents, nextArtifacts]) => {
      if (!guard.isActive()) return;
      // Merge (not replace): the SSE stream may already have delivered newer events.
      // Keep only events of this run so a draining previous stream cannot collide.
      setEvents((current) => mergeRunEvents(eventsForRun(current, guard.runId), nextEvents.filter((event) => guard.acceptEvent(event)), MAX_BUFFERED_EVENTS));
      setArtifacts(nextArtifacts.artifacts);
    }).catch(() => undefined);
    // 拓扑轮次模型: fetched on its own so a failure (or an older server without
    // the route) leaves `undefined` and the topology uses the event-derived model
    // instead of dropping the whole run detail.
    void api.runRounds(selectedId).then((response) => {
      if (!guard.isActive()) return;
      setRoundSummaries(Array.isArray(response?.rounds) ? response.rounds : undefined);
    }).catch(() => undefined);
    const stream = new EventSource(`/api/runs/${selectedId}/stream`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      if (!guard.acceptEvent(event)) return;
      // Dedupe by monotonic seq and cap the buffer so long runs stay bounded.
      setEvents((current) => mergeRunEvents(eventsForRun(current, guard.runId), [event], MAX_BUFFERED_EVENTS));
      void api.run(selectedId).then((nextRun) => {
        if (!guard.acceptRun(nextRun)) return;
        applyRun(nextRun);
      }).catch(() => undefined);
    };
    return () => { guard.invalidate(); stream.close(); };
  }, [selectedId, applyRun]);

  // GAP-04: the artifact list becomes meaningful at terminal state.
  useEffect(() => {
    if (!selectedId || !activeRun || !terminalStates.includes(activeRun.state)) return;
    let active = true;
    void api.artifacts(selectedId).then((response) => {
      if (active) setArtifacts(response.artifacts);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedId, activeRun?.state]);

  // 决策摘要: fetched once per selection / state change. A failure (or an older
  // server without the route) simply leaves the card hidden — no polling, and
  // no dependency on the other requests succeeding. The request carries the UI
  // locale so the server records it and echoes it from the stop event
  // (docs/24-i18n.md §9); the card itself renders from the already-fetched
  // payload, so switching language does not need a refetch.
  useEffect(() => {
    if (!selectedId || !activeRun || !decisionBriefVisible(activeRun.state)) {
      setDecisionBrief(undefined);
      return;
    }
    let active = true;
    void api.decisionBrief(selectedId, locale).then((next) => {
      if (active) setDecisionBrief(next);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedId, activeRun?.state, locale]);

  const handleReworkSelect = useCallback((round: number) => {
    setReworkRound((current) => (current === round ? null : round));
  }, []);
  // Item-1: one detail entry per rendered branch. The event-derived details are
  // the fallback; when the server round summaries are available they supply the
  // authoritative branch list and the return reason for rounds whose original
  // event fell outside the buffered window.
  const eventReworkDetails = useMemo(() => reworkBranchDetails(events, activeRun?.findings ?? []), [events, activeRun?.findings]);
  const reworkDetails = useMemo(
    () => (roundSummaries
      ? reworkBranchDetailsFromSummaries(roundSummaries, activeRun?.findings ?? [], eventReworkDetails, locale)
      : eventReworkDetails),
    [roundSummaries, activeRun?.findings, eventReworkDetails, locale],
  );
  const reworkRounds = useMemo(() => new Set(reworkDetails.map((detail) => detail.round)), [reworkDetails]);
  const selectedRework = reworkRound === null ? undefined : reworkDetails.find((detail) => detail.round === reworkRound);
  const chatMessages = useMemo(() => chatMessagesFromEvents(events), [events]);
  const running = runs.filter((item) => !terminalStates.includes(item.state)).length;

  const jumpToTopology = useCallback((round: number) => {
    setReworkRound(round);
    setChatRoundFilter(null);
    document.getElementById("workflow-topology")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const jumpToChat = useCallback((round: number) => {
    setChatRoundFilter(round);
    setReworkRound(null);
    document.getElementById("chat-log")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const openBriefTarget = useCallback((nextTab: RunDetailTab, key?: string) => {
    setTab(nextTab);
    setHighlightFinding(key ?? null);
  }, []);

  const handleCreated = (created: Run) => {
    setRuns((current) => [created, ...current]);
    setSelectedId(created.id);
    setRun(created);
    setEvents([]);
    setArtifacts([]);
    setRoundSummaries(undefined);
    setDecisionBrief(undefined);
    setHighlightFinding(null);
    setReworkRound(null);
    setChatRoundFilter(null);
    setView("run");
  };

  const handleCleanup = async () => {
    // B6: state exactly what is removed. The server deletes the run directory by
    // default, so the old "worktree 保留" wording was wrong.
    if (!window.confirm(cleanupFinishedConfirmMessage({ olderThanDays: 7, deleteRunDirectory: true }, locale))) return;
    try {
      const result = await api.cleanupRuns({ olderThanDays: 7, deleteRunDirectory: true });
      await refreshRuns();
      window.alert(t("alert.cleaned", { count: result.deleted ?? 0 }));
    } catch (cause) {
      window.alert(t("alert.cleanupFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    }
  };

  const handleDelete = async (target: Run) => {
    if (!terminalStates.includes(target.state)) {
      window.alert(t("alert.runningDelete"));
      return;
    }
    if (!window.confirm(t("alert.deleteConfirm", { title: target.title }))) return;
    try {
      await api.deleteRun(target.id);
      const next = await api.runs();
      setRuns(next);
      if (selectedId === target.id) setSelectedId(next[0]?.id);
    } catch (cause) {
      window.alert(t("alert.deleteFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    }
  };

  /** B1: reopen a completed run (owner-confirmed; the server allows admins freely). */
  const handleReopen = async (target: Run) => {
    if (!window.confirm(t("alert.reopenConfirm", { title: target.title }))) return;
    try {
      applyRun(await api.reopenRun(target.id, { confirm: true }));
    } catch (cause) {
      window.alert(t("alert.reopenFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    }
  };

  const toggleBatch = (id: string) => {
    setBatchSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** B3: run a batch action over the selected runs; partial failures are listed. */
  const handleBatch = async (action: "accept" | "continue" | "cleanup") => {
    const selected = runs.filter((item) => batchSelected.has(item.id));
    const ids = selected.map((item) => item.id);
    if (ids.length === 0) return;
    if (action === "cleanup") {
      if (!window.confirm(batchCleanupConfirmMessage({ count: ids.length, deleteRunDirectory: batchDeleteRunDirectory }, locale))) return;
    } else if (action === "accept") {
      const openCount = selected.reduce((total, item) => total + item.findings.filter((finding) => !finding.resolved).length, 0);
      if (!window.confirm(t("alert.batchAcceptConfirm", { count: ids.length, openFindings: openCount > 0 ? t("alert.batchAcceptOpenFindings", { count: openCount }) : "" }))) return;
    } else if (!window.confirm(t("alert.batchContinueConfirm", { count: ids.length }))) return;
    setBatchBusy(true);
    try {
      const summary = await api.batchRuns({ action, runIds: ids, acknowledgeOpenFindings: true, deleteRunDirectory: action === "cleanup" ? batchDeleteRunDirectory : undefined });
      await refreshRuns();
      const failed = summary.results.filter((result) => !result.ok);
      const label = t(action === "accept" ? "decision.accept" : action === "continue" ? "decision.continue" : "batch.cleanup");
      // B6: the cleanup summary reports each run's on-disk outcome.
      const storage = action === "cleanup"
        ? `\n${summarizeCleanupStorage(summary.results, locale)}${summary.results.length ? `\n${cleanupStorageDetailLines(summary.results, 10, locale).join("\n")}` : ""}`
        : "";
      const failures = failed.length
        ? `\n${failed.slice(0, 5).map((result) => `${result.runId.slice(0, 12)}：${localizeError(locale, { code: result.code, message: result.error }, t("common.failed"))}`).join("\n")}`
        : "";
      window.alert(t("alert.batchDone", { label, succeeded: summary.succeeded, failed: summary.failed, storage, failures }));
      setBatchSelected(new Set());
    } catch (cause) {
      window.alert(t("alert.batchFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top"><Logo /><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        {/* UI: compact top block (create + nav + routing) scrolls on its own so the
            runs list below can claim the remaining sidebar height. */}
        <div className="sidebar-nav-scroll">
        <button className="new-run" onClick={() => setCreateOpen(true)}><Plus size={17} />{t("nav.newRun")}<span>⌘ K</span></button>
        <nav className="primary-nav">
          <button type="button" className={view === "run" ? "active" : ""} onClick={() => setView("run")}><GitBranch size={16} />{t("nav.workflow")}</button>
          <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16} />{t("nav.history")}</button>
          <button type="button" className={view === "agile" ? "active" : ""} onClick={() => setView("agile")}><ClipboardList size={16} />{t("nav.agile")}</button>
          <button type="button" className={view === "workspaces" ? "active" : ""} onClick={() => setView("workspaces")}><FolderGit2 size={16} />{t("nav.workspaces")}</button>
          <button type="button" className={view === "models" ? "active" : ""} onClick={() => setView("models")}><Cpu size={16} />{t("nav.models")}</button>
          {/* SYS-01: this used to be a dead `#system` anchor into the sidebar deployment card; it now opens the system status dashboard. */}
          <button type="button" className={view === "system" ? "active" : ""} onClick={() => setView("system")}><Activity size={16} />{t("nav.system")}</button>
          {user?.isAdmin && <button type="button" className={view === "release-settings" ? "active" : ""} onClick={() => setView("release-settings")}><Webhook size={16} />{t("nav.releaseSettings")}</button>}
          {/* 账户管理: admin-only; non-admins never see the entry (direct navigation shows the explicit 仅管理员可见 state). */}
          {user?.isAdmin && <button type="button" className={view === "accounts" ? "active" : ""} onClick={() => setView("accounts")}><Users size={16} />{t("nav.accounts")}</button>}
          {user?.isAdmin && <button type="button" className={view === "backups" ? "active" : ""} onClick={() => setView("backups")}><History size={16} />{t("nav.backups")}</button>}
          </nav>
          {config && <div className="providers-card" id="models">
            <div className="providers-title"><span>AGENT ROUTING</span><Zap size={13} /></div>
            <ProviderStatus label={t("role.developer")} provider={config.developer.provider} model={config.developer.model} ready={config.developer.credentialConfigured} icon={Code2} />
            <ProviderStatus label={t("role.reviewer")} provider={config.reviewer.provider} model={config.reviewer.model} ready={config.reviewer.credentialConfigured} icon={ShieldCheck} />
            <button className="manage-credentials" type="button" onClick={() => setView("models")}><KeyRound size={13} />{t("nav.configureKeys")}</button>
            <div className={`credential-warning ${config.realRunsAvailable ? "runner-ready" : ""}`}><AlertTriangle size={13} />{t(config.realRunsAvailable ? "config.realReady" : "config.realNotReady")}</div>
          </div>}
        </div>
        {/* 最近任务: bottom region, grows to fill the remaining sidebar height. The
            section head stays pinned; only .run-list scrolls. */}
        <section className="sidebar-runs" aria-label={t("nav.recentRuns")}>
        <div className="sidebar-section-head"><span>{t("nav.recentRuns")}</span><span className="sidebar-head-actions"><Search size={14} /><button className="sidebar-cleanup" type="button" title={t("nav.cleanupTitle")} onClick={() => void handleCleanup()}><Trash2 size={13} /></button></span></div>
        {batchSelected.size > 0 && (
          <div className="batch-bar">
            <span>{t("batch.selected", { count: batchSelected.size })}</span>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => void handleBatch("accept")}>{t("decision.accept")}</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => void handleBatch("continue")}>{t("decision.continue")}</button>
            <label className="batch-cleanup-option" title={t("batch.deleteRunDirectoryTitle")}>
              <input type="checkbox" checked={batchDeleteRunDirectory} disabled={batchBusy} onChange={(event) => setBatchDeleteRunDirectory(event.target.checked)} />
              {t("batch.deleteRunDirectory")}
            </label>
            <button type="button" className="button danger-text" disabled={batchBusy} onClick={() => void handleBatch("cleanup")}>{t("batch.cleanup")}</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => setBatchSelected(new Set())}>{t("common.cancel")}</button>
          </div>
        )}
        <div className="run-list">
          {runs.slice(0, RECENT_RUNS_LIMIT).map((item) => (
            <div className={`run-item ${selectedId === item.id ? "selected" : ""}`} key={item.id}>
              <label className="run-select" title={t("batch.selectTitle")}>
                <input type="checkbox" checked={batchSelected.has(item.id)} onChange={() => toggleBatch(item.id)} />
              </label>
              <button className="run-item-main" onClick={() => { setSelectedId(item.id); setSidebarOpen(false); setView("run"); }}>
                <span className={`run-state-dot status-${item.state}`} />
                <span><strong>{item.title}</strong><small>{item.repository} · R{item.round}</small></span>
                <ChevronRight size={14} className="run-item-chevron" />
              </button>
              <button className="run-item-delete" title={t("batch.deleteRunTitle")} onClick={() => void handleDelete(item)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!runs.length && !loading && <div className="sidebar-empty">{t("nav.empty")}</div>}
        </div>
        </section>
        <div className="account-footer"><div><span className="system-dot" /><strong>{user?.email || t("account.verifying")}</strong><small>Pi {config?.piVersion || "—"}</small></div>{onSignOut ? <button type="button" onClick={onSignOut} title={t("account.logout")} aria-label={t("account.logout")}><LogOut size={15} /></button> : <a href="/cdn-cgi/access/logout" title={t("account.logout")}><LogOut size={15} /></a>}</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb">
            {view === "backups" ? <><span>BACKUPS</span><ChevronRight size={13} /><strong>{t("nav.backups")}</strong></> : view === "workspaces"
              ? <><span>WORKSPACES</span><ChevronRight size={13} /><strong>{t("nav.workspaces")}</strong></>
              : view === "models"
                ? <><span>MODELS</span><ChevronRight size={13} /><strong>{t("nav.models")}</strong></>
                : view === "system"
                  ? <><span>SYSTEM</span><ChevronRight size={13} /><strong>{t("nav.system")}</strong></>
                  : view === "release-settings"
                    ? <><span>RELEASE</span><ChevronRight size={13} /><strong>{t("nav.releaseSettings")}</strong></>
                  : view === "history"
                    ? <><span>HISTORY</span><ChevronRight size={13} /><strong>{t("nav.history")}</strong></>
                    : view === "agile"
                      ? <><span>AGILE</span><ChevronRight size={13} /><strong>{t("nav.agile")}</strong></>
                      : view === "accounts"
                        ? <><span>ACCOUNTS</span><ChevronRight size={13} /><strong>{t("nav.accounts")}</strong></>
                        : <><span>WORKFLOWS</span><ChevronRight size={13} /><strong>{activeRun?.id.slice(0, 12) || "OVERVIEW"}</strong></>}
          </div>
          <div className="topbar-actions">
            {view === "run" && (activeRun?.mode === "demo" ? <span className="demo-chip"><Sparkles size={13} />{t("run.demoChip")}</span> : activeRun && <span className="demo-chip real-chip"><Code2 size={13} />{t("run.realChip")}</span>)}
            {view === "run" && activeRun && !terminalStates.includes(activeRun.state) && <button className="button danger-small" onClick={() => void api.cancelRun(activeRun.id)}><Square size={12} />{t("run.stop")}</button>}
            <select
              className="locale-select"
              aria-label={t("locale.label")}
              title={t("locale.label")}
              value={locale}
              onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh")}
            >
              {locales.map((item) => <option key={item} value={item}>{localeLabels[item]}</option>)}
            </select>
            <button className="icon-button"><PanelRightClose size={17} /></button>
          </div>
        </header>

        <Suspense fallback={<section className="run-loading"><LoaderCircle className="spin" size={22} /><span>{t("run.loading")}</span></section>}>
          {view === "system" ? (
            <SystemStatusPage isAdmin={Boolean(user?.isAdmin)} />
          ) : view === "release-settings" ? (
            <ReleaseSettingsPage onChanged={() => { void api.config().then(setConfig); }} />
          ) : view === "models" ? (
            <ModelsPage config={config} onChanged={() => { void api.config().then(setConfig); }} />
          ) : view === "workspaces" ? (
            <WorkspacesPage config={config} runs={runs} isAdmin={Boolean(user?.isAdmin)} onOpenCredentials={() => setView("models")} />
          ) : view === "history" ? (
            <HistoryPage runs={runs} onOpenRun={(id) => { setSelectedId(id); setView("run"); setSidebarOpen(false); }} />
          ) : view === "agile" ? (
            <AgilePage config={config} onOpenRun={(id) => { setSelectedId(id); setView("run"); setSidebarOpen(false); }} />
          ) : view === "backups" ? (
            <BackupsPage isAdmin={Boolean(user?.isAdmin)} />
          ) : view === "accounts" ? (
            <AccountsPage user={user} />
          ) : !activeRun ? (
          selectedId ? (
            <section className="run-loading">
              <LoaderCircle className="spin" size={22} />
              <span>{t("run.loading")}</span>
            </section>
          ) : (
            <section className="welcome-state">
              <div className="welcome-orbit"><div><Bot size={32} /></div><i /><i /><i /></div>
              <span className="eyebrow">MULTI-MODEL ENGINEERING</span>
              <h1>{t("welcome.titleLine1")}<br />{t("welcome.titleLine2")}</h1>
              <p>{t("welcome.subtitle")}</p>
              <button className="button primary large" onClick={() => setCreateOpen(true)}><Play size={17} />{t("welcome.cta")}</button>
            </section>
          )
        ) : (
          <div className="dashboard" id="workflow">
            <section className="run-heading">
              <div>
                <div className="heading-meta"><StatusPill state={activeRun.state} /><span>{activeRun.repository}</span><span><GitBranch size={12} />{activeRun.branch}</span></div>
                <h1>{activeRun.title}</h1>
                <p>{activeRun.summary}</p>
              </div>
              <div className="run-round">
                <span>REVIEW ROUND</span><strong>{activeRun.round}<em>/ {activeRun.maxRounds}</em></strong>
                {activeRun.state === "completed" && !activeRun.merge && !activeRun.release && (
                  <button type="button" className="button secondary reopen-button" onClick={() => void handleReopen(activeRun)}>
                    <RotateCcw size={14} />{t("run.reopen")}
                  </button>
                )}
              </div>
            </section>

            <DeferredNonBlockingNotice events={events} />

            {decisionBrief && decisionBriefVisible(activeRun.state) ? (
              <DecisionBriefCard
                brief={decisionBrief}
                run={activeRun}
                open={decisionBriefExpanded(activeRun.state, briefCollapsed, terminalStates)}
                onToggle={() => setBriefCollapsed((collapsed) => !collapsed)}
                onOpenFinding={(key) => openBriefTarget("review", key)}
                onOpenTab={(target) => openBriefTarget(target)}
              />
            ) : null}

            {activeRun.state === "needs_human" && (
              <HumanInterventionPanel
                run={activeRun}
                events={events}
                user={user}
                onUpdated={(next) => {
                  setRun(next);
                  setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
                }}
              />
            )}

            <AcceptancePanel run={activeRun} />
            <ReleasePanel
              key={activeRun.id}
              run={activeRun}
              events={events}
              user={user}
              configured={config?.releaseConfigured}
              onUpdated={(next) => {
                setRun(next);
                setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
              }}
            />

            <section className="metrics-grid">
              <div className="metric"><span><Activity size={14} />{t("metrics.state")}</span><strong>{t(runStateKey(activeRun.state))}</strong><small>{t("metrics.running", { count: running })}</small></div>
              <div className="metric"><span><Clock3 size={14} />{t("metrics.duration")}</span><strong>{formatDuration(activeRun.durationMs)}</strong><small>{t("metrics.durationHint")}</small></div>
              <div className="metric"><span><Braces size={14} />Tokens</span><strong>{compactNumber(activeRun.usage.inputTokens + activeRun.usage.outputTokens)}</strong><small>{t("metrics.tokensHint", { input: compactNumber(activeRun.usage.inputTokens), output: compactNumber(activeRun.usage.outputTokens) })}</small></div>
              <div className="metric"><span><Zap size={14} />{t("metrics.cost")}</span><strong>${activeRun.usage.estimatedCost.toFixed(3)}</strong><small>{t(activeRun.mode === "demo" ? "metrics.costDemo" : "metrics.costCurrent")}</small></div>
            </section>

            <div className="content-grid">
              <WorkflowTopology
                run={activeRun}
                events={events}
                selectedReworkRound={reworkRound}
                onReworkSelect={handleReworkSelect}
                roundSummaries={roundSummaries}
              >
                {selectedRework && <ReworkDetail detail={selectedRework} onJumpToChat={jumpToChat} onClose={() => setReworkRound(null)} />}
              </WorkflowTopology>
              <section className="panel detail-panel">
                <div className="detail-tabs">
                  {([
                    ["activity", t("topology.tabs.activity"), Activity],
                    ["agents", `Agents ${activeRun.plan?.tasks.length || ""}`, Bot],
                    ["review", `${t("topology.tabs.review")} ${activeRun.findings.length || ""}`, ShieldCheck],
                    ["diff", "Diff", FileCode2],
                    ["artifacts", t("artifacts.title"), Download],
                    ["checks", t("topology.tabs.checks"), ListChecks],
                    ["budget", t("topology.tabs.budget"), Braces],
                    ["decisions", t("topology.tabs.decisions"), Scale],
                  ] as const).map(([key, label, Icon]) => (
                    <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key)}><Icon size={14} />{label}</button>
                  ))}
                </div>
                <div className="detail-body">
                  {tab === "activity" && <ActivityPanel events={events} />}
                  {tab === "agents" && <SubAgentsPanel run={activeRun} />}
                  {tab === "review" && <ReviewPanel findings={activeRun.findings} highlightKey={highlightFinding} />}
                  {tab === "diff" && <DiffPanel run={activeRun} artifacts={artifacts} mergeRequestConfigured={config?.mergeRequestConfigured} />}
                  {tab === "artifacts" && <ArtifactsPanel key={activeRun.id} runId={activeRun.id} />}
                  {tab === "checks" && <ChecksPanel run={activeRun} />}
                  {tab === "budget" && <BudgetPanel run={activeRun} />}
                  {tab === "decisions" && <DecisionsPanel run={activeRun} config={config} />}
                </div>
              </section>
            </div>

            <ChatLog
              messages={chatMessages}
              run={activeRun}
              activeTab={chatTab}
              onTabChange={setChatTab}
              roundFilter={chatRoundFilter}
              onClearRoundFilter={() => setChatRoundFilter(null)}
              reworkRounds={reworkRounds}
              onJumpToRound={jumpToTopology}
            />
          </div>
          )}
        </Suspense>
      </main>
      <PiAssistant page={view} run={view === "run" ? activeRun : undefined} />
      <CreateRunDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} config={config} recentRuns={runs} onGoWorkspaces={() => { setCreateOpen(false); setView("workspaces"); }} />
    </div>
  );
}
