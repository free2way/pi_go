import type { ModelSelection, Run, RunEvent, RunMergeRecord, RunReleaseRecord, RunReleaseStatus, RunState } from "./types.js";
import { deriveStoryStatus, latestLinkedRun, STORY_STATUSES, type ReleaseDeployRecord, type ReleaseStatus, type StoryStatus } from "./agile.js";

/**
 * Sprint 4 core — pure metrics model for the agile board.
 *
 * The server aggregates raw rows in SQL and hands the (owner-scoped, bounded)
 * result to `shapeMetrics`; every number the UI shows is computed here so it can
 * be unit-tested without a database. Empty or sparse data is always rendered as
 * explicit zeros (`0` / `null`-free) and shaping never throws.
 */

export type StoryStatusCounts = Record<StoryStatus, number>;

export interface StoryMetricInsight {
  storyId: string;
  title: string;
  status: StoryStatus;
  runs: number;
  cost: number;
  findings: { total: number; resolved: number };
  changesRequested: number;
  notConverging: number;
}

export interface CycleTimeSample {
  storyId: string;
  title: string;
  /** Whole seconds from the first linked run's creation to acceptance/completion. */
  seconds: number;
  startedAt: string;
  endedAt: string;
}

export interface CycleTimeStats {
  samples: number;
  /** Empty sample sets render as 0 rather than null/undefined. */
  medianSeconds: number;
  p90Seconds: number;
  items: CycleTimeSample[];
}

export interface UsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  modelCalls: number;
  runs: number;
}

export interface ReworkStats {
  completed: number;
  reworked: number;
  /** `reworked / completed`, explicit 0 when nothing completed. */
  rate: number;
}

export interface ReviewFindingsStats {
  total: number;
  resolved: number;
  notConverging: number;
}

export interface RunOutcomeMix {
  completed: number;
  needs_human: number;
  cancelled: number;
  failed: number;
}

export interface MetricsCore {
  stories: { total: number; completed: number; byStatus: StoryStatusCounts };
  cycleTime: CycleTimeStats;
  rework: ReworkStats;
  usage: UsageTotals;
  costPerCompletedStory: number;
  reviewFindings: ReviewFindingsStats;
  runOutcomes: RunOutcomeMix;
  storyInsights: StoryMetricInsight[];
  runOutcomeUnknown: number;
}

export interface SprintMetrics extends MetricsCore {
  sprintId: string;
  projectId: string;
  name: string;
  status: string;
}

export interface ProjectMetrics extends MetricsCore {
  projectId: string;
  name: string;
  key: string;
}

export interface AgileMetricsResponse {
  generatedAt: string;
  sprints: SprintMetrics[];
  projects: ProjectMetrics[];
}

/** One planning story, flattened to the columns metrics need. */
export interface MetricStory {
  id: string;
  title: string;
  projectId: string;
  sprintId: string | null;
  status: StoryStatus;
  /** Manual block reason (Kanban blocked-management); run-derived reason is read from the run. */
  blockedReason?: string | null;
}

/** One story↔run link: the run document plus when it was linked. */
export interface MetricRun {
  storyId: string;
  run: Run;
  linkedAt: string;
}

/** One relevant review event; only `changes_requested` / `not_converging` matter. */
export interface MetricEvent {
  runId: string;
  type: RunEvent["type"];
}

export function emptyStatusCounts(): StoryStatusCounts {
  const counts = {} as StoryStatusCounts;
  for (const status of STORY_STATUSES) counts[status] = 0;
  return counts;
}

/**
 * Median of a numeric sample. Even counts average the two middle values; an
 * empty sample returns `null` so callers can distinguish "no data" from `0`.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Nearest-rank p90: the `ceil(0.9 * n)`-th value of the ascending sample
 * (1-indexed, clamped). Deterministic and stable for small samples.
 */
export function p90(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(0.9 * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/** Rounds to 6 decimals so float sums/ratios compare predictably. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseTime(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsBetween(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * Shapes already-fetched rows into the metric payload. Runs whose story is not
 * in `stories` are ignored, so callers may pass a superset (the project rollup
 * and each sprint view reuse one fetch).
 */
export function shapeMetrics(stories: MetricStory[], runs: MetricRun[], events: MetricEvent[]): MetricsCore {
  const storyIds = new Set(stories.map((story) => story.id));
  const runsByStory = new Map<string, MetricRun[]>();
  for (const link of runs) {
    if (!storyIds.has(link.storyId)) continue;
    const list = runsByStory.get(link.storyId);
    if (list) list.push(link);
    else runsByStory.set(link.storyId, [link]);
  }
  const eventsByRun = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const list = eventsByRun.get(event.runId);
    if (list) list.push(event);
    else eventsByRun.set(event.runId, [event]);
  }

  const byStatus = emptyStatusCounts();
  const cycleItems: CycleTimeSample[] = [];
  const storyInsights: StoryMetricInsight[] = [];
  const usage: UsageTotals = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0, runs: 0 };
  const runOutcomes: RunOutcomeMix = { completed: 0, needs_human: 0, cancelled: 0, failed: 0 };
  const reviewFindings: ReviewFindingsStats = { total: 0, resolved: 0, notConverging: 0 };
  let completed = 0;
  let reworked = 0;
  let runOutcomeUnknown = 0;

  for (const story of stories) {
    const links = runsByStory.get(story.id) ?? [];
    const latest = latestLinkedRun(links.map((link) => ({ run: link.run, linkedAt: link.linkedAt })));
    const status = deriveStoryStatus(latest?.run, { blockedReason: story.blockedReason })?.status ?? story.status;
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    let storyCost = 0;
    let storyFindings = 0;
    let storyResolved = 0;
    let storyChangesRequested = 0;
    let storyNotConverging = 0;
    let firstRunAt: number | null = null;

    for (const link of links) {
      const run = link.run;
      const cost = run.usage?.estimatedCost ?? 0;
      storyCost += cost;
      usage.cost += cost;
      usage.inputTokens += run.usage?.inputTokens ?? 0;
      usage.outputTokens += run.usage?.outputTokens ?? 0;
      usage.cacheReadTokens += run.usage?.cacheReadTokens ?? 0;
      usage.modelCalls += run.modelCalls ?? 0;
      usage.runs += 1;

      const findings = run.findings ?? [];
      storyFindings += findings.length;
      storyResolved += findings.filter((finding) => finding.resolved).length;

      for (const event of eventsByRun.get(run.id) ?? []) {
        if (event.type === "review.changes_requested") storyChangesRequested += 1;
        if (event.type === "review.not_converging") storyNotConverging += 1;
      }

      const createdAt = parseTime(run.createdAt);
      if (createdAt !== null && (firstRunAt === null || createdAt < firstRunAt)) firstRunAt = createdAt;

      switch (run.state) {
        case "completed":
        case "needs_human":
        case "cancelled":
        case "failed":
          runOutcomes[run.state as "completed" | "needs_human" | "cancelled" | "failed"] += 1;
          break;
        default:
          runOutcomeUnknown += 1;
          break;
      }
    }

    reviewFindings.total += storyFindings;
    reviewFindings.resolved += storyResolved;
    reviewFindings.notConverging += storyNotConverging;

    if (status === "done") {
      completed += 1;
      if (storyChangesRequested > 0) reworked += 1;
      if (latest && firstRunAt !== null) {
        const endedAt = latest.run.acceptance?.acceptedAt ?? latest.run.updatedAt;
        const ended = parseTime(endedAt);
        if (ended !== null) {
          cycleItems.push({
            storyId: story.id,
            title: story.title,
            seconds: secondsBetween(firstRunAt, ended),
            startedAt: new Date(firstRunAt).toISOString(),
            endedAt: new Date(ended).toISOString(),
          });
        }
      }
    }

    storyInsights.push({
      storyId: story.id,
      title: story.title,
      status,
      runs: links.length,
      cost: round6(storyCost),
      findings: { total: storyFindings, resolved: storyResolved },
      changesRequested: storyChangesRequested,
      notConverging: storyNotConverging,
    });
  }

  usage.cost = round6(usage.cost);
  cycleItems.sort((left, right) => left.storyId.localeCompare(right.storyId));
  storyInsights.sort((left, right) => left.storyId.localeCompare(right.storyId));
  const seconds = cycleItems.map((item) => item.seconds);

  return {
    stories: { total: stories.length, completed, byStatus },
    cycleTime: {
      samples: seconds.length,
      medianSeconds: median(seconds) ?? 0,
      p90Seconds: p90(seconds) ?? 0,
      items: cycleItems,
    },
    rework: { completed, reworked, rate: completed > 0 ? round6(reworked / completed) : 0 },
    usage,
    costPerCompletedStory: completed > 0 ? round6(usage.cost / completed) : 0,
    reviewFindings,
    runOutcomes,
    storyInsights,
    runOutcomeUnknown,
  };
}

/** Type guard/helper kept close to the domain for callers filtering run rows. */
export function isTerminalOutcome(state: RunState): state is "completed" | "needs_human" | "cancelled" | "failed" {
  return state === "completed" || state === "needs_human" || state === "cancelled" || state === "failed";
}

// ---------------------------------------------------------------------------
// Sprint 4 core — release summary + retrospective export.
//
// Both payloads are shaped by the pure helpers below from the same bounded rows
// the metrics endpoint already reads (release's stories, their linked runs and
// only the two review event types). Every optional field (usage, acceptance,
// merge, release) is read defensively so sparse/legacy run documents never
// throw, and empty releases render explicit zeros.

/** The release identity columns the summary/retrospective payloads echo back. */
export interface ReleaseIdentity {
  id: string;
  projectId: string;
  name: string;
  version: string;
  status: ReleaseStatus;
  /** Set once the release was published through the publish action. */
  releasedAt?: string | null;
  releasedBy?: string | null;
  /** Post-publish deploy-hook outcome; `null`/absent before publish. */
  deploy?: ReleaseDeployRecord | null;
}

/** Latest-run snapshot shown next to a release story. */
export interface ReleaseStoryLatestRun {
  runId: string;
  state: RunState;
  round: number;
  maxRounds: number;
  updatedAt: string;
}

/** Acceptance snapshot projection; only present when the latest run carries one. */
export interface ReleaseStoryAcceptance {
  acceptedAt: string;
  acceptedBy: string;
  acknowledgedOpenFindings: boolean;
  resolvedFindings: number;
  remainingFindings: number;
}

/** One release story with its derived outcome and rolled-up counters. */
export interface ReleaseStoryOutcome {
  storyId: string;
  title: string;
  /** Status derived from the latest linked run, falling back to the stored status. */
  status: StoryStatus;
  runs: number;
  /** Absent when the story has no linked run yet. */
  latest?: ReleaseStoryLatestRun;
  /** Absent when the latest run was never accepted. */
  acceptance?: ReleaseStoryAcceptance;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  findings: { total: number; resolved: number };
  changesRequested: number;
  notConverging: number;
  /** Human-readable reason, only set when `status` is `blocked`. */
  blockedReason?: string;
}

/** One developer/reviewer pair used by the release's runs. */
export interface ModelCombination {
  developer: ModelSelection;
  reviewer: ModelSelection;
  runs: number;
  stories: number;
}

export interface ReleaseMergeEntry {
  storyId: string;
  runId: string;
  commit: string;
  strategy: RunMergeRecord["strategy"];
  targetBranch: string;
  mergedAt: string;
  mergedBy: string;
}

export interface ReleaseDeploymentEntry {
  storyId: string;
  runId: string;
  status: RunReleaseStatus;
  environment: string;
  commit: string;
  kind: RunReleaseRecord["kind"];
  requestedAt: string;
  requestedBy: string;
  finishedAt?: string;
  url?: string;
  deploymentId?: string;
}

export interface ReleaseTotals {
  stories: number;
  done: number;
  /** `in_progress` | `in_review` | `awaiting_acceptance`. */
  inProgress: number;
  blocked: number;
  /** `backlog` | `ready`. */
  notStarted: number;
  runs: number;
}

export interface ReleaseSummary {
  releaseId: string;
  projectId: string;
  name: string;
  version: string;
  status: ReleaseStatus;
  releasedAt: string | null;
  releasedBy: string | null;
  deploy: ReleaseDeployRecord | null;
  generatedAt: string;
  stories: ReleaseStoryOutcome[];
  totals: ReleaseTotals;
  usage: UsageTotals;
  modelCombinations: ModelCombination[];
  merges: ReleaseMergeEntry[];
  deployments: ReleaseDeploymentEntry[];
}

/** One story's review footprint, ordered by first run to form a trend. */
export interface ReviewTrendPoint {
  storyId: string;
  title: string;
  total: number;
  resolved: number;
  changesRequested: number;
  notConverging: number;
}

export interface BlockedStoryInsight {
  storyId: string;
  title: string;
  reason: string;
  state: RunState | null;
}

export interface ReleaseRetrospective {
  releaseId: string;
  projectId: string;
  name: string;
  version: string;
  releasedAt: string | null;
  releasedBy: string | null;
  deploy: ReleaseDeployRecord | null;
  generatedAt: string;
  totals: ReleaseTotals;
  cycleTime: CycleTimeStats;
  rework: ReworkStats;
  reviewFindings: ReviewFindingsStats;
  /** Distinct runs that emitted `review.not_converging`. */
  notConvergingRuns: number;
  reviewTrend: ReviewTrendPoint[];
  costPerCompletedStory: number;
  usage: UsageTotals;
  blockedStories: BlockedStoryInsight[];
}

export interface ReleaseShapeInput {
  release: ReleaseIdentity;
  generatedAt: string;
  stories: MetricStory[];
  runs: MetricRun[];
  events: MetricEvent[];
}

interface ReleaseAnalysis {
  core: MetricsCore;
  outcomes: ReleaseStoryOutcome[];
  totals: ReleaseTotals;
  modelCombinations: ModelCombination[];
  merges: ReleaseMergeEntry[];
  deployments: ReleaseDeploymentEntry[];
  blockedStories: BlockedStoryInsight[];
  reviewTrend: ReviewTrendPoint[];
  notConvergingRuns: number;
}

function toReleaseStoryOutcome(
  story: MetricStory,
  links: MetricRun[],
  eventsByRun: Map<string, MetricEvent[]>,
): { outcome: ReleaseStoryOutcome; firstRunAt: number | null; comboRuns: Map<string, number>; notConvergingRunIds: string[] } {
  const latest = latestLinkedRun(links.map((link) => ({ run: link.run, linkedAt: link.linkedAt })));
  const derived = deriveStoryStatus(latest?.run, { blockedReason: story.blockedReason });
  const status = derived?.status ?? story.status;

  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelCalls = 0;
  let findingsTotal = 0;
  let findingsResolved = 0;
  let changesRequested = 0;
  let notConverging = 0;
  let firstRunAt: number | null = null;
  const comboRuns = new Map<string, number>();
  const notConvergingRunIds: string[] = [];

  for (const link of links) {
    const run = link.run;
    cost += run.usage?.estimatedCost ?? 0;
    inputTokens += run.usage?.inputTokens ?? 0;
    outputTokens += run.usage?.outputTokens ?? 0;
    modelCalls += run.modelCalls ?? 0;

    const findings = run.findings ?? [];
    findingsTotal += findings.length;
    findingsResolved += findings.filter((finding) => finding.resolved).length;

    for (const event of eventsByRun.get(run.id) ?? []) {
      if (event.type === "review.changes_requested") changesRequested += 1;
      if (event.type === "review.not_converging") {
        notConverging += 1;
        notConvergingRunIds.push(run.id);
      }
    }

    const createdAt = parseTime(run.createdAt);
    if (createdAt !== null && (firstRunAt === null || createdAt < firstRunAt)) firstRunAt = createdAt;

    const developer = run.developer;
    const reviewer = run.reviewer;
    if (developer?.provider && developer.model && reviewer?.provider && reviewer.model) {
      const key = `${developer.provider}::${developer.model}|${reviewer.provider}::${reviewer.model}`;
      comboRuns.set(key, (comboRuns.get(key) ?? 0) + 1);
    }
  }

  const acceptance = latest?.run.acceptance;
  const outcome: ReleaseStoryOutcome = {
    storyId: story.id,
    title: story.title,
    status,
    runs: links.length,
    ...(latest
      ? {
          latest: {
            runId: latest.run.id,
            state: latest.run.state,
            round: latest.run.round ?? 0,
            maxRounds: latest.run.maxRounds ?? 0,
            updatedAt: latest.run.updatedAt,
          },
        }
      : {}),
    ...(acceptance
      ? {
          acceptance: {
            acceptedAt: acceptance.acceptedAt,
            acceptedBy: acceptance.acceptedBy,
            acknowledgedOpenFindings: Boolean(acceptance.acknowledgedOpenFindings),
            resolvedFindings: acceptance.findings?.resolved?.count ?? 0,
            remainingFindings: acceptance.findings?.remaining?.count ?? 0,
          },
        }
      : {}),
    cost: round6(cost),
    inputTokens,
    outputTokens,
    modelCalls,
    findings: { total: findingsTotal, resolved: findingsResolved },
    changesRequested,
    notConverging,
    ...(status === "blocked" && derived?.reason ? { blockedReason: derived.reason } : {}),
  };
  return { outcome, firstRunAt, comboRuns, notConvergingRunIds };
}

function analyzeRelease(stories: MetricStory[], runs: MetricRun[], events: MetricEvent[]): ReleaseAnalysis {
  const core = shapeMetrics(stories, runs, events);
  const storyIds = new Set(stories.map((story) => story.id));
  const runsByStory = new Map<string, MetricRun[]>();
  for (const link of runs) {
    if (!storyIds.has(link.storyId)) continue;
    const list = runsByStory.get(link.storyId);
    if (list) list.push(link);
    else runsByStory.set(link.storyId, [link]);
  }
  const eventsByRun = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const list = eventsByRun.get(event.runId);
    if (list) list.push(event);
    else eventsByRun.set(event.runId, [event]);
  }

  const totals: ReleaseTotals = { stories: stories.length, done: 0, inProgress: 0, blocked: 0, notStarted: 0, runs: 0 };
  const combos = new Map<string, { developer: ModelSelection; reviewer: ModelSelection; runs: number; stories: number }>();
  const merges: ReleaseMergeEntry[] = [];
  const deployments: ReleaseDeploymentEntry[] = [];
  const blockedStories: BlockedStoryInsight[] = [];
  const notConvergingRunIds = new Set<string>();
  const analyzed: Array<{
    outcome: ReleaseStoryOutcome;
    firstRunAt: number | null;
    comboRuns: Map<string, number>;
    notConvergingRunIds: string[];
  }> = [];

  for (const story of stories) {
    const links = runsByStory.get(story.id) ?? [];
    const result = toReleaseStoryOutcome(story, links, eventsByRun);
    analyzed.push(result);
    totals.runs += links.length;

    switch (result.outcome.status) {
      case "done":
        totals.done += 1;
        break;
      case "blocked":
        totals.blocked += 1;
        blockedStories.push({
          storyId: story.id,
          title: story.title,
          reason: result.outcome.blockedReason?.trim() || "运行阻塞，等待人工处理",
          state: result.outcome.latest?.state ?? null,
        });
        break;
      case "in_progress":
      case "in_review":
      case "awaiting_acceptance":
        totals.inProgress += 1;
        break;
      default:
        totals.notStarted += 1;
        break;
    }

    for (const [key, runCount] of result.comboRuns) {
      const existing = combos.get(key);
      if (existing) {
        existing.runs += runCount;
        existing.stories += 1;
      } else {
        const [developer, reviewer] = key.split("|");
        const [devProvider, devModel] = developer.split("::");
        const [revProvider, revModel] = reviewer.split("::");
        combos.set(key, {
          developer: { provider: devProvider, model: devModel },
          reviewer: { provider: revProvider, model: revModel },
          runs: runCount,
          stories: 1,
        });
      }
    }
    for (const runId of result.notConvergingRunIds) notConvergingRunIds.add(runId);

    for (const link of links) {
      const merge = link.run.merge;
      if (merge?.commit) {
        merges.push({
          storyId: story.id,
          runId: link.run.id,
          commit: merge.commit,
          strategy: merge.strategy,
          targetBranch: merge.targetBranch,
          mergedAt: merge.mergedAt,
          mergedBy: merge.mergedBy,
        });
      }
      const release = link.run.release;
      if (release?.commit) {
        deployments.push({
          storyId: story.id,
          runId: link.run.id,
          status: release.status,
          environment: release.environment,
          commit: release.commit,
          kind: release.kind,
          requestedAt: release.requestedAt,
          requestedBy: release.requestedBy,
          ...(release.finishedAt ? { finishedAt: release.finishedAt } : {}),
          ...(release.url ? { url: release.url } : {}),
          ...(release.deploymentId ? { deploymentId: release.deploymentId } : {}),
        });
      }
    }
  }

  analyzed.sort((left, right) => {
    const leftAt = left.firstRunAt ?? Number.POSITIVE_INFINITY;
    const rightAt = right.firstRunAt ?? Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return left.outcome.storyId.localeCompare(right.outcome.storyId);
  });

  merges.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt) || left.runId.localeCompare(right.runId));
  deployments.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || left.runId.localeCompare(right.runId));
  blockedStories.sort((left, right) => left.storyId.localeCompare(right.storyId));

  return {
    core,
    outcomes: analyzed.map((entry) => entry.outcome),
    totals,
    modelCombinations: [...combos.values()].sort(
      (left, right) =>
        left.developer.provider.localeCompare(right.developer.provider) ||
        left.developer.model.localeCompare(right.developer.model) ||
        left.reviewer.provider.localeCompare(right.reviewer.provider) ||
        left.reviewer.model.localeCompare(right.reviewer.model),
    ),
    merges,
    deployments,
    blockedStories,
    reviewTrend: analyzed.map((entry) => ({
      storyId: entry.outcome.storyId,
      title: entry.outcome.title,
      total: entry.outcome.findings.total,
      resolved: entry.outcome.findings.resolved,
      changesRequested: entry.outcome.changesRequested,
      notConverging: entry.outcome.notConverging,
    })),
    notConvergingRuns: notConvergingRunIds.size,
  };
}

/** Pure release summary: per-story outcomes, totals, cost/tokens, model pairs, merges/deploys. */
export function shapeReleaseSummary(input: ReleaseShapeInput): ReleaseSummary {
  const analysis = analyzeRelease(input.stories, input.runs, input.events);
  return {
    releaseId: input.release.id,
    projectId: input.release.projectId,
    name: input.release.name,
    version: input.release.version,
    status: input.release.status,
    releasedAt: input.release.releasedAt ?? null,
    releasedBy: input.release.releasedBy ?? null,
    deploy: input.release.deploy ?? null,
    generatedAt: input.generatedAt,
    stories: analysis.outcomes,
    totals: analysis.totals,
    usage: analysis.core.usage,
    modelCombinations: analysis.modelCombinations,
    merges: analysis.merges,
    deployments: analysis.deployments,
  };
}

/** Pure retrospective: cycle time, rework, review trend, blocked stories, cost/story. */
export function shapeReleaseRetrospective(input: ReleaseShapeInput): ReleaseRetrospective {
  const analysis = analyzeRelease(input.stories, input.runs, input.events);
  return {
    releaseId: input.release.id,
    projectId: input.release.projectId,
    name: input.release.name,
    version: input.release.version,
    releasedAt: input.release.releasedAt ?? null,
    releasedBy: input.release.releasedBy ?? null,
    deploy: input.release.deploy ?? null,
    generatedAt: input.generatedAt,
    totals: analysis.totals,
    cycleTime: analysis.core.cycleTime,
    rework: analysis.core.rework,
    reviewFindings: analysis.core.reviewFindings,
    notConvergingRuns: analysis.notConvergingRuns,
    reviewTrend: analysis.reviewTrend,
    costPerCompletedStory: analysis.core.costPerCompletedStory,
    usage: analysis.core.usage,
    blockedStories: analysis.blockedStories,
  };
}
