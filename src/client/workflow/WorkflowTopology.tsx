import { Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { Check, CheckCircle2, Code2, CornerDownLeft, GitPullRequestArrow, ListChecks, LoaderCircle, Rocket, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { useT, type TFunction } from "../i18n";
import { reworkBranchRounds } from "../../shared/chat";
import { branchStatus, currentRoundStatus, roundStatuses, roundStatusMeta, type RoundStatus } from "../../shared/round-status";
import type { RoundSummary, Run, RunEvent, RunState } from "../../shared/types";
import { resolveReworkRounds, resolveRoundStatuses, roundStatusKey } from "../rounds-view";
import { reworkBranchLayout, reworkBranchPath, type ReworkSide } from "../rework-layout";

import type { ReactNode } from "react";
import { terminalStates } from "./display";

type FlowNodeData = {
  label: string;
  caption: string;
  kind: "task" | "developer" | "checks" | "reviewer" | "complete" | "release";
  status: "waiting" | "active" | "done" | "warning";
  meta?: string;
  /** Live workflow status of the round this node represents. */
  roundStatus?: RoundStatus;
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


export function WorkflowTopology({ run, events, selectedReworkRound, onReworkSelect, roundSummaries, children }: {
  run: Run;
  events: RunEvent[];
  selectedReworkRound: number | null;
  onReworkSelect: (round: number) => void;
  roundSummaries: RoundSummary[] | undefined;
  children: ReactNode;
}) {
  const { t } = useT();
  const flow = useMemo(
    () => flowForRun(run, events, { selectedReworkRound, onReworkSelect, roundSummaries, t }),
    [run, events, selectedReworkRound, onReworkSelect, roundSummaries, t],
  );

  return (
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
        <ReactFlow key={run.id} nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.6} maxZoom={1.4} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#252a31" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {children}
      </div>
    </section>
  );
}
