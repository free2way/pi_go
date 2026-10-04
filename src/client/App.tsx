import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitPullRequestArrow,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LogOut,
  Menu,
  PanelRightClose,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigStatus, CurrentUser, Finding, Run, RunEvent, RunMode, RunState, Workspace } from "../shared/types";
import { api } from "./api";
import { WorkspacesPage } from "./WorkspacesPage";

type Tab = "activity" | "agents" | "review" | "diff" | "checks";
type FlowNodeData = {
  label: string;
  caption: string;
  kind: "task" | "developer" | "checks" | "reviewer" | "complete";
  status: "waiting" | "active" | "done" | "warning";
  meta?: string;
};

const terminalStates: RunState[] = ["completed", "needs_human", "failed", "cancelled"];

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  preparing: "准备工作区",
  developing: "开发中",
  checking: "检查中",
  reviewing: "审核中",
  completed: "已通过",
  needs_human: "需要人工处理",
  failed: "失败",
  cancelled: "已取消",
};

const stateOrder: Record<RunState, number> = {
  queued: 0,
  preparing: 0,
  developing: 1,
  checking: 2,
  reviewing: 3,
  completed: 4,
  needs_human: 4,
  failed: 4,
  cancelled: 4,
};

const iconForKind = {
  task: GitPullRequestArrow,
  developer: Code2,
  checks: ListChecks,
  reviewer: ShieldCheck,
  complete: CheckCircle2,
};

function FlowCard({ data }: NodeProps<Node<FlowNodeData>>) {
  const Icon = iconForKind[data.kind];
  return (
    <div className={`flow-card flow-${data.kind} is-${data.status}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-icon"><Icon size={17} strokeWidth={1.8} /></div>
      <div className="flow-copy">
        <div className="flow-title">{data.label}</div>
        <div className="flow-caption">{data.caption}</div>
      </div>
      {data.status === "active" && <LoaderCircle className="spin flow-state-icon" size={15} />}
      {data.status === "done" && <Check className="flow-state-icon" size={15} />}
      {data.meta && <span className="flow-meta">{data.meta}</span>}
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { flowCard: FlowCard };

function flowForRun(run?: Run): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const currentOrder = run ? stateOrder[run.state] : -1;
  const statusAt = (order: number): FlowNodeData["status"] => {
    if (!run) return "waiting";
    if (order < currentOrder) return "done";
    if (order > currentOrder) return "waiting";
    if (run.state === "needs_human" || run.state === "failed") return "warning";
    return terminalStates.includes(run.state) ? "done" : "active";
  };
  const nodes: Node<FlowNodeData>[] = [
    {
      id: "task",
      type: "flowCard",
      position: { x: 16, y: 72 },
      data: { label: "任务准备", caption: "Git worktree", kind: "task", status: statusAt(0) },
    },
    {
      id: "developer",
      type: "flowCard",
      position: { x: 245, y: 72 },
      data: {
        label: run && (run.plan?.tasks.length || 0) > 1 ? `DeepSeek ×${run.plan?.tasks.length}` : "DeepSeek 开发",
        caption: run?.plan ? `${run.plan.complexity} · ${run.plan.strategy}` : run?.developer.model || "developer agent",
        kind: "developer",
        status: statusAt(1),
        meta: run?.plan && run.plan.tasks.length > 1
          ? `${run.plan.tasks.filter((task) => task.status === "merged").length}/${run.plan.tasks.length}`
          : run ? `R${run.round}` : undefined,
      },
    },
    {
      id: "checks",
      type: "flowCard",
      position: { x: 474, y: 72 },
      data: { label: "质量检查", caption: "lint · types · tests", kind: "checks", status: statusAt(2) },
    },
    {
      id: "reviewer",
      type: "flowCard",
      position: { x: 703, y: 72 },
      data: {
        label: "OpenAI 审核",
        caption: run?.reviewer.model || "review agent",
        kind: "reviewer",
        status: statusAt(3),
      },
    },
    {
      id: "complete",
      type: "flowCard",
      position: { x: 932, y: 72 },
      data: {
        label: run?.state === "needs_human" ? "人工介入" : "交付完成",
        caption: run?.state === "completed" ? "checks + review passed" : "approval gate",
        kind: "complete",
        status: statusAt(4),
      },
    },
  ];
  const edgeDefaults = {
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    style: { strokeWidth: 1.5 },
  };
  const edges: Edge[] = [
    { id: "task-dev", source: "task", target: "developer", ...edgeDefaults },
    { id: "dev-check", source: "developer", target: "checks", ...edgeDefaults },
    { id: "check-review", source: "checks", target: "reviewer", ...edgeDefaults },
    { id: "review-done", source: "reviewer", target: "complete", ...edgeDefaults },
    {
      id: "feedback",
      source: "reviewer",
      target: "developer",
      sourceHandle: null,
      targetHandle: null,
      type: "smoothstep",
      label: "changes requested",
      animated: run?.round === 1 && run?.state === "developing" && run.findings.length > 0,
      style: { stroke: "#f3a65a", strokeWidth: 1.4 },
      labelStyle: { fill: "#dca06a", fontSize: 10, fontWeight: 600 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "#f3a65a" },
    },
  ];
  return { nodes, edges };
}

function Logo() {
  return (
    <div className="brand">
      <div className="brand-mark"><Braces size={19} /></div>
      <div><strong>PiGO</strong><span>CONTROL PLANE</span></div>
    </div>
  );
}

function StatusPill({ state }: { state: RunState }) {
  return <span className={`status-pill status-${state}`}><i />{stateLabels[state]}</span>;
}

function ProviderStatus({ label, provider, model, ready, icon: Icon }: {
  label: string;
  provider: string;
  model: string;
  ready: boolean;
  icon: typeof Bot;
}) {
  return (
    <div className="provider-row">
      <div className={`provider-icon ${provider}`}><Icon size={16} /></div>
      <div className="provider-copy"><span>{label}</span><strong>{model}</strong></div>
      <span className={`connection-dot ${ready ? "ready" : "missing"}`} title={ready ? "凭据已配置" : "凭据未配置"} />
    </div>
  );
}

function CreateRunDialog({ open, onClose, onCreated, config, onGoWorkspaces }: {
  open: boolean;
  onClose: () => void;
  onCreated: (run: Run) => void;
  config?: ConfigStatus;
  onGoWorkspaces: () => void;
}) {
  const [title, setTitle] = useState("修复并发刷新竞态");
  const [repository, setRepository] = useState("demo/auth-service");
  const [task, setTask] = useState("修复 token 并发刷新导致的重复请求问题，补充失败清理与并发回归测试，确保 lint、类型检查和单元测试全部通过。");
  const [mode, setMode] = useState<RunMode>("demo");
  const [checks, setChecks] = useState("npm test");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !config?.realRunsAvailable) return;
    void api.workspaces().then(({ workspaces: items }) => {
      const active = items.filter((item) => item.status === "active");
      setWorkspaces(active);
      const preferred = active.find((item) => !item.git?.dirty) ?? active[0];
      if (preferred) {
        setWorkspaceId(preferred.id);
        if (preferred.defaultChecks.length > 0) setChecks(preferred.defaultChecks.join("\n"));
      }
    }).catch((cause) => setError((cause as Error).message));
  }, [open, config?.realRunsAvailable]);

  if (!open) return null;
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedDirty = Boolean(selectedWorkspace?.git?.dirty);
  const selectWorkspace = (nextId: string) => {
    setWorkspaceId(nextId);
    const next = workspaces.find((item) => item.id === nextId);
    if (next) setChecks(next.defaultChecks.join("\n") || "npm test");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const run = await api.createRun({
        title,
        task,
        mode,
        ...(mode === "real"
          ? { workspaceId, checks: checks.split("\n").map((item) => item.trim()).filter(Boolean) }
          : { repository, checks: [] }),
      });
      onCreated(run);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><span className="eyebrow">NEW WORKFLOW</span><h2>创建开发任务</h2></div>
          <button className="icon-button" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mode-picker">
          <button type="button" className={mode === "demo" ? "active" : ""} onClick={() => { setMode("demo"); setRepository("demo/auth-service"); }}><Sparkles size={14} />流程演示</button>
          <button type="button" className={mode === "real" ? "active" : ""} disabled={!config?.realRunsAvailable} onClick={() => setMode("real")}><Code2 size={14} />真实开发</button>
        </div>
        <div className="demo-notice">
          {mode === "demo" ? <><Sparkles size={16} />演示事件不会调用模型或修改仓库。</> : <><ShieldCheck size={16} />真实任务将在隔离 Git worktree 中修改代码，不会自动推送或合并。</>}
        </div>
        <label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {mode === "real" ? (
          workspaces.length === 0 ? (
            <div className="workspace-empty-notice">
              <AlertTriangle size={15} />
              <div><strong>还没有注册工作区</strong><span>真实任务只能选择已注册且健康的工作区，请先在工作区页面注册或克隆一个仓库。</span></div>
              <button type="button" className="button secondary" onClick={onGoWorkspaces}>前往工作区</button>
            </div>
          ) : (
            <>
              <label>开发工作区<select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name} · {workspace.git?.branch || "—"}{workspace.git?.dirty ? " · 有未提交修改" : ""}
                  </option>
                ))}
              </select></label>
              {selectedDirty && (
                <div className="dirty-warning">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>工作区存在未提交修改</strong>
                    <span>真实任务默认拒绝在 dirty 仓库上启动。请先提交或清理，然后刷新 Git 状态。</span>
                    {selectedWorkspace?.git?.dirtyFiles?.length ? <code>{selectedWorkspace.git.dirtyFiles.slice(0, 5).join(" · ")}{selectedWorkspace.git.dirtyFiles.length > 5 ? " …" : ""}</code> : null}
                  </div>
                </div>
              )}
            </>
          )
        ) : <label>仓库<input value={repository} onChange={(event) => setRepository(event.target.value)} /></label>}
        <label>需求与验收条件<textarea rows={5} value={task} onChange={(event) => setTask(event.target.value)} /></label>
        {mode === "real" && <label>检查命令（每行一个）<textarea rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="npm test" /></label>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={submitting || (mode === "real" && (!workspaceId || selectedDirty))}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{mode === "real" ? "开始真实开发" : "运行演示"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CredentialsDialog({ open, onClose, config, onChanged }: {
  open: boolean;
  onClose: () => void;
  config?: ConfigStatus;
  onChanged: (config: ConfigStatus) => void;
}) {
  const [developerApiKey, setDeveloperApiKey] = useState("");
  const [reviewerApiKey, setReviewerApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.saveCredentials({
        developerApiKey: developerApiKey || undefined,
        reviewerApiKey: reviewerApiKey || undefined,
      });
      setDeveloperApiKey("");
      setReviewerApiKey("");
      onChanged(await api.config());
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const remove = async () => {
    if (!window.confirm("删除当前账户保存的全部模型 Key？删除后真实开发将不可用。")) return;
    setSubmitting(true);
    setError("");
    try {
      await api.deleteCredentials();
      onChanged(await api.config());
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal credential-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><span className="eyebrow">PERSONAL MODEL VAULT</span><h2>个人模型 Key</h2></div>
          <button className="icon-button" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="security-notice"><ShieldCheck size={18} /><div><strong>仅当前账户可用</strong><span>Key 经 AES-256-GCM 加密后保存，界面和 API 永不回显明文。留空可保留原 Key。</span></div></div>
        <label>DeepSeek 开发模型 Key
          <input type="password" autoComplete="new-password" value={developerApiKey} onChange={(event) => setDeveloperApiKey(event.target.value)} placeholder={config?.developer.credentialConfigured ? "已配置 · 输入新值可轮换" : "输入个人 Key"} />
        </label>
        <label>OpenAI 审核模型 Key
          <input type="password" autoComplete="new-password" value={reviewerApiKey} onChange={(event) => setReviewerApiKey(event.target.value)} placeholder={config?.reviewer.credentialConfigured ? "已配置 · 输入新值可轮换" : "输入个人 Key"} />
        </label>
        <p className="credential-help">真实任务只在对应 Agent 进程运行期间把 Key 注入内存；不会写入任务、日志、Diff 或 Git 仓库。</p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions split-actions">
          <button type="button" className="button danger-text" disabled={submitting || (!config?.developer.credentialConfigured && !config?.reviewer.credentialConfigured)} onClick={() => void remove()}>删除全部 Key</button>
          <span />
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={submitting || (!developerApiKey && !reviewerApiKey)}>{submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}安全保存</button>
        </div>
      </form>
    </div>
  );
}

function ActivityPanel({ events }: { events: RunEvent[] }) {
  if (!events.length) return <EmptyPanel icon={Activity} text="等待事件" />;
  return (
    <div className="timeline">
      {[...events].reverse().map((event) => (
        <div className={`timeline-item source-${event.source}`} key={event.seq}>
          <span className="timeline-dot" />
          <div className="timeline-content">
            <div><strong>{event.message}</strong><time>{formatClock(event.at)}</time></div>
            <span>{event.source} · {event.type}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewPanel({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <EmptyPanel icon={ShieldCheck} text="尚无审核问题" />;
  return (
    <div className="finding-list">
      {findings.map((item) => (
        <article className={`finding finding-${item.severity}`} key={item.id}>
          <div className="finding-head">
            <span>{item.severity}</span>
            {item.resolved && <em><Check size={12} />已解决</em>}
          </div>
          <h4>{item.title}</h4>
          <code>{item.file}:{item.line}</code>
          <p>{item.evidence}</p>
          <div className="required-change"><ArrowUpRight size={13} />{item.requiredChange}</div>
        </article>
      ))}
    </div>
  );
}

function SubAgentsPanel({ run }: { run: Run }) {
  if (!run.plan) return <EmptyPanel icon={Bot} text="主 Agent 尚未生成任务计划" />;
  return (
    <div className="agent-plan">
      <div className="agent-plan-summary"><span>{run.plan.complexity} · {run.plan.strategy}</span><p>{run.plan.rationale}</p></div>
      {run.plan.tasks.map((task, index) => (
        <article className={`subagent-row subagent-${task.status}`} key={task.id}>
          <span className="subagent-index">{String(index + 1).padStart(2, "0")}</span>
          <div><strong>{task.title}</strong><p>{task.summary || task.description}</p>{task.files.length > 0 && <code>{task.files.join(" · ")}</code>}</div>
          <em>{task.status}</em>
        </article>
      ))}
    </div>
  );
}

function DiffPanel({ diff }: { diff: string }) {
  if (!diff) return <EmptyPanel icon={FileCode2} text="尚无代码变更" />;
  return (
    <pre className="diff-view">{diff.split("\n").map((line, index) => (
      <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line}`}>{line}{"\n"}</span>
    ))}</pre>
  );
}

function ChecksPanel({ run }: { run: Run }) {
  return (
    <div className="check-list">
      {run.checks.map((check) => (
        <div className="check-row" key={check.id}>
          <span className={`check-icon check-${check.status}`}>
            {check.status === "passed" ? <Check size={14} /> : check.status === "running" ? <LoaderCircle className="spin" size={14} /> : <CircleDot size={14} />}
          </span>
          <div><strong>{check.name}</strong><code>{check.command}</code></div>
          <span>{check.durationMs ? `${(check.durationMs / 1000).toFixed(1)}s` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="empty-panel"><Icon size={22} /><span>{text}</span></div>;
}

function HumanInterventionPanel({ run, onUpdated }: { run: Run; onUpdated: (run: Run) => void }) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"" | "resume" | "review" | "terminate">("");
  const [error, setError] = useState("");
  const unresolved = run.findings.filter((item) => !item.resolved).length;

  const act = async (kind: "resume" | "review" | "terminate") => {
    setError("");
    if (kind === "terminate" && !window.confirm(`终止任务「${run.title}」？\n\n任务会标记为已取消；代码与 worktree 全部保留，不会自动合并。`)) return;
    setBusy(kind);
    try {
      if (kind === "resume") {
        onUpdated(await api.resumeRun(run.id, { instruction: instruction.trim() || undefined }));
      } else if (kind === "review") {
        onUpdated(await api.retryReviewRun(run.id));
      } else {
        onUpdated(await api.cancelRun(run.id));
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="human-panel">
      <div className="human-panel-head">
        <div><span className="eyebrow">HUMAN IN THE LOOP</span><h3>需要人工处理</h3></div>
        <span className="human-reason">{run.summary}</span>
      </div>
      <p className="human-hint">
        当前有 {unresolved} 条未解决意见，代码保留在服务器 worktree（未自动提交或合并）。你可以直接编辑 worktree 后「恢复下一轮」（会记录恢复点 HEAD 与人工指令），或「重试审核」让 Reviewer 复查当前代码；不再继续时「终止」。
      </p>
      <label>人工指令（可选，随恢复发送给修复 Agent）
        <textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：优先修复凭据隔离问题；其余按审核意见逐条处理。" disabled={Boolean(busy)} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="human-actions">
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("resume")}>
          {busy === "resume" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}恢复下一轮
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("review")}>
          {busy === "review" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}重试审核
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("terminate")}>
          {busy === "terminate" ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}终止
        </button>
      </div>
    </section>
  );
}

const formatClock = (date: string) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(date));
const formatDuration = (ms: number) => ms ? `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s` : "—";
const compactNumber = (value: number) => value > 999 ? `${(value / 1000).toFixed(1)}k` : String(value);

export function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [config, setConfig] = useState<ConfigStatus>();
  const [user, setUser] = useState<CurrentUser>();
  const [tab, setTab] = useState<Tab>("activity");
  const [view, setView] = useState<"run" | "workspaces">("run");
  const [createOpen, setCreateOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshRuns = useCallback(async () => {
    const next = await api.runs();
    setRuns(next);
    setSelectedId((current) => current || next[0]?.id);
  }, []);

  useEffect(() => {
    void Promise.all([api.config().then(setConfig), api.me().then(setUser), refreshRuns()]).finally(() => setLoading(false));
  }, [refreshRuns]);

  useEffect(() => {
    if (!selectedId) { setRun(undefined); setEvents([]); return; }
    let active = true;
    void Promise.all([api.run(selectedId), api.events(selectedId)]).then(([nextRun, nextEvents]) => {
      if (!active) return;
      setRun(nextRun);
      setEvents(nextEvents);
    });
    const stream = new EventSource(`/api/runs/${selectedId}/stream`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event]);
      void api.run(selectedId).then((nextRun) => {
        setRun(nextRun);
        setRuns((current) => current.map((item) => item.id === nextRun.id ? nextRun : item));
      });
    };
    return () => { active = false; stream.close(); };
  }, [selectedId]);

  const flow = useMemo(() => flowForRun(run), [run]);
  const running = runs.filter((item) => !terminalStates.includes(item.state)).length;

  const handleCreated = (created: Run) => {
    setRuns((current) => [created, ...current]);
    setSelectedId(created.id);
    setRun(created);
    setEvents([]);
    setView("run");
  };

  const handleDelete = async (target: Run) => {
    if (!terminalStates.includes(target.state)) {
      window.alert("任务仍在运行，请先点击右上角「停止」，结束后再删除。");
      return;
    }
    if (!window.confirm(`删除任务「${target.title}」？任务记录与事件会一并删除（代码仍保留在服务器 worktree）。`)) return;
    try {
      await api.deleteRun(target.id);
      const next = await api.runs();
      setRuns(next);
      if (selectedId === target.id) setSelectedId(next[0]?.id);
    } catch (cause) {
      window.alert(`删除失败：${(cause as Error).message}`);
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top"><Logo /><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <button className="new-run" onClick={() => setCreateOpen(true)}><Plus size={17} />新建任务<span>⌘ K</span></button>
        <nav className="primary-nav">
          <button type="button" className={view === "run" ? "active" : ""} onClick={() => setView("run")}><GitBranch size={16} />工作流</button>
          <button type="button" className={view === "workspaces" ? "active" : ""} onClick={() => setView("workspaces")}><FolderGit2 size={16} />工作区</button>
          <button type="button" onClick={() => setCredentialsOpen(true)}><KeyRound size={16} />个人模型 Key<span className="nav-badge">BYOK</span></button>
          <a href="#system"><Activity size={16} />运行状态</a>
        </nav>
        <div className="sidebar-section-head"><span>最近任务</span><Search size={14} /></div>
        <div className="run-list">
          {runs.map((item) => (
            <div className={`run-item ${selectedId === item.id ? "selected" : ""}`} key={item.id}>
              <button className="run-item-main" onClick={() => { setSelectedId(item.id); setSidebarOpen(false); setView("run"); }}>
                <span className={`run-state-dot status-${item.state}`} />
                <span><strong>{item.title}</strong><small>{item.repository} · R{item.round}</small></span>
                <ChevronRight size={14} className="run-item-chevron" />
              </button>
              <button className="run-item-delete" title="删除任务" onClick={() => void handleDelete(item)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!runs.length && !loading && <div className="sidebar-empty">还没有任务</div>}
        </div>
        {config && <div className="providers-card" id="models">
          <div className="providers-title"><span>AGENT ROUTING</span><Zap size={13} /></div>
          <ProviderStatus label="开发" provider={config.developer.provider} model={config.developer.model} ready={config.developer.credentialConfigured} icon={Code2} />
          <ProviderStatus label="审核" provider={config.reviewer.provider} model={config.reviewer.model} ready={config.reviewer.credentialConfigured} icon={ShieldCheck} />
          <button className="manage-credentials" type="button" onClick={() => setCredentialsOpen(true)}><KeyRound size={13} />配置或轮换个人 Key</button>
          <div className={`credential-warning ${config.realRunsAvailable ? "runner-ready" : ""}`}><AlertTriangle size={13} />{config.realRunsAvailable ? "真实执行已启用" : "真实执行尚未启用"}</div>
        </div>}
        <div className="account-footer"><div><span className="system-dot" /><strong>{user?.email || "正在验证账户"}</strong><small>Pi {config?.piVersion || "—"}</small></div><a href="/cdn-cgi/access/logout" title="退出登录"><LogOut size={15} /></a></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb">
            {view === "workspaces"
              ? <><span>WORKSPACES</span><ChevronRight size={13} /><strong>工作区</strong></>
              : <><span>WORKFLOWS</span><ChevronRight size={13} /><strong>{run?.id.slice(0, 12) || "OVERVIEW"}</strong></>}
          </div>
          <div className="topbar-actions">
            {view === "run" && (run?.mode === "demo" ? <span className="demo-chip"><Sparkles size={13} />演示数据</span> : run && <span className="demo-chip real-chip"><Code2 size={13} />真实工作区</span>)}
            {view === "run" && run && !terminalStates.includes(run.state) && <button className="button danger-small" onClick={() => void api.cancelRun(run.id)}><Square size={12} />停止</button>}
            <button className="icon-button"><PanelRightClose size={17} /></button>
          </div>
        </header>

        {view === "workspaces" ? (
          <WorkspacesPage config={config} runs={runs} onOpenCredentials={() => setCredentialsOpen(true)} />
        ) : !run ? (
          <section className="welcome-state">
            <div className="welcome-orbit"><div><Bot size={32} /></div><i /><i /><i /></div>
            <span className="eyebrow">MULTI-MODEL ENGINEERING</span>
            <h1>让开发与审核<br />形成可靠闭环</h1>
            <p>DeepSeek 编写代码，OpenAI 独立审核。每次退回、检查与复审都有迹可循。</p>
            <button className="button primary large" onClick={() => setCreateOpen(true)}><Play size={17} />创建开发工作流</button>
          </section>
        ) : (
          <div className="dashboard" id="workflow">
            <section className="run-heading">
              <div>
                <div className="heading-meta"><StatusPill state={run.state} /><span>{run.repository}</span><span><GitBranch size={12} />{run.branch}</span></div>
                <h1>{run.title}</h1>
                <p>{run.summary}</p>
              </div>
              <div className="run-round"><span>REVIEW ROUND</span><strong>{run.round}<em>/ {run.maxRounds}</em></strong></div>
            </section>

            {run.state === "needs_human" && (
              <HumanInterventionPanel
                run={run}
                onUpdated={(next) => {
                  setRun(next);
                  setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
                }}
              />
            )}

            <section className="metrics-grid">
              <div className="metric"><span><Activity size={14} />状态</span><strong>{stateLabels[run.state]}</strong><small>{running} 个任务运行中</small></div>
              <div className="metric"><span><Clock3 size={14} />耗时</span><strong>{formatDuration(run.durationMs)}</strong><small>端到端执行时间</small></div>
              <div className="metric"><span><Braces size={14} />Tokens</span><strong>{compactNumber(run.usage.inputTokens + run.usage.outputTokens)}</strong><small>输入 {compactNumber(run.usage.inputTokens)} · 输出 {compactNumber(run.usage.outputTokens)}</small></div>
              <div className="metric"><span><Zap size={14} />估算成本</span><strong>${run.usage.estimatedCost.toFixed(3)}</strong><small>{run.mode === "demo" ? "演示估算值" : "当前统计值"}</small></div>
            </section>

            <div className="content-grid">
              <section className="panel flow-panel">
                <div className="panel-head"><div><span className="eyebrow">LIVE ORCHESTRATION</span><h3>工作流拓扑</h3></div><div className="live-indicator"><i />LIVE</div></div>
                <div className="flow-wrap">
                  <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView minZoom={0.6} maxZoom={1.4} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
                    <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#252a31" />
                    <Controls showInteractive={false} />
                    <MiniMap pannable={false} zoomable={false} nodeColor={(node) => node.data.status === "active" ? "#e6ff62" : "#353b44"} maskColor="rgba(8,10,13,.76)" />
                  </ReactFlow>
                </div>
              </section>

              <section className="panel detail-panel">
                <div className="detail-tabs">
                  {([
                    ["activity", "活动", Activity],
                    ["agents", `Agents ${run.plan?.tasks.length || ""}`, Bot],
                    ["review", `审核 ${run.findings.length || ""}`, ShieldCheck],
                    ["diff", "Diff", FileCode2],
                    ["checks", "检查", ListChecks],
                  ] as const).map(([key, label, Icon]) => (
                    <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key)}><Icon size={14} />{label}</button>
                  ))}
                </div>
                <div className="detail-body">
                  {tab === "activity" && <ActivityPanel events={events} />}
                  {tab === "agents" && <SubAgentsPanel run={run} />}
                  {tab === "review" && <ReviewPanel findings={run.findings} />}
                  {tab === "diff" && <DiffPanel diff={run.diff} />}
                  {tab === "checks" && <ChecksPanel run={run} />}
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
      <CreateRunDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} config={config} onGoWorkspaces={() => { setCreateOpen(false); setView("workspaces"); }} />
      <CredentialsDialog open={credentialsOpen} onClose={() => setCredentialsOpen(false)} config={config} onChanged={setConfig} />
    </div>
  );
}
