import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  CornerDownLeft,
  Cpu,
  Download,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitPullRequestArrow,
  History,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LogOut,
  Menu,
  MessagesSquare,
  PanelRightClose,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { chatChannelLabels, chatCounts, chatMessageView, chatMessagesFromEvents, chatParticipantLabels, chatTabs, filterChatMessages, isReviewMessage, messageFindings, reworkBranchDetails, reworkBranchRounds, type ChatTab, type ReworkBranchDetail } from "../shared/chat";
import { describeMergeRestore, mergeRestoreFields } from "../shared/merge";
import { branchStatus, currentRoundStatus, roundStatuses, roundStatusMeta, roundStatusTooltip, type RoundStatus } from "../shared/round-status";
import type { ChatMessage, ConfigStatus, CurrentUser, Finding, ModelCatalogResponse, Run, RunArtifact, RunEvent, RunMode, RunRoleUsage, RunState, Workspace } from "../shared/types";
import { api, type DeploymentStatus } from "./api";
import { HistoryPage } from "./HistoryPage";
import { runStateLabels, requirementSummary } from "./requirement-history";
import { batchCleanupConfirmMessage, cleanupFinishedConfirmMessage, cleanupStorageDetailLines, summarizeCleanupStorage } from "./run-cleanup-view";
import { MAX_BUFFERED_EVENTS, mergeRunEvents, shouldAcceptRun } from "./run-events";
import { createRunSelectionGuard, eventsForRun, isRunSelected, pickSelectedRun } from "./run-selection";
import { ModelsPage } from "./ModelsPage";
import { SystemStatusPage } from "./SystemStatusPage";
import { WorkspacesPage } from "./WorkspacesPage";

type Tab = "activity" | "agents" | "review" | "diff" | "checks" | "budget";
type FlowNodeData = {
  label: string;
  caption: string;
  kind: "task" | "developer" | "checks" | "reviewer" | "complete";
  status: "waiting" | "active" | "done" | "warning";
  meta?: string;
  /** Live workflow status of the round this node represents. */
  roundStatus?: RoundStatus;
};

const terminalStates: RunState[] = ["completed", "needs_human", "failed", "cancelled"];

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

/**
 * Compact round-workflow badge: Chinese label + semantic colour + a tooltip
 * carrying the check/finding counts. Reused by the pipeline round marker and
 * every rework branch label.
 */
function RoundStatusBadge({ status, includeRound = false, className }: {
  status: RoundStatus;
  includeRound?: boolean;
  className?: string;
}) {
  const meta = roundStatusMeta[status.status];
  const tooltip = `${includeRound ? `第 ${status.round} 轮 · ` : ""}${meta.label} · ${roundStatusTooltip(status)}`;
  return (
    <span className={`round-status round-status-${meta.tone}${className ? ` ${className}` : ""}`} title={tooltip}>
      {meta.label}
    </span>
  );
}

function FlowCard({ data }: NodeProps<Node<FlowNodeData>>) {
  const Icon = iconForKind[data.kind];
  return (
    <div className={`flow-card flow-${data.kind} is-${data.status}`}>
      <Handle type="target" position={Position.Left} id="main-target" className="flow-handle" />
      <div className="flow-icon"><Icon size={17} strokeWidth={1.8} /></div>
      <div className="flow-copy">
        <div className="flow-title">{data.label}</div>
        <div className="flow-caption">{data.caption}</div>
      </div>
      {data.status === "active" && <LoaderCircle className="spin flow-state-icon" size={15} />}
      {data.status === "done" && <Check className="flow-state-icon" size={15} />}
      {data.roundStatus && <RoundStatusBadge status={data.roundStatus} includeRound className="flow-round-status" />}
      {data.meta && <span className="flow-meta">{data.meta}</span>}
      <Handle type="source" position={Position.Right} id="main-source" className="flow-handle" />
      <Handle type="target" position={Position.Bottom} id="bottom-target" className="flow-handle flow-handle-bottom" style={{ left: "30%" }} />
      <Handle type="source" position={Position.Bottom} id="bottom-source" className="flow-handle flow-handle-bottom" style={{ left: "70%" }} />
    </div>
  );
}

const nodeTypes = { flowCard: FlowCard };

// Renders a rework branch that dips below the main pipeline instead of
// travelling back along the original path.
function ReworkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const label = typeof data?.label === "string" ? data.label : "";
  const centerY = typeof data?.centerY === "number" ? data.centerY : Math.max(sourceY, targetY) + 96;
  const round = typeof data?.round === "number" ? data.round : undefined;
  const active = data?.active === true;
  const onSelect = typeof data?.onSelect === "function" ? (data.onSelect as (round: number) => void) : undefined;
  const roundStatus = data?.roundStatus as RoundStatus | undefined;
  const roundStatusTip = typeof data?.roundStatusTooltip === "string" ? data.roundStatusTooltip : undefined;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
    centerY,
  });
  const title = round === undefined
    ? undefined
    : `${roundStatus ? `${roundStatusMeta[roundStatus.status].label} · ${roundStatusTip ?? roundStatusTooltip(roundStatus)}\n` : ""}查看第 ${round} 轮返修原因`;
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={`rework-label ${active ? "is-active" : ""}`}
            title={title}
            aria-pressed={active}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation();
              if (round !== undefined) onSelect?.(round);
            }}
          >
            <CornerDownLeft size={11} />{label}
            {roundStatus && <RoundStatusBadge status={roundStatus} />}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { rework: ReworkEdge };

interface FlowOptions {
  /** Currently inspected rework round; its branch label is highlighted. */
  selectedReworkRound?: number | null;
  onReworkSelect?: (round: number) => void;
}

function flowForRun(run?: Run, events: RunEvent[] = [], options: FlowOptions = {}): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const currentOrder = run ? stateOrder[run.state] : -1;
  // Per-round workflow status powers the badge on the pipeline's round marker
  // and on every rework branch. Later rounds override earlier ones, so the
  // current marker reads the highest round present.
  const statuses = roundStatuses(events, run);
  const currentStatus = currentRoundStatus(statuses);
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
        roundStatus: currentStatus,
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
    { id: "task-dev", source: "task", target: "developer", sourceHandle: "main-source", targetHandle: "main-target", ...edgeDefaults },
    { id: "dev-check", source: "developer", target: "checks", sourceHandle: "main-source", targetHandle: "main-target", ...edgeDefaults },
    { id: "check-review", source: "checks", target: "reviewer", sourceHandle: "main-source", targetHandle: "main-target", ...edgeDefaults },
    { id: "review-done", source: "reviewer", target: "complete", sourceHandle: "main-source", targetHandle: "main-target", ...edgeDefaults },
  ];
  // Each return round is drawn as its own branch below the pipeline rather
  // than as a reverse traversal over the original edges. Only real review
  // returns qualify — checks failures advance the round without the reviewer.
  const returns = reworkBranchRounds(events);
  for (const [index, round] of returns.entries()) {
    // The branch badge follows the round the branch leads into (the repair it
    // opens), not the returned round's terminal `已退回返修`; clicks still open the
    // returned round's ReworkDetail via `round`/`onSelect`.
    const branch = branchStatus(statuses, round);
    edges.push({
      id: `rework-${round}`,
      source: "reviewer",
      target: "developer",
      sourceHandle: "bottom-source",
      targetHandle: "bottom-target",
      type: "rework",
      data: {
        label: `round ${round} · 返修`,
        centerY: 208 + index * 54,
        round,
        roundStatus: branch.status,
        roundStatusTooltip: branch.tooltip,
        active: options.selectedReworkRound === round,
        onSelect: options.onReworkSelect,
      },
      style: {
        stroke: options.selectedReworkRound === round ? "#ffd08a" : "#f3a65a",
        strokeWidth: options.selectedReworkRound === round ? 2.2 : 1.5,
        strokeDasharray: "5 4",
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "#f3a65a" },
    });
  }
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
  return <span className={`status-pill status-${state}`}><i />{runStateLabels[state]}</span>;
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

function CreateRunDialog({ open, onClose, onCreated, config, recentRuns, onGoWorkspaces }: {
  open: boolean;
  onClose: () => void;
  onCreated: (run: Run) => void;
  config?: ConfigStatus;
  recentRuns: Run[];
  onGoWorkspaces: () => void;
}) {
  const [title, setTitle] = useState("修复并发刷新竞态");
  const [repository, setRepository] = useState("demo/auth-service");
  const [task, setTask] = useState("修复 token 并发刷新导致的重复请求问题，补充失败清理与并发回归测试，确保 lint、类型检查和单元测试全部通过。");
  const [mode, setMode] = useState<RunMode>("demo");
  const [checks, setChecks] = useState("npm test");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [models, setModels] = useState<ModelCatalogResponse>();
  const [developerModelId, setDeveloperModelId] = useState("");
  const [reviewerModelId, setReviewerModelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !config?.realRunsAvailable) return;
    void Promise.all([api.workspaces(), api.models()]).then(([workspaceResult, modelResult]) => {
      const active = workspaceResult.workspaces.filter((item) => item.status === "active");
      setWorkspaces(active);
      setModels(modelResult);
      const preferred = active.find((item) => !item.git?.dirty) ?? active[0];
      if (preferred) {
        setWorkspaceId(preferred.id);
        if (preferred.defaultChecks.length > 0) setChecks(preferred.defaultChecks.join("\n"));
      }
      const pick = (selection: { provider: string; model: string }, role: "developer" | "reviewer") => {
        const exact = modelResult.models.find((entry) => entry.provider === selection.provider && entry.model === selection.model);
        if (exact) return exact.id;
        // AUD-09: prefer a verified model but still allow choosing any model for
        // the role — the run preflight reports the precise blocking reason.
        return modelResult.models.find((entry) => entry.roles.includes(role) && entry.available)?.id
          ?? modelResult.models.find((entry) => entry.roles.includes(role))?.id
          ?? "";
      };
      setDeveloperModelId(pick(modelResult.defaultDeveloper, "developer"));
      setReviewerModelId(pick(modelResult.defaultReviewer, "reviewer"));
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
      const developer = models?.models.find((entry) => entry.id === developerModelId);
      const reviewer = models?.models.find((entry) => entry.id === reviewerModelId);
      const run = await api.createRun({
        title,
        task,
        mode,
        ...(mode === "real"
          ? {
              workspaceId,
              checks: checks.split("\n").map((item) => item.trim()).filter(Boolean),
              developerModel: developer ? { provider: developer.provider, model: developer.model } : undefined,
              reviewerModel: reviewer ? { provider: reviewer.provider, model: reviewer.model } : undefined,
            }
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
              <label>开发模型<select value={developerModelId} onChange={(event) => setDeveloperModelId(event.target.value)}>
                {(models?.models ?? []).filter((entry) => entry.roles.includes("developer")).map((entry) => (
                  <option value={entry.id} key={entry.id} disabled={!entry.available}>{entry.label} · {entry.model}{entry.available ? "" : "（缺凭据）"}</option>
                ))}
              </select></label>
              <label>审核模型<select value={reviewerModelId} onChange={(event) => setReviewerModelId(event.target.value)}>
                {(models?.models ?? []).filter((entry) => entry.roles.includes("reviewer")).map((entry) => (
                  <option value={entry.id} key={entry.id} disabled={!entry.available}>{entry.label} · {entry.model}{entry.available ? "" : "（缺凭据）"}</option>
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
        {recentRuns.length > 0 && (
          <div className="recent-requirements">
            <span className="eyebrow">最近需求 · 点击填入</span>
            <div className="recent-list">
              {recentRuns.slice(0, 5).map((item) => (
                <button
                  type="button"
                  className="recent-item"
                  key={item.id}
                  title={requirementSummary(item.task, 300)}
                  onClick={() => { setTitle(item.title); setTask(item.task); }}
                >
                  <strong>{item.title}</strong>
                  <small>{requirementSummary(item.task, 70)}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {mode === "real" && <label>检查命令（每行一个）<textarea rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="npm test" /></label>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={submitting || (mode === "real" && (!workspaceId || selectedDirty || !developerModelId || !reviewerModelId))}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{mode === "real" ? "开始真实开发" : "运行演示"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ActivityPanel({ events }: { events: RunEvent[] }) {
  // Chat entries have their own transcript panel; the activity feed stays a
  // pure orchestration timeline instead of duplicating every chat message.
  const activity = events.filter((event) => event.type !== "chat.message");
  if (!activity.length) return <EmptyPanel icon={Activity} text="等待事件" />;
  return (
    <div className="timeline">
      {[...activity].reverse().map((event) => (
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
          <div>
            {task.name && <span className="subagent-codename">{task.name}</span>}
            <strong>{task.title}</strong>
            <p>{task.summary || task.description}</p>
            {task.files.length > 0 && <code>{task.files.join(" · ")}</code>}
          </div>
          <em>{task.status}</em>
        </article>
      ))}
    </div>
  );
}

function DiffPanel({ run, artifacts, mergeRequestConfigured }: { run: Run; artifacts: RunArtifact[]; mergeRequestConfigured?: boolean }) {
  const diffArtifact = artifacts.find((artifact) => artifact.artifactId === "diff");
  // A1: the export route always resolves the authoritative patch (artifact,
  // inline diff, or a worker regeneration), so it is preferred over the raw
  // artifact download.
  const exportUrl = api.runPatchUrl(run.id);
  const [mrState, setMrState] = useState<"" | "busy" | "done" | "error">("");
  const [mrMessage, setMrMessage] = useState("");
  const createMergeRequest = async () => {
    setMrState("busy");
    setMrMessage("");
    try {
      const result = await api.createMergeRequest(run.id);
      setMrState("done");
      setMrMessage(result.mergeRequest.url ? `已创建合并请求：${result.mergeRequest.url}` : "已创建合并请求");
    } catch (cause) {
      setMrState("error");
      setMrMessage((cause as Error).message);
    }
  };
  return (
    <div className="diff-panel">
      <div className="artifact-bar">
        {diffArtifact ? (
          <a className="button secondary" href={api.artifactDownloadUrl(run.id, "diff")} download>
            <Download size={14} />下载完整 Diff (.patch)
            <em>{diffArtifact.bytes} bytes · {diffArtifact.sha256?.slice(0, 12)}</em>
          </a>
        ) : null}
        {diffArtifact || run.diff ? (
          <a className="button secondary" href={exportUrl} download>
            <Download size={14} />导出补丁 (.patch)
          </a>
        ) : null}
        {mergeRequestConfigured ? (
          <button type="button" className="button secondary" disabled={mrState === "busy"} onClick={() => void createMergeRequest()}>
            {mrState === "busy" ? <LoaderCircle className="spin" size={14} /> : <GitPullRequestArrow size={14} />}创建合并请求
          </button>
        ) : null}
        {diffArtifact?.baseSha ? <code className="artifact-base">base {diffArtifact.baseSha.slice(0, 10)}</code> : null}
        <span className="artifact-hint">页面预览可能被截断；完整内容以制品下载为准。</span>
      </div>
      {mrMessage ? <div className={mrState === "error" ? "form-error" : "artifact-hint"}>{mrMessage}</div> : null}
      {run.diff ? (
        <pre className="diff-view">{run.diff.split("\n").map((line, index) => (
          <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line}`}>{line}{"\n"}</span>
        ))}</pre>
      ) : <EmptyPanel icon={FileCode2} text="尚无代码变更" />}
    </div>
  );
}

/**
 * B2: durable record of what was accepted — findings split, diff identity,
 * checks summary and usage, with a copy button for the full JSON.
 */
function AcceptancePanel({ run }: { run: Run }) {
  const [copied, setCopied] = useState(false);
  const snapshot = run.acceptance;
  if (!snapshot) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="panel acceptance-panel">
      <div className="panel-head">
        <div><span className="eyebrow">ACCEPTANCE SNAPSHOT</span><h3>验收快照</h3></div>
        <button type="button" className="button secondary" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制 JSON"}
        </button>
      </div>
      <div className="acceptance-grid">
        <div><span>受理人</span><strong>{snapshot.acceptedBy}</strong><small>{formatClock(snapshot.acceptedAt)}</small></div>
        <div><span>已解决 / 待处理意见</span><strong>{snapshot.findings.resolved.count} / {snapshot.findings.remaining.count}</strong><small>{snapshot.acknowledgedOpenFindings ? "已确认接受未解决意见" : "无未解决意见"}</small></div>
        <div><span>检查</span><strong>{snapshot.checks.passed} 通过 / {snapshot.checks.failed} 失败</strong><small>共 {snapshot.checks.total} 项</small></div>
        <div><span>Diff 制品</span><strong>{snapshot.diff.sha256 ? snapshot.diff.sha256.slice(0, 12) : "未知"}</strong><small>{snapshot.diff.bytes === null ? "字节数未知" : `${snapshot.diff.bytes} bytes`}</small></div>
        <div><span>模型调用 / 成本</span><strong>{snapshot.usage.modelCalls} 次 · ${snapshot.usage.estimatedCost.toFixed(3)}</strong><small>输入 {compactNumber(snapshot.usage.inputTokens)} · 输出 {compactNumber(snapshot.usage.outputTokens)}</small></div>
        <div><span>验收备注</span><strong>{snapshot.note ?? "无"}</strong><small>{run.merge ? `已合并 ${run.merge.commit.slice(0, 10)} → ${run.merge.targetBranch}` : "未合并"}</small></div>
      </div>
    </section>
  );
}

/**
 * A3: compact read-only deployment panel. Every unknown state is shown as such;
 * a missing deploy log is reported instead of pretending there were no deploys.
 */
function DeploymentPanel({ onOpenSystemStatus }: { onOpenSystemStatus?: () => void }) {
  const [status, setStatus] = useState<DeploymentStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    void api.deployments().then(setStatus).catch((cause) => setError((cause as Error).message));
  }, []);
  const unknown = <span className="deploy-unknown">未知</span>;
  return (
    <div className="deployments-card">
      <div className="providers-title">
        <span>DEPLOYMENTS</span>
        {onOpenSystemStatus
          ? <button type="button" className="deploy-open" title="打开系统状态" onClick={onOpenSystemStatus}>系统状态<Activity size={12} /></button>
          : <Activity size={13} />}
      </div>
      {error ? <div className="form-error">部署状态不可用：{error}</div> : null}
      <div className="deploy-row"><span>Web</span><strong>{status?.web.version ?? unknown}</strong></div>
      <div className="deploy-row"><span>Worker</span><strong>{status?.worker.version ?? unknown}</strong></div>
      <div className="deploy-row"><span>回滚标签</span><strong>{status?.rollbackTags.length ? status.rollbackTags.join("、") : unknown}</strong></div>
      <div className="deploy-row"><span>部署日志</span><strong>{status ? (status.log.available ? `${status.records.length} 条` : "不可用") : unknown}</strong></div>
      {status?.records.length ? (
        <ul className="deploy-records">
          {status.records.slice(0, 3).map((record, index) => (
            <li key={`${record.raw}-${index}`}>
              <code>{record.version ?? "—"}</code>
              <span>{record.role ?? record.status ?? "记录"}</span>
              <small>{record.at ?? ""}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {status && !status.log.available ? <small className="deploy-hint">部署日志不可用（{status.log.path}）</small> : null}
    </div>
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
          <span className="check-exit" title="进程退出码">{check.exitCode === undefined ? "exit —" : `exit ${check.exitCode}`}</span>
          <span>{check.durationMs ? `${(check.durationMs / 1000).toFixed(1)}s` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** GAP-04: per-run budget limits vs. current spend, remaining calls/cost. */
function BudgetPanel({ run }: { run: Run }) {
  const budget = run.budget;
  const usedTokens = run.usage.totalTokens ?? run.usage.inputTokens + run.usage.outputTokens;
  const usedCost = run.usage.estimatedCost;
  const usedCalls = run.modelCalls ?? (run.usageRoles ?? []).reduce((total, entry) => total + entry.calls, 0);
  const usedSeconds = Math.round(run.durationMs / 1000);
  const remaining = (limit: number, used: number) => (limit > 0 ? Math.max(0, limit - used) : null);
  const rows = [
    { label: "Tokens", limit: budget?.maxTokens ?? 0, used: usedTokens, remaining: remaining(budget?.maxTokens ?? 0, usedTokens), unit: "" },
    { label: "成本 (USD)", limit: budget?.maxCostUsd ?? 0, used: usedCost, remaining: remaining(budget?.maxCostUsd ?? 0, usedCost), unit: "$" },
    { label: "模型调用次数", limit: budget?.maxModelCalls ?? 0, used: usedCalls, remaining: remaining(budget?.maxModelCalls ?? 0, usedCalls), unit: "" },
    { label: "时长 (秒)", limit: budget?.maxDurationSeconds ?? 0, used: usedSeconds, remaining: remaining(budget?.maxDurationSeconds ?? 0, usedSeconds), unit: "" },
  ];
  const format = (value: number, unit: string) => `${unit}${unit === "$" ? value.toFixed(3) : compactNumber(value)}`;
  const roles: RunRoleUsage[] = run.usageRoles ?? [];
  const sessionFor = (role: string) => {
    const base = run.id.replaceAll("_", "-");
    if (role === "developer") return `${base}-developer`;
    if (role === "integrator") return `${base}-integrator`;
    if (role === "sub-agent") return `${base}-sub-<taskId>`;
    return "无独立会话（--no-session）";
  };
  return (
    <div className="budget-panel">
      <div className="budget-grid">
        {rows.map((row) => (
          <div className="budget-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{format(row.used, row.unit)}{row.limit > 0 ? <em> / {format(row.limit, row.unit)}</em> : <em> / 未设置上限</em>}</strong>
            <small>{row.remaining === null ? "未设置上限" : `剩余 ${format(row.remaining, row.unit)}`}</small>
          </div>
        ))}
      </div>
      <div className="budget-roles">
        <div className="budget-roles-head"><span>AGENT</span><span>MODEL</span><span>CALLS</span><span>TOKENS</span><span>COST</span></div>
        {roles.length === 0 && <div className="budget-empty">尚无按 Agent 统计的用量（演示任务不产生真实用量）。</div>}
        {roles.map((entry) => (
          <div className="budget-roles-row" key={`${entry.role}-${entry.provider}-${entry.model}`}>
            <span><strong>{entry.role}</strong><code>{sessionFor(entry.role)}</code></span>
            <span>{entry.provider}/{entry.model}</span>
            <span>{entry.calls}</span>
            <span>{compactNumber(entry.inputTokens + entry.outputTokens)}</span>
            <span>${entry.estimatedCost.toFixed(3)}</span>
          </div>
        ))}
        {(run.usageUnknownCalls ?? 0) > 0 && <div className="budget-unknown">有 {run.usageUnknownCalls} 次调用的 provider 用量无法确认，未计入费用。</div>}
      </div>
    </div>
  );
}

function participantName(participant: ChatMessage["from"], run: Run) {
  if (participant === "developer") return run.developer.model;
  if (participant === "reviewer") return run.reviewer.model;
  return chatParticipantLabels[participant];
}

function participantInitials(participant: ChatMessage["from"]) {
  if (participant === "orchestrator") return "OR";
  if (participant === "developer") return "DEV";
  if (participant === "reviewer") return "REV";
  if (participant === "checks") return "CI";
  return "USR";
}

function ChatMessageItem({ message, run, expanded, onToggle, canJumpToRound, onJumpToRound }: {
  message: ChatMessage;
  run: Run;
  expanded: boolean;
  onToggle: (id: string, next: boolean) => void;
  canJumpToRound: boolean;
  onJumpToRound: (round: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const view = useMemo(() => chatMessageView(message, expanded), [message, expanded]);
  const findings = useMemo(() => messageFindings(message), [message]);
  // Real review hand-offs persist their findings as a JSON body; once rendered
  // structurally that raw JSON is redundant (copy still yields the full body).
  const structuredOnly = findings.length > 0 && message.content.trim().startsWith("[");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard API can be unavailable (insecure origin / denied): keep the
      // message readable instead of surfacing a failure.
      setCopied(false);
    }
  };
  return (
    <article className={`chat-message chat-${message.channel} role-${message.role}`}>
      <span className="chat-avatar">{message.agent ? message.agent.slice(0, 2) : participantInitials(message.from)}</span>
      <div className="chat-bubble">
        <div className="chat-meta">
          <strong>{message.agent ?? participantName(message.from, run)}</strong>
          <ArrowRight size={11} />
          <span>{participantName(message.to, run)}</span>
          <em className={`chat-channel-tag tag-${message.channel}`}>{chatChannelLabels[message.channel]}</em>
          <em className="chat-round">R{message.round}</em>
          <time>{formatClock(message.at)}</time>
          <button type="button" className="chat-copy" title="复制这条消息的完整内容" onClick={() => void copy()}>
            {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? "已复制" : "复制"}
          </button>
          {canJumpToRound && (
            <button type="button" className="chat-copy" title={`跳到第 ${message.round} 轮工作流拓扑`} onClick={() => onJumpToRound(message.round)}>
              <CornerDownLeft size={11} />跳到该轮拓扑
            </button>
          )}
        </div>
        {findings.length > 0 && (
          <div className="chat-findings">
            <div className="chat-findings-head">{findings.length} 项审核发现</div>
            {findings.map((item, index) => (
              <article className={`chat-finding sev-${item.severity}`} key={item.id ?? index}>
                <div className="chat-finding-head">
                  <span className={`fsev fsev-${item.severity}`}>{item.severity}</span>
                  <strong>{item.title}</strong>
                  <code>{item.file ?? "—"}{item.line ? `:${item.line}` : ""}</code>
                </div>
                {item.requiredChange && <p><ArrowUpRight size={11} />{item.requiredChange}</p>}
              </article>
            ))}
          </div>
        )}
        {!structuredOnly && (view.monospace
          ? <pre className="chat-text chat-mono">{view.text}</pre>
          : <p className="chat-text">{view.text}</p>)}
        {!structuredOnly && view.collapsible && (
          <button type="button" className="chat-toggle" aria-expanded={view.expanded} onClick={() => onToggle(message.id, !view.expanded)}>
            <ChevronDown size={12} className={view.expanded ? "chat-toggle-open" : ""} />
            {view.expanded ? "收起" : `展开完整内容（${(view.bytes / 1024).toFixed(1)} KB）`}
          </button>
        )}
      </div>
    </article>
  );
}

function ReworkDetail({ detail, onJumpToChat, onClose }: {
  detail: ReworkBranchDetail;
  onJumpToChat: (round: number) => void;
  onClose: () => void;
}) {
  const severities = (["critical", "high", "medium", "low"] as const).filter((severity) => detail.summary.bySeverity[severity] > 0);
  const hidden = detail.summary.total - detail.summary.top.length;
  return (
    <aside className="rework-detail" role="dialog" aria-label={`第 ${detail.round} 轮返修`}>
      <div className="rework-detail-head">
        <strong>第 {detail.round} 轮返修</strong>
        <button type="button" className="rework-close" title="关闭" onClick={onClose}><X size={13} /></button>
      </div>
      <p className="rework-reason">{detail.reason}</p>
      <div className="rework-summary">
        <span>共 {detail.summary.total} 项发现</span>
        {severities.map((severity) => (
          <em key={severity} className={`fsev fsev-${severity}`}>{severity} {detail.summary.bySeverity[severity]}</em>
        ))}
      </div>
      {detail.summary.top.length > 0 ? (
        <ul className="rework-findings">
          {detail.summary.top.map((item, index) => (
            <li key={item.id ?? index}>
              <span className={`fsev fsev-${item.severity}`}>{item.severity}</span>
              <span className="rework-finding-title">{item.title}</span>
              <code>{item.file ?? "—"}{item.line ? `:${item.line}` : ""}</code>
            </li>
          ))}
        </ul>
      ) : <p className="rework-empty">本轮没有结构化发现记录。</p>}
      {hidden > 0 && <p className="rework-more">另有 {hidden} 项未在此列出，详见协作对话日志。</p>}
      <button type="button" className="button secondary" onClick={() => onJumpToChat(detail.round)}>
        <CornerDownLeft size={13} />跳到该轮协作对话
      </button>
    </aside>
  );
}

function ChatLog({ messages, run, activeTab, onTabChange, roundFilter, onClearRoundFilter, reworkRounds, onJumpToRound }: {
  messages: ChatMessage[];
  run: Run;
  activeTab: ChatTab;
  onTabChange: (tab: ChatTab) => void;
  roundFilter: number | null;
  onClearRoundFilter: () => void;
  reworkRounds: ReadonlySet<number>;
  onJumpToRound: (round: number) => void;
}) {
  const counts = useMemo(() => chatCounts(messages), [messages]);
  const visible = useMemo(() => {
    const filtered = filterChatMessages(messages, activeTab);
    return roundFilter === null ? filtered : filtered.filter((message) => message.round === roundFilter);
  }, [messages, activeTab, roundFilter]);
  // Explicit per-message overrides; review messages expand by default so their
  // structured findings and full prompt are visible without a click, while the
  // operator can still collapse them (or open a long non-review message).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggle = (id: string, next: boolean) => setOverrides((current) => ({ ...current, [id]: next }));
  return (
    <section className="panel chat-panel" id="chat-log">
      <div className="chat-head">
        <div className="chat-title">
          <span className="eyebrow">AGENT CONVERSATION</span>
          <h3><MessagesSquare size={15} />协作对话日志</h3>
        </div>
        <div className="chat-tabs" role="tablist" aria-label="对话筛选">
          {roundFilter !== null && (
            <button type="button" className="chat-round-filter" title="清除轮次筛选" onClick={onClearRoundFilter}>
              仅看第 {roundFilter} 轮<X size={11} />
            </button>
          )}
          {chatTabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : ""}
              key={tab.id}
              title={tab.hint}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}<em>{counts[tab.id]}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="chat-body">
        {visible.length === 0 ? (
          <EmptyPanel icon={MessagesSquare} text={roundFilter !== null ? `第 ${roundFilter} 轮暂无对话` : activeTab === "all" ? "等待 Agent 对话" : "该分类暂无对话"} />
        ) : (
          <div className="chat-stream">
            {visible.map((message) => (
              <ChatMessageItem
                key={message.id}
                message={message}
                run={run}
                expanded={overrides[message.id] ?? isReviewMessage(message)}
                onToggle={toggle}
                canJumpToRound={reworkRounds.has(message.round)}
                onJumpToRound={onJumpToRound}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyPanel({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="empty-panel"><Icon size={22} /><span>{text}</span></div>;
}

function HumanInterventionPanel({ run, events, onUpdated }: { run: Run; events: RunEvent[]; onUpdated: (run: Run) => void }) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"" | "resume" | "review" | "terminate" | "continue" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const [mergeNotice, setMergeNotice] = useState("");
  // A2: admin-only merge on accept; the server enforces the admin check.
  const [mergeIntoWorkspace, setMergeIntoWorkspace] = useState(false);
  const unresolved = run.findings.filter((item) => !item.resolved).length;
  // R: the latest merge failure's restore state, so the line survives a reload
  // (the worker records `run.merge_failed` with `restored`/`restoreError`).
  const eventNotice = useMemo(() => {
    const failure = [...events].reverse().find((event) => event.type === "run.merge_failed");
    return failure
      ? describeMergeRestore(mergeRestoreFields({ restored: failure.meta?.restored, restoreError: failure.meta?.restoreError }))
      : undefined;
  }, [events]);
  const restoreNotice = mergeNotice || eventNotice;
  const restoreFailed = restoreNotice?.startsWith("工作区恢复失败") ?? false;

  const act = async (kind: "resume" | "review" | "terminate" | "continue" | "approve" | "reject") => {
    setError("");
    setMergeNotice("");
    if (kind === "terminate" && !window.confirm(`终止任务「${run.title}」？\n\n任务会标记为已取消；代码与 worktree 全部保留，不会自动合并。`)) return;
    if (kind === "reject" && !window.confirm(`拒绝任务「${run.title}」的交付？\n\n任务将标记为已取消；代码与 worktree 全部保留。`)) return;
    if (kind === "approve" && !window.confirm(
      `${unresolved > 0 ? `任务「${run.title}」仍有 ${unresolved} 条未解决意见。\n\n确认接受交付？这些意见会被记录为已知接受，不会继续修复。` : `确认通过任务「${run.title}」的交付？`}${mergeIntoWorkspace ? "\n\n已勾选「合并到工作区默认分支」：将先合并再完成（冲突会被拒绝，工作区保持不变）。" : "\n\nworktree 中的代码不会自动推送或合并。"}`,
    )) return;
    setBusy(kind);
    try {
      if (kind === "resume") {
        onUpdated(await api.resumeRun(run.id, { instruction: instruction.trim() || undefined }));
      } else if (kind === "review") {
        onUpdated(await api.retryReviewRun(run.id));
      } else if (kind === "continue") {
        // "继续开发" never warns: it sends the run back for another round.
        onUpdated(await api.approveRun(run.id, { mode: "continue", note: instruction.trim() || undefined }));
      } else if (kind === "approve") {
        onUpdated(await api.approveRun(run.id, {
          mode: "accept",
          note: instruction.trim() || undefined,
          acknowledgeOpenFindings: unresolved > 0,
          mergeIntoWorkspace,
        }));
      } else if (kind === "reject") {
        onUpdated(await api.rejectRun(run.id, { reason: instruction.trim() || undefined }));
      } else {
        onUpdated(await api.cancelRun(run.id));
      }
    } catch (cause) {
      const failure = cause as Error & { body?: Record<string, unknown> };
      setError(failure.message);
      // R: surface the workspace-restore state even before the event list refreshes.
      const immediate = describeMergeRestore(mergeRestoreFields({ restored: failure.body?.restored, restoreError: failure.body?.restoreError }));
      if (immediate) setMergeNotice(immediate);
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
        当前有 {unresolved} 条未解决意见，代码保留在服务器 worktree（未自动提交或合并）。选择「继续开发」会带着未解决意见回到开发再跑一轮；选择「接受交付」会直接完成交付（仍有未解决意见时会先二次确认），也可以直接编辑 worktree 后「恢复下一轮」（会记录恢复点 HEAD 与人工指令）、「重试审核」让 Reviewer 复查当前代码，或「拒绝」终止交付。
      </p>
      <label>人工指令 / 审批备注（可选，随恢复或审批记录）
        <textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：优先修复凭据隔离问题；其余按审核意见逐条处理。" disabled={Boolean(busy)} />
      </label>
      <label className="merge-option">
        <input type="checkbox" checked={mergeIntoWorkspace} onChange={(event) => setMergeIntoWorkspace(event.target.checked)} disabled={Boolean(busy)} />
        审批通过后合并到工作区默认分支（仅管理员；冲突会被拒绝且不修改工作区）
      </label>
      {restoreNotice && <div className={`merge-notice ${restoreFailed ? "merge-notice-warn" : ""}`}>{restoreNotice}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="human-actions">
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("continue")}>
          {busy === "continue" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}继续开发
        </button>
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("approve")}>
          {busy === "approve" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}接受交付
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("resume")}>
          {busy === "resume" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}恢复下一轮
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("review")}>
          {busy === "review" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}重试审核
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("reject")}>
          {busy === "reject" ? <LoaderCircle className="spin" size={15} /> : <XCircle size={15} />}拒绝交付
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
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [config, setConfig] = useState<ConfigStatus>();
  const [user, setUser] = useState<CurrentUser>();
  const [tab, setTab] = useState<Tab>("activity");
  const [chatTab, setChatTab] = useState<ChatTab>("all");
  // Item-1: which rework branch's detail panel is open; Item-2: the chat round filter.
  const [reworkRound, setReworkRound] = useState<number | null>(null);
  const [chatRoundFilter, setChatRoundFilter] = useState<number | null>(null);
  const [view, setView] = useState<"run" | "workspaces" | "models" | "history" | "system">("run");
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
    if (!selectedId) { setRun(undefined); setEvents([]); setArtifacts([]); setReworkRound(null); setChatRoundFilter(null); return; }
    // Reset for the newly selected run before any snapshot/stream data merges in,
    // so seq numbers from different runs are never mixed.
    setEvents([]);
    setArtifacts([]);
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

  const handleReworkSelect = useCallback((round: number) => {
    setReworkRound((current) => (current === round ? null : round));
  }, []);
  // Item-1: one detail entry per rendered branch, built from the run's events +
  // findings (no new API).
  const reworkDetails = useMemo(() => reworkBranchDetails(events, activeRun?.findings ?? []), [events, activeRun?.findings]);
  const reworkRounds = useMemo(() => new Set(reworkDetails.map((detail) => detail.round)), [reworkDetails]);
  const selectedRework = reworkRound === null ? undefined : reworkDetails.find((detail) => detail.round === reworkRound);
  const flow = useMemo(
    () => flowForRun(activeRun, events, { selectedReworkRound: reworkRound, onReworkSelect: handleReworkSelect }),
    [activeRun, events, reworkRound, handleReworkSelect],
  );
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

  const handleCreated = (created: Run) => {
    setRuns((current) => [created, ...current]);
    setSelectedId(created.id);
    setRun(created);
    setEvents([]);
    setArtifacts([]);
    setReworkRound(null);
    setChatRoundFilter(null);
    setView("run");
  };

  const handleCleanup = async () => {
    // B6: state exactly what is removed. The server deletes the run directory by
    // default, so the old "worktree 保留" wording was wrong.
    if (!window.confirm(cleanupFinishedConfirmMessage({ olderThanDays: 7, deleteRunDirectory: true }))) return;
    try {
      const result = await api.cleanupRuns({ olderThanDays: 7, deleteRunDirectory: true });
      await refreshRuns();
      window.alert(`已清理 ${result.deleted ?? 0} 个已结束任务。`);
    } catch (cause) {
      window.alert(`清理失败：${(cause as Error).message}`);
    }
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

  /** B1: reopen a completed run (owner-confirmed; the server allows admins freely). */
  const handleReopen = async (target: Run) => {
    if (!window.confirm(`重新打开任务「${target.title}」？\n\n任务会回到「需要人工处理」，分支与 worktree 保持原样。`)) return;
    try {
      applyRun(await api.reopenRun(target.id, { confirm: true }));
    } catch (cause) {
      window.alert(`重新打开失败：${(cause as Error).message}`);
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
      if (!window.confirm(batchCleanupConfirmMessage({ count: ids.length, deleteRunDirectory: batchDeleteRunDirectory }))) return;
    } else if (action === "accept") {
      const openCount = selected.reduce((total, item) => total + item.findings.filter((finding) => !finding.resolved).length, 0);
      if (!window.confirm(`批量接受 ${ids.length} 个任务的交付？${openCount > 0 ? `\n\n其中共有 ${openCount} 条未解决意见将被记录为已知接受。` : ""}`)) return;
    } else if (!window.confirm(`将选中的 ${ids.length} 个任务退回开发再跑一轮？`)) return;
    setBatchBusy(true);
    try {
      const summary = await api.batchRuns({ action, runIds: ids, acknowledgeOpenFindings: true, deleteRunDirectory: action === "cleanup" ? batchDeleteRunDirectory : undefined });
      await refreshRuns();
      const failed = summary.results.filter((result) => !result.ok);
      const label = action === "accept" ? "接受交付" : action === "continue" ? "继续开发" : "清理";
      // B6: the cleanup summary reports each run's on-disk outcome.
      const storage = action === "cleanup"
        ? `\n${summarizeCleanupStorage(summary.results)}${summary.results.length ? `\n${cleanupStorageDetailLines(summary.results).join("\n")}` : ""}`
        : "";
      window.alert(`批量${label}完成：成功 ${summary.succeeded}，失败 ${summary.failed}${storage}${failed.length ? `\n${failed.slice(0, 5).map((result) => `${result.runId.slice(0, 12)}：${result.error ?? result.code ?? "失败"}`).join("\n")}` : ""}`);
      setBatchSelected(new Set());
    } catch (cause) {
      window.alert(`批量操作失败：${(cause as Error).message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top"><Logo /><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <button className="new-run" onClick={() => setCreateOpen(true)}><Plus size={17} />新建任务<span>⌘ K</span></button>
        <nav className="primary-nav">
          <button type="button" className={view === "run" ? "active" : ""} onClick={() => setView("run")}><GitBranch size={16} />工作流</button>
          <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16} />需求历史</button>
          <button type="button" className={view === "workspaces" ? "active" : ""} onClick={() => setView("workspaces")}><FolderGit2 size={16} />工作区</button>
          <button type="button" className={view === "models" ? "active" : ""} onClick={() => setView("models")}><Cpu size={16} />模型与凭据</button>
          {/* SYS-01: this used to be a dead `#system` anchor into the sidebar deployment card; it now opens the system status dashboard. */}
          <button type="button" className={view === "system" ? "active" : ""} onClick={() => setView("system")}><Activity size={16} />系统状态</button>
        </nav>
        <div className="sidebar-section-head"><span>最近任务</span><span className="sidebar-head-actions"><Search size={14} /><button className="sidebar-cleanup" type="button" title="清理 7 天前已结束的任务" onClick={() => void handleCleanup()}><Trash2 size={13} /></button></span></div>
        {batchSelected.size > 0 && (
          <div className="batch-bar">
            <span>已选 {batchSelected.size} 个</span>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => void handleBatch("accept")}>接受交付</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => void handleBatch("continue")}>继续开发</button>
            <label className="batch-cleanup-option" title="选中后，清理会同时删除服务器上的运行目录/worktree；取消勾选则只删除运行记录与制品。">
              <input type="checkbox" checked={batchDeleteRunDirectory} disabled={batchBusy} onChange={(event) => setBatchDeleteRunDirectory(event.target.checked)} />
              清理时删除运行目录
            </label>
            <button type="button" className="button danger-text" disabled={batchBusy} onClick={() => void handleBatch("cleanup")}>清理</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => setBatchSelected(new Set())}>取消</button>
          </div>
        )}
        <div className="run-list">
          {runs.map((item) => (
            <div className={`run-item ${selectedId === item.id ? "selected" : ""}`} key={item.id}>
              <label className="run-select" title="选择以进行批量操作">
                <input type="checkbox" checked={batchSelected.has(item.id)} onChange={() => toggleBatch(item.id)} />
              </label>
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
          <button className="manage-credentials" type="button" onClick={() => setView("models")}><KeyRound size={13} />配置或轮换个人 Key</button>
          <div className={`credential-warning ${config.realRunsAvailable ? "runner-ready" : ""}`}><AlertTriangle size={13} />{config.realRunsAvailable ? "真实执行已启用" : "真实执行尚未启用"}</div>
        </div>}
        <DeploymentPanel onOpenSystemStatus={() => setView("system")} />
        <div className="account-footer"><div><span className="system-dot" /><strong>{user?.email || "正在验证账户"}</strong><small>Pi {config?.piVersion || "—"}</small></div><a href="/cdn-cgi/access/logout" title="退出登录"><LogOut size={15} /></a></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb">
            {view === "workspaces"
              ? <><span>WORKSPACES</span><ChevronRight size={13} /><strong>工作区</strong></>
              : view === "models"
                ? <><span>MODELS</span><ChevronRight size={13} /><strong>模型与凭据</strong></>
                : view === "system"
                  ? <><span>SYSTEM</span><ChevronRight size={13} /><strong>系统状态</strong></>
                  : view === "history"
                    ? <><span>HISTORY</span><ChevronRight size={13} /><strong>需求历史</strong></>
                    : <><span>WORKFLOWS</span><ChevronRight size={13} /><strong>{activeRun?.id.slice(0, 12) || "OVERVIEW"}</strong></>}
          </div>
          <div className="topbar-actions">
            {view === "run" && (activeRun?.mode === "demo" ? <span className="demo-chip"><Sparkles size={13} />演示数据</span> : activeRun && <span className="demo-chip real-chip"><Code2 size={13} />真实工作区</span>)}
            {view === "run" && activeRun && !terminalStates.includes(activeRun.state) && <button className="button danger-small" onClick={() => void api.cancelRun(activeRun.id)}><Square size={12} />停止</button>}
            <button className="icon-button"><PanelRightClose size={17} /></button>
          </div>
        </header>

        {view === "system" ? (
          <SystemStatusPage />
        ) : view === "models" ? (
          <ModelsPage config={config} onChanged={() => { void api.config().then(setConfig); }} />
        ) : view === "workspaces" ? (
          <WorkspacesPage config={config} runs={runs} onOpenCredentials={() => setView("models")} />
        ) : view === "history" ? (
          <HistoryPage runs={runs} onOpenRun={(id) => { setSelectedId(id); setView("run"); setSidebarOpen(false); }} />
        ) : !activeRun ? (
          selectedId ? (
            <section className="run-loading">
              <LoaderCircle className="spin" size={22} />
              <span>正在加载任务详情…</span>
            </section>
          ) : (
            <section className="welcome-state">
              <div className="welcome-orbit"><div><Bot size={32} /></div><i /><i /><i /></div>
              <span className="eyebrow">MULTI-MODEL ENGINEERING</span>
              <h1>让开发与审核<br />形成可靠闭环</h1>
              <p>DeepSeek 编写代码，OpenAI 独立审核。每次退回、检查与复审都有迹可循。</p>
              <button className="button primary large" onClick={() => setCreateOpen(true)}><Play size={17} />创建开发工作流</button>
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
                {activeRun.state === "completed" && (
                  <button type="button" className="button secondary reopen-button" onClick={() => void handleReopen(activeRun)}>
                    <RotateCcw size={14} />重新打开
                  </button>
                )}
              </div>
            </section>

            {activeRun.state === "needs_human" && (
              <HumanInterventionPanel
                run={activeRun}
                events={events}
                onUpdated={(next) => {
                  setRun(next);
                  setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
                }}
              />
            )}

            <AcceptancePanel run={activeRun} />

            <section className="metrics-grid">
              <div className="metric"><span><Activity size={14} />状态</span><strong>{runStateLabels[activeRun.state]}</strong><small>{running} 个任务运行中</small></div>
              <div className="metric"><span><Clock3 size={14} />耗时</span><strong>{formatDuration(activeRun.durationMs)}</strong><small>端到端执行时间</small></div>
              <div className="metric"><span><Braces size={14} />Tokens</span><strong>{compactNumber(activeRun.usage.inputTokens + activeRun.usage.outputTokens)}</strong><small>输入 {compactNumber(activeRun.usage.inputTokens)} · 输出 {compactNumber(activeRun.usage.outputTokens)}</small></div>
              <div className="metric"><span><Zap size={14} />估算成本</span><strong>${activeRun.usage.estimatedCost.toFixed(3)}</strong><small>{activeRun.mode === "demo" ? "演示估算值" : "当前统计值"}</small></div>
            </section>

            <div className="content-grid">
              <section className="panel flow-panel" id="workflow-topology">
                <div className="panel-head"><div><span className="eyebrow">LIVE ORCHESTRATION</span><h3>工作流拓扑</h3></div><div className="live-indicator"><i />LIVE</div></div>
                <div className="flow-wrap">
                  {/* Keyed by run id so each run mounts a fresh React Flow
                      instance: `fitView` only runs on mount, so reusing the
                      instance across a run switch could leave the new topology
                      panned/zoomed off-screen (a blank canvas). */}
                  <ReactFlow key={activeRun.id} nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.6} maxZoom={1.4} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
                    <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#252a31" />
                    <Controls showInteractive={false} />
                    <MiniMap pannable={false} zoomable={false} nodeColor={(node) => node.data.status === "active" ? "#e6ff62" : "#353b44"} maskColor="rgba(8,10,13,.76)" />
                  </ReactFlow>
                  {selectedRework && <ReworkDetail detail={selectedRework} onJumpToChat={jumpToChat} onClose={() => setReworkRound(null)} />}
                </div>
              </section>

              <section className="panel detail-panel">
                <div className="detail-tabs">
                  {([
                    ["activity", "活动", Activity],
                    ["agents", `Agents ${activeRun.plan?.tasks.length || ""}`, Bot],
                    ["review", `审核 ${activeRun.findings.length || ""}`, ShieldCheck],
                    ["diff", "Diff", FileCode2],
                    ["checks", "检查", ListChecks],
                    ["budget", "预算与用量", Braces],
                  ] as const).map(([key, label, Icon]) => (
                    <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key)}><Icon size={14} />{label}</button>
                  ))}
                </div>
                <div className="detail-body">
                  {tab === "activity" && <ActivityPanel events={events} />}
                  {tab === "agents" && <SubAgentsPanel run={activeRun} />}
                  {tab === "review" && <ReviewPanel findings={activeRun.findings} />}
                  {tab === "diff" && <DiffPanel run={activeRun} artifacts={artifacts} mergeRequestConfigured={config?.mergeRequestConfigured} />}
                  {tab === "checks" && <ChecksPanel run={activeRun} />}
                  {tab === "budget" && <BudgetPanel run={activeRun} />}
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
      </main>
      <CreateRunDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} config={config} recentRuns={runs} onGoWorkspaces={() => { setCreateOpen(false); setView("workspaces"); }} />
    </div>
  );
}
