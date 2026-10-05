import type { Run, RunState, RunEvent } from "./types.js";
import { deriveStoryStatus, latestLinkedRun, STORY_STATUSES, type StoryStatus } from "./agile.js";

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
    const status = deriveStoryStatus(latest?.run)?.status ?? story.status;
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
