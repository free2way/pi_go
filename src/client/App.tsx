import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
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
  ClipboardList,
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
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, intlLocale, localizeError, type Locale } from "../shared/i18n";
import { useT, type TFunction } from "./i18n";
import { roleCostDisplay, roleCostLabel, roleDisplayName, totalUnpricedCalls } from "./budget-roles-view";
import { chatCounts, chatMessageView, chatMessagesFromEvents, chatTabs, filterChatMessages, isReviewMessage, messageFindings, reworkBranchDetails, reworkBranchRounds, type ChatTab, type ReworkBranchDetail } from "../shared/chat";
import { describeMergeRestore, mergeRestoreFields } from "../shared/merge";
import { findingFingerprint } from "../shared/finding-fingerprint";
import type { DecisionBrief } from "../shared/decision-brief";
import { branchStatus, currentRoundStatus, roundStatuses, roundStatusMeta, type RoundStatus } from "../shared/round-status";
import type { ChatMessage, ConfigStatus, CurrentUser, Finding, ModelCatalogResponse, RoundSummary, Run, RunArtifact, RunEvent, RunMode, RunRoleUsage, RunState, Workspace } from "../shared/types";
import type { ModelTemplate } from "../shared/agile";
import { api } from "./api";
import {
  acceptConfirmMessage,
  continueConfirmMessage,
  decisionBriefActionRequest,
  decisionBriefExpanded,
  decisionBriefHeadingKey,
  decisionBriefTone,
  decisionGateDetail,
  decisionRecommendationNote,
  decisionStopMessage,
  gateNavTarget,
  groupRemainingByAc,
  decisionGateKeys,
  decisionRemainingGroupKey,
} from "./decision-brief-view";
import { AgilePage } from "./AgilePage";
import { DecisionsPanel } from "./DecisionsPanel";
import { HistoryPage } from "./HistoryPage";
import { requirementSummary, runStateKey } from "./requirement-history";
import { batchCleanupConfirmMessage, cleanupFinishedConfirmMessage, cleanupStorageDetailLines, summarizeCleanupStorage } from "./run-cleanup-view";
import { MAX_BUFFERED_EVENTS, deferredNonBlockingNotice, mergeRunEvents, shouldAcceptRun } from "./run-events";
import { createRunSelectionGuard, eventsForRun, isRunSelected, pickSelectedRun } from "./run-selection";
import { reworkBranchDetailsFromSummaries, resolveReworkRounds, resolveRoundStatuses, roundStatusKey } from "./rounds-view";
import { reworkBranchLayout, reworkBranchPath, type ReworkSide } from "./rework-layout";
import { ModelsPage } from "./ModelsPage";
import { mergeOptionState } from "./merge-option";
import { buildRoleModelOptions, modelOptionText, preferredModelId, roleUncovered } from "./model-options";
import { isModelSelectableForRole } from "../shared/model-select";
import { AccountsPage } from "./AccountsPage";
import { SystemStatusPage } from "./SystemStatusPage";
import { WorkspacesPage } from "./WorkspacesPage";

/**
 * 侧栏「最近任务」只列最近的 N 个（需求）：完整列表在「需求历史」页
 * （可搜索 / 筛状态 / 分页）。新建的运行一定是最新的，因此始终可见。
 */
const RECENT_RUNS_LIMIT = 5;

type Tab = "activity" | "agents" | "review" | "diff" | "checks" | "budget" | "decisions";
type FlowNodeData = {
  label: string;
  caption: string;
  kind: "task" | "developer" | "checks" | "reviewer" | "complete" | "release";
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
  release: Rocket,
};

/**
 * Compact round-workflow badge: localized label + semantic colour + a tooltip
 * carrying the check/finding counts. Reused by the pipeline round marker and
 * every rework branch label.
 */
function roundTooltipText(t: TFunction, status: RoundStatus): string {
  return t("roundStatus.tooltip", {
    passed: status.checks.passed,
    failed: status.checks.failed,
    total: status.findings.total,
    resolved: status.findings.resolved,
  });
}

function RoundStatusBadge({ status, includeRound = false, className }: {
  status: RoundStatus;
  includeRound?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const meta = roundStatusMeta[status.status];
  const label = t(roundStatusKey(status.status));
  const tooltip = `${includeRound ? `${t("topology.round", { round: status.round })} · ` : ""}${label} · ${roundTooltipText(t, status)}`;
  return (
    <span className={`round-status round-status-${meta.tone}${className ? ` ${className}` : ""}`} title={tooltip}>
      {label}
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
      {/* Top handles feed the above-the-pipeline rework arches. */}
      <Handle type="target" position={Position.Top} id="top-target" className="flow-handle flow-handle-top" style={{ left: "30%" }} />
      <Handle type="source" position={Position.Top} id="top-source" className="flow-handle flow-handle-top" style={{ left: "70%" }} />
    </div>
  );
}

const nodeTypes = { flowCard: FlowCard };
// React Flow can receive a fresh controlled-node array whenever SSE data
// changes. The cards have a fixed visual size, so seed it explicitly: without
// this, a same-size DOM node may not fire ResizeObserver again and React Flow
// keeps the replacement node hidden with no edges until another resize.
const flowCardDimensions = {
  initialWidth: 176,
  initialHeight: 73,
  // Seed the six fixed handle bounds too. React Flow replaces these with DOM
  // measurements when available, but edges can render immediately—and remain
  // renderable when a same-size controlled node replacement emits no resize.
  handles: [
    { id: "main-target", type: "target", position: Position.Left, x: -3, y: 33.5, width: 6, height: 6 },
    { id: "main-source", type: "source", position: Position.Right, x: 173, y: 33.5, width: 6, height: 6 },
    { id: "bottom-target", type: "target", position: Position.Bottom, x: 49.8, y: 70, width: 6, height: 6 },
    { id: "bottom-source", type: "source", position: Position.Bottom, x: 120.2, y: 70, width: 6, height: 6 },
    { id: "top-target", type: "target", position: Position.Top, x: 49.8, y: -3, width: 6, height: 6 },
    { id: "top-source", type: "source", position: Position.Top, x: 120.2, y: -3, width: 6, height: 6 },
  ],
} satisfies Pick<Node<FlowNodeData>, "initialWidth" | "initialHeight" | "handles">;

// Renders a rework branch that dips above or below the main pipeline instead of
// travelling back along the original path. `data.side` selects the direction
// (and therefore which pair of handles the edge uses); `data.offset` is the
// dip magnitude produced by `reworkBranchLayout`.
function ReworkEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, data }: EdgeProps) {
  const { t } = useT();
  const label = typeof data?.label === "string" ? data.label : "";
  const side: ReworkSide = data?.side === "above" ? "above" : "below";
  const offset = typeof data?.offset === "number" ? data.offset : 96;
  // The apex rail sits one `offset` beyond the outermost handle on the chosen
  // side, so it follows the assigned side without the caller knowing card sizes.
  const railY = side === "above"
    ? Math.min(sourceY, targetY) - offset
    : Math.max(sourceY, targetY) + offset;
  const edgePath = reworkBranchPath(sourceX, sourceY, targetX, targetY, railY, side);
  const labelX = (sourceX + targetX) / 2;
  const labelY = railY;
  const round = typeof data?.round === "number" ? data.round : undefined;
  const active = data?.active === true;
  const onSelect = typeof data?.onSelect === "function" ? (data.onSelect as (round: number) => void) : undefined;
  const roundStatus = data?.roundStatus as RoundStatus | undefined;
  const roundStatusTip = typeof data?.roundStatusTooltip === "string" ? data.roundStatusTooltip : undefined;
  const title = round === undefined
    ? undefined
    : `${roundStatus ? `${t(roundStatusKey(roundStatus.status))} · ${roundStatusTip ?? roundTooltipText(t, roundStatus)}\n` : ""}${t("topology.reworkReason", { round })}`;
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
  /**
   * 拓扑轮次模型: server-aggregated per-round summaries. When present they are the
   * source of truth for the round set, verdicts and branch list; when absent the
   * event-derived model is used (older server / failed request).
   */
  roundSummaries?: RoundSummary[];
  /** Bound translator; without one the flow falls back to the message keys. */
  t?: TFunction;
}

const identityT: TFunction = (key) => String(key);

function flowForRun(run?: Run, events: RunEvent[] = [], options: FlowOptions = {}): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const t = options.t ?? identityT;
  const currentOrder = run ? stateOrder[run.state] : -1;
  // Per-round workflow status powers the badge on the pipeline's round marker
  // and on every rework branch. Later rounds override earlier ones, so the
  // current marker reads the highest round present. The server summary is
  // authoritative for the round set so rounds older than the buffered event
  // window still render; the event-derived statuses only add the live stage.
  const eventStatuses = roundStatuses(events, run);
  const statuses = resolveRoundStatuses(options.roundSummaries, eventStatuses);
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
      ...flowCardDimensions,
      id: "task",
      type: "flowCard",
      position: { x: 16, y: 72 },
      data: { label: t("flow.task.label"), caption: "Git worktree", kind: "task", status: statusAt(0) },
    },
    {
      ...flowCardDimensions,
      id: "developer",
      type: "flowCard",
      position: { x: 245, y: 72 },
      data: {
        label: run && (run.plan?.tasks.length || 0) > 1 ? t("flow.developer.multi", { count: run.plan?.tasks.length ?? 0 }) : t("flow.developer.label"),
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
      ...flowCardDimensions,
      id: "checks",
      type: "flowCard",
      position: { x: 474, y: 72 },
      data: { label: t("flow.checks.label"), caption: "lint · types · tests", kind: "checks", status: statusAt(2) },
    },
    {
      ...flowCardDimensions,
      id: "reviewer",
      type: "flowCard",
      position: { x: 703, y: 72 },
      data: {
        label: t("flow.reviewer.label"),
        caption: run?.reviewer.model || "review agent",
        kind: "reviewer",
        status: statusAt(3),
      },
    },
    {
      ...flowCardDimensions,
      id: "complete",
      type: "flowCard",
      position: { x: 932, y: 72 },
      data: {
        label: run?.state === "needs_human" ? t("flow.complete.human") : t("flow.complete.done"),
        caption: run?.state === "completed" ? "checks + review passed" : "approval gate",
        kind: "complete",
        status: statusAt(4),
      },
    },
    {
      ...flowCardDimensions,
      id: "release",
      type: "flowCard",
      position: { x: 1161, y: 72 },
      data: {
        label: run?.release?.status === "succeeded" ? t("flow.release.succeeded") : t("flow.release.label"),
        caption: run?.release
          ? `${run.release.environment} · ${run.release.status}`
          : run?.merge
            ? t("flow.release.awaitingPublish")
            : t("flow.release.awaitingMerge"),
        kind: "release",
        status: !run || run.state !== "completed" || !run.merge
          ? "waiting"
          : run.release?.status === "succeeded"
            ? "done"
            : run.release?.status === "failed"
              ? "warning"
              : run.release?.status === "publishing" || run.release?.status === "triggered"
                ? "active"
                : "waiting",
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
    { id: "done-release", source: "complete", target: "release", sourceHandle: "main-source", targetHandle: "main-target", ...edgeDefaults },
  ];
  // Each return round is drawn as its own branch rather than as a reverse
  // traversal over the original edges. Only real review returns qualify — checks
  // failures advance the round without the reviewer. `reworkBranchLayout`
  // alternates the branches above/below the pipeline and staggers same-side
  // dips so they never overlap; the edge uses the matching top/bottom handles.
  const eventReturns = reworkBranchRounds(events);
  const returns = resolveReworkRounds(options.roundSummaries, eventReturns);
  for (const { round, side, offset } of reworkBranchLayout(returns)) {
    // The branch badge follows the round the branch leads into (the repair it
    // opens), not the returned round's terminal `已退回返修`; clicks still open the
    // returned round's ReworkDetail via `round`/`onSelect`.
    const branch = branchStatus(statuses, round);
    const branchTip = branch.status ? roundTooltipText(t, branch.status) : undefined;
    const active = options.selectedReworkRound === round;
    edges.push({
      id: `rework-${round}`,
      source: "reviewer",
      target: "developer",
      sourceHandle: side === "above" ? "top-source" : "bottom-source",
      targetHandle: side === "above" ? "top-target" : "bottom-target",
      type: "rework",
      data: {
        label: t("flow.rework.label", { round }),
        side,
        offset,
        round,
        roundStatus: branch.status,
        roundStatusTooltip: branchTip,
        active,
        onSelect: options.onReworkSelect,
      },
      style: {
        stroke: active ? "#ffd08a" : "#f3a65a",
        // Branch strokes stay a touch thinner than the main pipeline (1.5).
        strokeWidth: active ? 2 : 1.2,
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
  const { t } = useT();
  return <span className={`status-pill status-${state}`}><i />{t(runStateKey(state))}</span>;
}

function ProviderStatus({ label, provider, model, ready, icon: Icon }: {
  label: string;
  provider: string;
  model: string;
  ready: boolean;
  icon: typeof Bot;
}) {
  const { t } = useT();
  return (
    <div className="provider-row">
      <div className={`provider-icon ${provider}`}><Icon size={16} /></div>
      <div className="provider-copy"><span>{label}</span><strong>{model}</strong></div>
      <span className={`connection-dot ${ready ? "ready" : "missing"}`} title={t(ready ? "provider.credentialConfigured" : "provider.credentialMissing")} />
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
  const { t, locale } = useT();
  const [title, setTitle] = useState(() => t("createRun.demoTitle"));
  const [repository, setRepository] = useState("demo/auth-service");
  const [task, setTask] = useState(() => t("createRun.demoTask"));
  const [mode, setMode] = useState<RunMode>("demo");
  const [checks, setChecks] = useState("npm test");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [models, setModels] = useState<ModelCatalogResponse>();
  const [developerModelId, setDeveloperModelId] = useState("");
  const [reviewerModelId, setReviewerModelId] = useState("");
  const [templates, setTemplates] = useState<ModelTemplate[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !config?.realRunsAvailable) return;
    void api.templates().then((result) => setTemplates(result.templates)).catch(() => undefined);
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
        // AUD-09: only default to a pair the run preflight will accept; an
        // unusable catalogue entry stays visible (disabled) in the select but is
        // never preselected. Falls back to the exact default when it is usable.
        return preferredModelId(modelResult.models, role, selection);
      };
      setDeveloperModelId(pick(modelResult.defaultDeveloper, "developer"));
      setReviewerModelId(pick(modelResult.defaultReviewer, "reviewer"));
    }).catch((cause) => setError(localizeError(locale, cause as { code?: string; message?: string })));
  }, [open, config?.realRunsAvailable, locale]);

  if (!open) return null;
  // AUD-09: options come from the shared predicate, so the dialog can only offer
  // pairs the run preflight accepts; unusable entries stay visible but disabled
  // with the reason (never silently hidden).
  const developerOptions = buildRoleModelOptions(models?.models, "developer", locale);
  const reviewerOptions = buildRoleModelOptions(models?.models, "reviewer", locale);
  const developerUsable = developerOptions.some((option) => option.id === developerModelId && option.selectable);
  const reviewerUsable = reviewerOptions.some((option) => option.id === reviewerModelId && option.selectable);
  const developerUncovered = roleUncovered(models?.models, "developer");
  const reviewerUncovered = roleUncovered(models?.models, "reviewer");
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
      }, { locale });
      onCreated(run);
      onClose();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><span className="eyebrow">NEW WORKFLOW</span><h2>{t("createRun.title")}</h2></div>
          <button className="icon-button" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mode-picker">
          <button type="button" className={mode === "demo" ? "active" : ""} onClick={() => { setMode("demo"); setRepository("demo/auth-service"); }}><Sparkles size={14} />{t("createRun.modeDemo")}</button>
          <button type="button" className={mode === "real" ? "active" : ""} disabled={!config?.realRunsAvailable} onClick={() => setMode("real")}><Code2 size={14} />{t("createRun.modeReal")}</button>
        </div>
        <div className="demo-notice">
          {mode === "demo" ? <><Sparkles size={16} />{t("createRun.demoNotice")}</> : <><ShieldCheck size={16} />{t("createRun.realNotice")}</>}
        </div>
        <label>{t("createRun.name")}<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {mode === "real" ? (
          workspaces.length === 0 ? (
            <div className="workspace-empty-notice">
              <AlertTriangle size={15} />
              <div><strong>{t("createRun.noWorkspaces")}</strong><span>{t("createRun.noWorkspacesHint")}</span></div>
              <button type="button" className="button secondary" onClick={onGoWorkspaces}>{t("createRun.goWorkspaces")}</button>
            </div>
          ) : (
            <>
              <label>{t("createRun.workspace")}<select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name} · {workspace.git?.branch || "—"}{workspace.git?.dirty ? t("createRun.dirtySuffix") : ""}
                  </option>
                ))}
              </select></label>
              {templates.length > 0 && (
                <label>{t("createRun.template")}
                  <select value="" onChange={(event) => {
                    const template = templates.find((item) => item.id === event.target.value);
                    if (!template || !models) return;
                    const match = (selection: { provider: string; model: string }, role: "developer" | "reviewer") =>
                      // AUD-09: a template may pin a pair this deployment cannot
                      // preflight; never apply it silently — leave the current
                      // (selectable) choice so the disabled option explains why.
                      models.models.find((entry) => entry.roles.includes(role) && entry.provider === selection.provider && entry.model === selection.model && isModelSelectableForRole(entry, role))?.id;
                    const developer = match(template.developerModel, "developer");
                    const reviewer = match(template.reviewerModel, "reviewer");
                    if (developer) setDeveloperModelId(developer);
                    if (reviewer) setReviewerModelId(reviewer);
                  }}>
                    <option value="">{t("createRun.templatePlaceholder")}</option>
                    {templates.map((template) => (
                      <option value={template.id} key={template.id}>
                        {template.name} · {template.developerModel.model} / {template.reviewerModel.model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>{t("createRun.developerModel")}<select value={developerModelId} onChange={(event) => setDeveloperModelId(event.target.value)}>
                {developerOptions.map((option) => (
                  <option value={option.id} key={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>
                ))}
              </select></label>
              {developerUncovered && <div className="form-error">{t("createRun.modelRoleUncovered")}</div>}
              <label>{t("createRun.reviewerModel")}<select value={reviewerModelId} onChange={(event) => setReviewerModelId(event.target.value)}>
                {reviewerOptions.map((option) => (
                  <option value={option.id} key={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>
                ))}
              </select></label>
              {reviewerUncovered && <div className="form-error">{t("createRun.modelRoleUncovered")}</div>}
              {selectedDirty && (
                <div className="dirty-warning">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>{t("createRun.dirtyTitle")}</strong>
                    <span>{t("createRun.dirtyHint")}</span>
                    {selectedWorkspace?.git?.dirtyFiles?.length ? <code>{selectedWorkspace.git.dirtyFiles.slice(0, 5).join(" · ")}{selectedWorkspace.git.dirtyFiles.length > 5 ? " …" : ""}</code> : null}
                  </div>
                </div>
              )}
            </>
          )
        ) : <label>{t("createRun.repository")}<input value={repository} onChange={(event) => setRepository(event.target.value)} /></label>}
        <label>{t("createRun.task")}<textarea rows={5} value={task} onChange={(event) => setTask(event.target.value)} /></label>
        {recentRuns.length > 0 && (
          <div className="recent-requirements">
            <span className="eyebrow">{t("createRun.recent")}</span>
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
        {mode === "real" && <label>{t("createRun.checks")}<textarea rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="npm test" /></label>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="button primary" disabled={submitting || (mode === "real" && (!workspaceId || selectedDirty || !developerUsable || !reviewerUsable))}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{t(mode === "real" ? "createRun.submitReal" : "createRun.submitDemo")}
          </button>
        </div>
      </form>
    </div>
  );
}

function ActivityPanel({ events }: { events: RunEvent[] }) {
  const { t } = useT();
  // Chat entries have their own transcript panel; the activity feed stays a
  // pure orchestration timeline instead of duplicating every chat message.
  const activity = events.filter((event) => event.type !== "chat.message");
  if (!activity.length) return <EmptyPanel icon={Activity} text={t("activity.empty")} />;
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

function ReviewPanel({ findings, highlightKey }: { findings: Finding[]; highlightKey?: string | null }) {
  const { t } = useT();
  // 决策摘要: scroll the target finding into view when a red gate item links here.
  useEffect(() => {
    if (!highlightKey) return;
    document.getElementById(`finding-${highlightKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightKey]);
  if (!findings.length) return <EmptyPanel icon={ShieldCheck} text={t("review.empty")} />;
  return (
    <div className="finding-list">
      {findings.map((item) => {
        const key = item.fingerprint ?? findingFingerprint(item);
        return (
          <article id={`finding-${key}`} className={`finding finding-${item.severity}${key === highlightKey ? " finding-flagged" : ""}`} key={item.id}>
            <div className="finding-head">
              <span>{item.severity}</span>
              {item.resolved && <em><Check size={12} />{t("review.resolved")}</em>}
            </div>
            <h4>{item.title}</h4>
            <code>{item.file}:{item.line}</code>
            <p>{item.evidence}</p>
            <div className="required-change"><ArrowUpRight size={13} />{item.requiredChange}</div>
          </article>
        );
      })}
    </div>
  );
}

function SubAgentsPanel({ run }: { run: Run }) {
  const { t } = useT();
  if (!run.plan) return <EmptyPanel icon={Bot} text={t("agents.empty")} />;
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
  const { t, locale } = useT();
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
      setMrMessage(result.mergeRequest.url ? t("diff.mrCreatedWithUrl", { url: result.mergeRequest.url }) : t("diff.mrCreated"));
    } catch (cause) {
      setMrState("error");
      setMrMessage(localizeError(locale, cause as { code?: string; message?: string }));
    }
  };
  return (
    <div className="diff-panel">
      <div className="artifact-bar">
        {diffArtifact ? (
          <a className="button secondary" href={api.artifactDownloadUrl(run.id, "diff")} download>
            <Download size={14} />{t("diff.download")}
            <em>{diffArtifact.bytes} bytes · {diffArtifact.sha256?.slice(0, 12)}</em>
          </a>
        ) : null}
        {diffArtifact || run.diff ? (
          <a className="button secondary" href={exportUrl} download>
            <Download size={14} />{t("diff.exportPatch")}
          </a>
        ) : null}
        {mergeRequestConfigured ? (
          <button type="button" className="button secondary" disabled={mrState === "busy"} onClick={() => void createMergeRequest()}>
            {mrState === "busy" ? <LoaderCircle className="spin" size={14} /> : <GitPullRequestArrow size={14} />}{t("diff.createMr")}
          </button>
        ) : null}
        {diffArtifact?.baseSha ? <code className="artifact-base">base {diffArtifact.baseSha.slice(0, 10)}</code> : null}
        <span className="artifact-hint">{t("diff.previewHint")}</span>
      </div>
      {mrMessage ? <div className={mrState === "error" ? "form-error" : "artifact-hint"}>{mrMessage}</div> : null}
      {run.diff ? (
        <pre className="diff-view">{run.diff.split("\n").map((line, index) => (
          <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line}`}>{line}{"\n"}</span>
        ))}</pre>
      ) : <EmptyPanel icon={FileCode2} text={t("diff.empty")} />}
    </div>
  );
}

/**
 * B2: durable record of what was accepted — findings split, diff identity,
 * checks summary and usage, with a copy button for the full JSON.
 */
function AcceptancePanel({ run }: { run: Run }) {
  const { t, locale } = useT();
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
        <div><span className="eyebrow">ACCEPTANCE SNAPSHOT</span><h3>{t("acceptance.title")}</h3></div>
        <button type="button" className="button secondary" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("common.copied") : t("acceptance.copyJson")}
        </button>
      </div>
      <div className="acceptance-grid">
        <div><span>{t("acceptance.acceptedBy")}</span><strong>{snapshot.acceptedBy}</strong><small>{formatClock(snapshot.acceptedAt, locale)}</small></div>
        <div><span>{t("acceptance.findings")}</span><strong>{snapshot.findings.resolved.count} / {snapshot.findings.remaining.count}</strong><small>{t(snapshot.acknowledgedOpenFindings ? "acceptance.acknowledged" : "acceptance.noOpenFindings")}</small></div>
        <div><span>{t("acceptance.checks")}</span><strong>{t("acceptance.checksValue", { passed: snapshot.checks.passed, failed: snapshot.checks.failed })}</strong><small>{t("acceptance.checksTotal", { total: snapshot.checks.total })}</small></div>
        <div><span>{t("acceptance.diff")}</span><strong>{snapshot.diff.sha256 ? snapshot.diff.sha256.slice(0, 12) : t("common.unknown")}</strong><small>{snapshot.diff.bytes === null ? t("acceptance.bytesUnknown") : `${snapshot.diff.bytes} bytes`}</small></div>
        <div><span>{t("acceptance.usage")}</span><strong>{t("acceptance.usageValue", { calls: snapshot.usage.modelCalls, cost: snapshot.usage.estimatedCost.toFixed(3) })}</strong><small>{t("acceptance.usageTokens", { input: compactNumber(snapshot.usage.inputTokens), output: compactNumber(snapshot.usage.outputTokens) })}</small></div>
        <div><span>{t("acceptance.note")}</span><strong>{snapshot.note ?? t("acceptance.none")}</strong><small>{run.merge ? t("acceptance.merged", { commit: run.merge.commit.slice(0, 10), branch: run.merge.targetBranch }) : t("acceptance.notMerged")}</small></div>
      </div>
    </section>
  );
}

/**
 * A one-line run-detail notice for `review.nonblocking_deferred`: under
 * `reviewScope: "blocking"` the worker accepted a round whose only remaining
 * findings were medium/low. The findings stay on the run and in the acceptance
 * snapshot's "remaining" list; this line makes the deferral explicit.
 */
function DeferredNonBlockingNotice({ events }: { events: RunEvent[] }) {
  const { t, locale } = useT();
  const notice = useMemo(() => deferredNonBlockingNotice(events), [events]);
  if (!notice) return null;
  const ids = notice.ids.slice(0, 8).join(locale === "en" ? ", " : "、");
  const [open, close] = locale === "en" ? [" (", ")"] : ["（", "）"];
  return (
    <div className="review-scope-note">
      {t("review.deferred", { round: notice.round, count: notice.count })}
      {notice.ids.length > 0 ? `${open}${ids}${notice.ids.length > 8 ? "…" : ""}${close}` : ""}
    </div>
  );
}

/** Explicit administrator gate between reviewed code, local merge and release. */
function ReleasePanel({ run, user, configured, onUpdated }: {
  run: Run;
  user?: CurrentUser;
  configured?: boolean;
  onUpdated: (run: Run) => void;
}) {
  const { t, locale } = useT();
  const [environment, setEnvironment] = useState("production");
  const [busy, setBusy] = useState<"" | "merge" | "publish">("");
  const [error, setError] = useState("");
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
  const stalePublishing = (release?.status === "publishing" || release?.status === "triggered")
    && Date.now() - Date.parse(release.startedAt) >= 2 * 60_000;
  const canRetry = release?.status === "failed" || stalePublishing;
  const inProgress = (release?.status === "publishing" || release?.status === "triggered") && !stalePublishing;
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
  const publish = async () => {
    const target = release?.environment ?? environment.trim();
    if (!target) return setError(t("release.environmentRequired"));
    if (!window.confirm(t("release.publishConfirm", { title: run.title, commit: run.merge?.commit.slice(0, 12) ?? "—", environment: target }))) return;
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
        <span className={`release-status release-${release?.status ?? (run.merge ? "ready" : "waiting")}`}>{statusLabel}</span>
      </div>
      <div className="release-grid">
        <div><span>{t("release.reviewSnapshot")}</span><strong>{run.reviewSnapshot?.slice(0, 12) ?? run.baseSha?.slice(0, 12) ?? t("common.unknown")}</strong></div>
        <div><span>{t("release.mergeResult")}</span><strong>{run.merge ? `${run.merge.commit.slice(0, 12)} → ${run.merge.targetBranch}` : t("release.notMerged")}</strong></div>
        <div><span>{t("release.environment")}</span><strong>{release?.environment ?? environment}</strong></div>
        <div><span>{t("release.deliveryId")}</span><strong>{release?.deliveryId ?? t("release.deliveryIdGenerated")}</strong></div>
      </div>
      {release?.detail ? <p className="release-detail">{release.detail}</p> : null}
      {release?.url ? <a className="release-link" href={release.url} target="_blank" rel="noreferrer">{t("release.viewDeploy")} <ArrowUpRight size={13} /></a> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {user?.isAdmin ? (
        <div className="release-actions">
          {!run.merge ? (
            <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void merge()}>
              {busy === "merge" ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}{t("release.mergeAction")}
            </button>
          ) : null}
          {run.merge && release?.status !== "succeeded" ? (
            <>
              {!release ? <input aria-label={t("release.environment")} value={environment} maxLength={64} onChange={(event) => setEnvironment(event.target.value)} disabled={Boolean(busy)} /> : null}
              <button type="button" className="button primary" disabled={Boolean(busy) || inProgress || configured === false} onClick={() => void publish()}>
                {busy === "publish" || inProgress ? <LoaderCircle className="spin" size={14} /> : <Rocket size={14} />}{t(canRetry ? "release.retry" : inProgress ? "release.inProgress" : "release.confirm")}
              </button>
            </>
          ) : null}
          {configured === false ? <small className="release-config-hint">{t("release.notConfigured")}</small> : null}
        </div>
      ) : <small className="release-config-hint">{t("release.adminOnly")}</small>}
    </section>
  );
}

function ChecksPanel({ run }: { run: Run }) {
  const { t } = useT();
  return (
    <div className="check-list">
      {run.checks.map((check) => (
        <div className="check-row" key={check.id}>
          <span className={`check-icon check-${check.status}`}>
            {check.status === "passed" ? <Check size={14} /> : check.status === "running" ? <LoaderCircle className="spin" size={14} /> : <CircleDot size={14} />}
          </span>
          <div><strong>{check.name}</strong><code>{check.command}</code></div>
          <span className="check-exit" title={t("checks.exitCodeTitle")}>{check.exitCode === undefined ? "exit —" : `exit ${check.exitCode}`}</span>
          <span>{check.durationMs ? `${(check.durationMs / 1000).toFixed(1)}s` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** GAP-04: per-run budget limits vs. current spend, remaining calls/cost. */
function BudgetPanel({ run }: { run: Run }) {
  const { t, locale } = useT();
  const budget = run.budget;
  const usedTokens = run.usage.totalTokens ?? run.usage.inputTokens + run.usage.outputTokens;
  const usedCost = run.usage.estimatedCost;
  const usedCalls = run.modelCalls ?? (run.usageRoles ?? []).reduce((total, entry) => total + entry.calls, 0);
  const usedSeconds = Math.round(run.durationMs / 1000);
  const remaining = (limit: number, used: number) => (limit > 0 ? Math.max(0, limit - used) : null);
  // AT-JEV-062: the summary cost row must not read as a plain `$0.000` when some
  // calls could not be priced (e.g. the decision plane). It uses the exact same
  // rule as the per-role rows so the two can never disagree.
  const summaryCost = roleCostDisplay({ calls: usedCalls, estimatedCost: usedCost, unpricedCalls: totalUnpricedCalls(run.usageRoles) });
  const rows = [
    { label: t("budget.tokens"), limit: budget?.maxTokens ?? 0, used: usedTokens, remaining: remaining(budget?.maxTokens ?? 0, usedTokens), unit: "" },
    {
      label: t("budget.cost"),
      limit: budget?.maxCostUsd ?? 0,
      used: usedCost,
      remaining: remaining(budget?.maxCostUsd ?? 0, usedCost),
      unit: "$",
      display: summaryCost.kind === "priced" ? undefined : roleCostLabel({ calls: usedCalls, estimatedCost: usedCost, unpricedCalls: totalUnpricedCalls(run.usageRoles) }),
    },
    { label: t("budget.modelCalls"), limit: budget?.maxModelCalls ?? 0, used: usedCalls, remaining: remaining(budget?.maxModelCalls ?? 0, usedCalls), unit: "" },
    { label: t("budget.duration"), limit: budget?.maxDurationSeconds ?? 0, used: usedSeconds, remaining: remaining(budget?.maxDurationSeconds ?? 0, usedSeconds), unit: "" },
  ];
  const format = (value: number, unit: string) => `${unit}${unit === "$" ? value.toFixed(3) : compactNumber(value)}`;
  const roles: RunRoleUsage[] = run.usageRoles ?? [];
  // AT-JEV-062: calls the price table cannot cover (e.g. decision plane / TypeSafe).
  const unpricedCalls = totalUnpricedCalls(roles);
  // Sprint 2: prefer real per-session data; fall back to the derived id for
  // runs recorded before the `sessions` field existed.
  const sessionFor = (role: string) => {
    const summaries = (run.sessions ?? [])
      .filter((entry) => entry.role === role)
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    const latest = summaries[0];
    if (latest) {
      const rounds = latest.rounds.map((round) => `R${round}`).join("/");
      const kind = t(latest.resumed ? "budget.sessionReused" : "budget.sessionNew");
      const detail = t("budget.sessionDetail", { calls: latest.calls, rounds });
      return `${latest.sessionId} · ${kind}（${detail}）`;
    }
    const base = run.id.replaceAll("_", "-");
    if (role === "developer") return `${base}-developer`;
    if (role === "integrator") return `${base}-integrator`;
    if (role === "sub-agent") return `${base}-sub-<taskId>`;
    return t("budget.noSession");
  };
  return (
    <div className="budget-panel">
      <div className="budget-grid">
        {rows.map((row) => (
          <div className="budget-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{(row as { display?: string }).display ?? format(row.used, row.unit)}{row.limit > 0 ? <em> / {format(row.limit, row.unit)}</em> : <em> / {t("budget.noLimit")}</em>}</strong>
            <small>{row.remaining === null ? t("budget.noLimit") : t("budget.remaining", { value: format(row.remaining, row.unit) })}</small>
          </div>
        ))}
      </div>
      <div className="budget-roles">
        <div className="budget-roles-head"><span>AGENT</span><span>MODEL</span><span>CALLS</span><span>TOKENS</span><span>COST</span></div>
        {roles.length === 0 && <div className="budget-empty">{t("budget.empty")}</div>}
        {roles.map((entry) => (
          <div className="budget-roles-row" key={`${entry.role}-${entry.provider}-${entry.model}`}>
            <span><strong>{roleDisplayName(entry.role, locale)}</strong><code>{sessionFor(entry.role)}</code></span>
            <span>{entry.provider}/{entry.model}</span>
            <span>{entry.calls}</span>
            <span>{compactNumber(entry.inputTokens + entry.outputTokens)}</span>
            <span>{roleCostLabel(entry, locale)}</span>
          </div>
        ))}
        {unpricedCalls > 0 && <div className="budget-unknown">{t("budget.unpricedCalls", { count: unpricedCalls })}</div>}
        {(run.usageUnknownCalls ?? 0) > 0 && <div className="budget-unknown">{t("budget.unknownCalls", { count: run.usageUnknownCalls ?? 0 })}</div>}
      </div>
    </div>
  );
}

function participantName(participant: ChatMessage["from"], run: Run, t: TFunction) {
  if (participant === "developer") return run.developer.model;
  if (participant === "reviewer") return run.reviewer.model;
  return t(`chat.participant.${participant}`);
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
  const { t, locale } = useT();
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
          <strong>{message.agent ?? participantName(message.from, run, t)}</strong>
          <ArrowRight size={11} />
          <span>{participantName(message.to, run, t)}</span>
          <em className={`chat-channel-tag tag-${message.channel}`}>{t(`chat.channel.${message.channel}`)}</em>
          <em className="chat-round">R{message.round}</em>
          <time>{formatClock(message.at, locale)}</time>
          <button type="button" className="chat-copy" title={t("chat.copyTitle")} onClick={() => void copy()}>
            {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? t("common.copied") : t("common.copy")}
          </button>
          {canJumpToRound && (
            <button type="button" className="chat-copy" title={t("chat.jumpTopologyTitle", { round: message.round })} onClick={() => onJumpToRound(message.round)}>
              <CornerDownLeft size={11} />{t("chat.jumpTopology")}
            </button>
          )}
        </div>
        {findings.length > 0 && (
          <div className="chat-findings">
            <div className="chat-findings-head">{t("chat.findingsCount", { count: findings.length })}</div>
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
            {view.expanded ? t("chat.collapse") : t("chat.expand", { size: (view.bytes / 1024).toFixed(1) })}
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
  const { t } = useT();
  const severities = (["critical", "high", "medium", "low"] as const).filter((severity) => detail.summary.bySeverity[severity] > 0);
  const hidden = detail.summary.total - detail.summary.top.length;
  return (
    <aside className="rework-detail" role="dialog" aria-label={t("rework.aria", { round: detail.round })}>
      <div className="rework-detail-head">
        <strong>{t("rework.title", { round: detail.round })}</strong>
        <button type="button" className="rework-close" title={t("common.close")} onClick={onClose}><X size={13} /></button>
      </div>
      <p className="rework-reason">{detail.reason}</p>
      <div className="rework-summary">
        <span>{t("rework.total", { total: detail.summary.total })}</span>
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
      ) : <p className="rework-empty">{t("rework.empty")}</p>}
      {hidden > 0 && <p className="rework-more">{t("rework.more", { count: hidden })}</p>}
      <button type="button" className="button secondary" onClick={() => onJumpToChat(detail.round)}>
        <CornerDownLeft size={13} />{t("rework.jumpChat")}
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
  const { t } = useT();
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
          <h3><MessagesSquare size={15} />{t("chat.title")}</h3>
        </div>
        <div className="chat-tabs" role="tablist" aria-label={t("chat.filterAria")}>
          {roundFilter !== null && (
            <button type="button" className="chat-round-filter" title={t("chat.clearRoundFilter")} onClick={onClearRoundFilter}>
              {t("chat.onlyRound", { round: roundFilter })}<X size={11} />
            </button>
          )}
          {chatTabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : ""}
              key={tab.id}
              title={t(`chat.tab.${tab.id}.hint`)}
              onClick={() => onTabChange(tab.id)}
            >
              {t(`chat.tab.${tab.id}`)}<em>{counts[tab.id]}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="chat-body">
        {visible.length === 0 ? (
          <EmptyPanel icon={MessagesSquare} text={roundFilter !== null ? t("chat.emptyRound", { round: roundFilter }) : activeTab === "all" ? t("chat.emptyWaiting") : t("chat.emptyCategory")} />
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

/**
 * 决策摘要 (docs/22 §2): a first-screen card on the run detail that answers the
 * single question a parked run raises — accept or continue? Purely presentational:
 * every status/verdict comes from the server's shared pure function.
 */
function DecisionBriefCard({
  brief,
  run,
  open,
  onToggle,
  onContinue,
  onAccept,
  onOpenFinding,
  onOpenTab,
}: {
  brief: DecisionBrief;
  run: Run;
  open: boolean;
  onToggle: () => void;
  onContinue: (note: string) => void;
  onAccept: () => void;
  onOpenFinding: (key: string) => void;
  onOpenTab: (tab: Tab) => void;
}) {
  const { t, locale } = useT();
  const findingsByKey = useMemo(
    () => new Map(run.findings.map((finding) => [finding.fingerprint ?? findingFingerprint(finding), finding])),
    [run.findings],
  );
  const groups = groupRemainingByAc(brief.remaining);
  const tone = decisionBriefTone(brief);
  const stop = brief.stopReason;
  // docs/24-i18n.md §9: the brief carries both languages, so the code-generated
  // judgement text follows the UI language without a refetch.
  const stopMessage = decisionStopMessage(stop, locale);
  const recommendationNote = decisionRecommendationNote(brief, locale);

  return (
    <section className={`decision-brief decision-brief-${tone}`} id="decision-brief">
      <button type="button" className="decision-brief-head" aria-expanded={open} onClick={onToggle}>
        <div className="decision-brief-title">
          <span className="eyebrow">DECISION BRIEF</span>
          <h3>{t(decisionBriefHeadingKey(brief))}</h3>
        </div>
        <div className="decision-stop">
          <em>{stop.code}</em>
          {stopMessage ? <span>{stopMessage}</span> : null}
        </div>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open ? (
        <div className="decision-body">
          <div className="decision-gates">
            {brief.gates.map((gate) => {
              const target = gateNavTarget(gate);
              return (
                <div className={`decision-gate decision-gate-${gate.status}`} key={gate.id}>
                  <span className="decision-gate-light" />
                  <strong>{t(decisionGateKeys[gate.id])}</strong>
                  <small>{decisionGateDetail(gate, locale)}</small>
                  {gate.status !== "green" ? (
                    <button
                      type="button"
                      className="decision-gate-link"
                      onClick={() => {
                        if (target.key) onOpenFinding(target.key);
                        else onOpenTab(target.tab);
                      }}
                    >
                      {t("decision.locate")}<ArrowRight size={12} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {groups.length > 0 ? (
            <div className="decision-remaining">
              {groups.map((group) => {
                const groupKey = decisionRemainingGroupKey(group.kind);
                const label = group.ac ?? (groupKey ? t(groupKey) : group.kind);
                return (
                <div className="decision-group" key={label}>
                  <span className="decision-group-label">{label}</span>
                  {group.items.map((item) => {
                    const finding = findingsByKey.get(item.key);
                    return (
                      <button type="button" className="decision-finding" key={item.key} title={t("decision.locateFindingTitle")} onClick={() => onOpenFinding(item.key)}>
                        <span className={`decision-sev decision-sev-${item.severity}`}>{item.severity}</span>
                        <span className="decision-finding-title">{finding?.title ?? item.key}</span>
                        {item.streak > 0 ? <em>{t("decision.streak", { count: item.streak })}</em> : null}
                        {!item.evidenceOk ? <em className="decision-suspect">{t("decision.suspected")}</em> : null}
                      </button>
                    );
                  })}
                </div>
                );
              })}
            </div>
          ) : null}
          <div className="decision-reco">
            <p><ShieldCheck size={14} />{recommendationNote}</p>
            <div className="decision-actions">
              <button type="button" className="button primary" onClick={() => onContinue(recommendationNote)}>
                <Play size={15} />{t("decision.continue")}
              </button>
              <button type="button" className="button primary" onClick={onAccept}>
                <CheckCircle2 size={15} />{t("decision.accept")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HumanInterventionPanel({ run, events, user, onUpdated, draftNote }: { run: Run; events: RunEvent[]; user?: CurrentUser; onUpdated: (run: Run) => void; draftNote?: string }) {
  const { t, locale } = useT();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"" | "resume" | "review" | "terminate" | "continue" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const [mergeNotice, setMergeNotice] = useState("");
  // A2: admin-only merge on accept; the server enforces the admin check, and the
  // UI mirrors it so a non-admin is never offered an action that can only 403.
  const mergeOption = mergeOptionState(user, locale);
  const [mergeIntoWorkspace, setMergeIntoWorkspace] = useState(false);
  // Convergence guardrail: the operator can narrow the continued round to the
  // blocking (critical/high) findings so medium/low notes no longer loop.
  const [reviewScope, setReviewScope] = useState<"all" | "blocking">(run.reviewScope === "blocking" ? "blocking" : "all");
  const unresolved = run.findings.filter((item) => !item.resolved).length;
  // R: the latest merge failure's restore state, so the line survives a reload
  // (the worker records `run.merge_failed` with `restored`/`restoreError`).
  const eventNotice = useMemo(() => {
    const failure = [...events].reverse().find((event) => event.type === "run.merge_failed");
    return failure
      ? describeMergeRestore(mergeRestoreFields({ restored: failure.meta?.restored, restoreError: failure.meta?.restoreError }), locale)
      : undefined;
  }, [events, locale]);
  const restoreNotice = mergeNotice || eventNotice;
  const restoreFailed = restoreNotice?.startsWith(t("merge.restoreFailed")) ?? false;

  // If the merge option is (or becomes) unavailable, never send a stale `true`.
  useEffect(() => {
    if (mergeOption.disabled) setMergeIntoWorkspace(false);
  }, [mergeOption.disabled]);

  // 决策摘要: prefill the drafted note (one item naming the file|title fingerprint).
  useEffect(() => {
    if (draftNote) setInstruction(draftNote);
  }, [draftNote]);

  const act = async (kind: "resume" | "review" | "terminate" | "continue" | "approve" | "reject") => {
    setError("");
    setMergeNotice("");
    if (kind === "terminate" && !window.confirm(t("human.terminateConfirm", { title: run.title }))) return;
    if (kind === "reject" && !window.confirm(t("human.rejectConfirm", { title: run.title }))) return;
    if (kind === "approve" && !window.confirm(
      `${unresolved > 0 ? t("human.approveConfirmOpen", { title: run.title, count: unresolved }) : t("human.approveConfirmOk", { title: run.title })}${mergeIntoWorkspace ? t("human.approveMergeSuffix") : t("human.approveNoMergeSuffix")}`,
    )) return;
    setBusy(kind);
    try {
      if (kind === "resume") {
        onUpdated(await api.resumeRun(run.id, { instruction: instruction.trim() || undefined }));
      } else if (kind === "review") {
        onUpdated(await api.retryReviewRun(run.id));
      } else if (kind === "continue") {
        // "继续开发" never warns: it sends the run back for another round.
        onUpdated(await api.approveRun(run.id, { mode: "continue", note: instruction.trim() || undefined, reviewScope }));
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
      const failure = cause as Error & { code?: string; body?: Record<string, unknown> };
      setError(localizeError(locale, failure, failure.message));
      // R: surface the workspace-restore state even before the event list refreshes.
      const immediate = describeMergeRestore(mergeRestoreFields({ restored: failure.body?.restored, restoreError: failure.body?.restoreError }), locale);
      if (immediate) setMergeNotice(immediate);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="human-panel">
      <div className="human-panel-head">
        <div><span className="eyebrow">HUMAN IN THE LOOP</span><h3>{t("human.title")}</h3></div>
        <span className="human-reason">{run.summary}</span>
      </div>
      <p className="human-hint">{t("human.hint", { count: unresolved })}</p>
      <label>{t("human.instruction")}
        <textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t("human.instructionPlaceholder")} disabled={Boolean(busy)} />
      </label>
      {mergeOption.show && (
        <label className="merge-option" title={mergeOption.hint || undefined}>
          <input type="checkbox" checked={mergeIntoWorkspace} onChange={(event) => setMergeIntoWorkspace(event.target.checked)} disabled={Boolean(busy) || mergeOption.disabled} />
          {t("human.mergeOption")}
        </label>
      )}
      {mergeOption.disabled && mergeOption.hint && <div className="merge-option-hint">{mergeOption.hint}</div>}
      <label className="review-scope-option">{t("human.reviewScope")}
        <select value={reviewScope} onChange={(event) => setReviewScope(event.target.value === "blocking" ? "blocking" : "all")} disabled={Boolean(busy)}>
          <option value="all">{t("human.scopeAll")}</option>
          <option value="blocking">{t("human.scopeBlocking")}</option>
        </select>
      </label>
      {restoreNotice && <div className={`merge-notice ${restoreFailed ? "merge-notice-warn" : ""}`}>{restoreNotice}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="human-actions">
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("continue")}>
          {busy === "continue" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{t("decision.continue")}
        </button>
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("approve")}>
          {busy === "approve" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}{t("decision.accept")}
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("resume")}>
          {busy === "resume" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("human.resume")}
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("review")}>
          {busy === "review" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{t("human.retryReview")}
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("reject")}>
          {busy === "reject" ? <LoaderCircle className="spin" size={15} /> : <XCircle size={15} />}{t("human.reject")}
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("terminate")}>
          {busy === "terminate" ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}{t("human.terminate")}
        </button>
      </div>
    </section>
  );
}

const formatClock = (date: string, locale: Locale = DEFAULT_LOCALE) => new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(date));
const formatDuration = (ms: number) => ms ? `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s` : "—";
const compactNumber = (value: number) => value > 999 ? `${(value / 1000).toFixed(1)}k` : String(value);

export function App() {
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
  const [briefDraft, setBriefDraft] = useState("");
  const [briefCollapsed, setBriefCollapsed] = useState(false);
  const [highlightFinding, setHighlightFinding] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [config, setConfig] = useState<ConfigStatus>();
  const [user, setUser] = useState<CurrentUser>();
  const [tab, setTab] = useState<Tab>("activity");
  const [chatTab, setChatTab] = useState<ChatTab>("all");
  // Item-1: which rework branch's detail panel is open; Item-2: the chat round filter.
  const [reworkRound, setReworkRound] = useState<number | null>(null);
  const [chatRoundFilter, setChatRoundFilter] = useState<number | null>(null);
  const [view, setView] = useState<"run" | "agile" | "workspaces" | "models" | "history" | "system" | "accounts">("run");
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
    if (!selectedId) return;
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
  const flow = useMemo(
    () => flowForRun(activeRun, events, { selectedReworkRound: reworkRound, onReworkSelect: handleReworkSelect, roundSummaries, t }),
    [activeRun, events, reworkRound, handleReworkSelect, roundSummaries, t],
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

  // 决策摘要 actions reuse the existing approve endpoint (no new mutation API).
  const applyAccept = useCallback((next: Run) => {
    setRun(next);
    setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
  }, []);

  const handleBriefContinue = useCallback(async (note: string) => {
    if (!activeRun || !decisionBrief) return;
    setBriefDraft(note);
    if (!window.confirm(continueConfirmMessage(activeRun.title, note, locale))) return;
    try {
      applyAccept(await api.approveRun(activeRun.id, decisionBriefActionRequest(decisionBrief, "continue")));
    } catch (cause) {
      window.alert(t("alert.continueFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    }
  }, [activeRun, decisionBrief, applyAccept, locale, t]);

  const handleBriefAccept = useCallback(async () => {
    if (!activeRun || !decisionBrief) return;
    if (!window.confirm(acceptConfirmMessage(activeRun.title, decisionBrief.remaining.length, locale))) return;
    try {
      applyAccept(await api.approveRun(activeRun.id, decisionBriefActionRequest(decisionBrief, "accept")));
    } catch (cause) {
      window.alert(t("alert.acceptFailed", { message: localizeError(locale, cause as { code?: string; message?: string }) }));
    }
  }, [activeRun, decisionBrief, applyAccept, locale, t]);

  const openBriefTarget = useCallback((nextTab: Tab, key?: string) => {
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
    setBriefDraft("");
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
          {/* 账户管理: admin-only; non-admins never see the entry (direct navigation shows the explicit 仅管理员可见 state). */}
          {user?.isAdmin && <button type="button" className={view === "accounts" ? "active" : ""} onClick={() => setView("accounts")}><Users size={16} />{t("nav.accounts")}</button>}
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
        <div className="account-footer"><div><span className="system-dot" /><strong>{user?.email || t("account.verifying")}</strong><small>Pi {config?.piVersion || "—"}</small></div><a href="/cdn-cgi/access/logout" title={t("account.logout")}><LogOut size={15} /></a></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb">
            {view === "workspaces"
              ? <><span>WORKSPACES</span><ChevronRight size={13} /><strong>{t("nav.workspaces")}</strong></>
              : view === "models"
                ? <><span>MODELS</span><ChevronRight size={13} /><strong>{t("nav.models")}</strong></>
                : view === "system"
                  ? <><span>SYSTEM</span><ChevronRight size={13} /><strong>{t("nav.system")}</strong></>
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

        {view === "system" ? (
          <SystemStatusPage isAdmin={Boolean(user?.isAdmin)} />
        ) : view === "models" ? (
          <ModelsPage config={config} onChanged={() => { void api.config().then(setConfig); }} />
        ) : view === "workspaces" ? (
          <WorkspacesPage config={config} runs={runs} onOpenCredentials={() => setView("models")} />
        ) : view === "history" ? (
          <HistoryPage runs={runs} onOpenRun={(id) => { setSelectedId(id); setView("run"); setSidebarOpen(false); }} />
        ) : view === "agile" ? (
          <AgilePage config={config} onOpenRun={(id) => { setSelectedId(id); setView("run"); setSidebarOpen(false); }} />
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

            {decisionBrief ? (
              <DecisionBriefCard
                brief={decisionBrief}
                run={activeRun}
                open={decisionBriefExpanded(activeRun.state, briefCollapsed, terminalStates)}
                onToggle={() => setBriefCollapsed((collapsed) => !collapsed)}
                onContinue={(note) => void handleBriefContinue(note)}
                onAccept={() => void handleBriefAccept()}
                onOpenFinding={(key) => openBriefTarget("review", key)}
                onOpenTab={(target) => openBriefTarget(target)}
              />
            ) : null}

            {activeRun.state === "needs_human" && (
              <HumanInterventionPanel
                run={activeRun}
                events={events}
                user={user}
                draftNote={briefDraft}
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
              <section className="panel flow-panel" id="workflow-topology">
                <div className="panel-head"><div><span className="eyebrow">LIVE ORCHESTRATION</span><h3>{t("topology.title")}</h3></div><div className="live-indicator"><i />LIVE</div></div>
                <div className="flow-wrap">
                  {/* Keyed by run id so each run mounts a fresh React Flow
                      instance: `fitView` only runs on mount, so reusing the
                      instance across a run switch could leave the new topology
                      panned/zoomed off-screen (a blank canvas). */}
                  {/* A compact horizontal padding keeps the six-node pipeline
                      inside the panel at the readable 0.6 minimum zoom. The
                      tall canvas already provides vertical room for the
                      above/below rework arches. */}
                  <ReactFlow key={activeRun.id} nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.6} maxZoom={1.4} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
                    <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#252a31" />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                  {selectedRework && <ReworkDetail detail={selectedRework} onJumpToChat={jumpToChat} onClose={() => setReworkRound(null)} />}
                </div>
              </section>

              <section className="panel detail-panel">
                <div className="detail-tabs">
                  {([
                    ["activity", t("topology.tabs.activity"), Activity],
                    ["agents", `Agents ${activeRun.plan?.tasks.length || ""}`, Bot],
                    ["review", `${t("topology.tabs.review")} ${activeRun.findings.length || ""}`, ShieldCheck],
                    ["diff", "Diff", FileCode2],
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
      </main>
      <CreateRunDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} config={config} recentRuns={runs} onGoWorkspaces={() => { setCreateOpen(false); setView("workspaces"); }} />
    </div>
  );
}
