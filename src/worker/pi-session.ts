import type { RunSessionSummary } from "../shared/types.js";
import type { PiUsage } from "./pi-events.js";

/**
 * Sprint 2 phase 1: a first-class Pi *session* abstraction.
 *
 * Today every Pi invocation is spawned with a `--session-id` (the developer
 * reuses one across repair rounds so the implementation context survives; the
 * reviewer is independent per round and the planner is stateless). That decision
 * lived inline in `index.ts`. `planPiSession` makes it a pure, testable function
 * and `PiSessionManager` instruments the call so per-session reuse/latency can be
 * surfaced in the run audit and (later) the UI.
 *
 * The session id used for Pi is *derived from the run id* exactly as before, so
 * this module changes no CLI behaviour — it only names and measures it:
 *
 * | role        | Pi session            | resume                       |
 * | ----------- | --------------------- | ---------------------------- |
 * | planner     | none (`--no-session`) | never (stateless)            |
 * | developer   | `<run>-developer`     | round > 1 (repair reuse)     |
 * | integrator  | `<run>-integrator`    | round > 1                    |
 * | sub-agent   | `<run>-sub-<taskId>`  | round > 1                    |
 * | reviewer    | none (`--no-session`) | never (fresh per round)      |
 */
export type PiSessionRole = "planner" | "developer" | "sub-agent" | "integrator" | "reviewer";

/** Roles whose Pi session is allowed to survive a repair round (COST-004). */
const statefulRoles: readonly PiSessionRole[] = ["developer", "integrator", "sub-agent"];

export interface PiSessionPlanInput {
  role: PiSessionRole;
  /** Run document id, e.g. `run_9c8e4730ae17406b`. */
  run: string;
  round: number;
  /**
   * An explicit protocol re-ask (reviewer retry) is a fresh call, never a
   * resume of the previous attempt.
   */
  retry?: boolean;
  /**
   * Session key for a stateful role. Defaults to the role name so
   * `developer`/`integrator` keep their historical ids; sub-agents pass
   * `sub-<taskId>`.
   */
  key?: string;
}

export interface PiSessionPlan {
  role: PiSessionRole;
  round: number;
  /** Value passed to Pi as `--session-id`; undefined means `--no-session`. */
  sessionId?: string;
  /** Stable logical id used in metrics/summaries (always defined). */
  metricsId: string;
  /** Pi continues a session created by an earlier invocation. */
  resume: boolean;
  /** This invocation must not continue any prior session. */
  fresh: boolean;
}

function dashedRunId(run: string): string {
  return run.replaceAll("_", "-");
}

/**
 * Pure decision for one Pi invocation. `planner` is stateless; `reviewer` is
 * independent per round (and per protocol retry); stateful roles reuse one
 * session id across the repair rounds of the same run.
 */
export function planPiSession(input: PiSessionPlanInput): PiSessionPlan {
  const prefix = dashedRunId(input.run);
  const round = Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1;
  if (input.role === "planner") {
    return { role: input.role, round, metricsId: `${prefix}-plan`, resume: false, fresh: true };
  }
  if (input.role === "reviewer") {
    const suffix = input.retry ? "-retry" : "";
    return { role: input.role, round, metricsId: `${prefix}-review-r${round}${suffix}`, resume: false, fresh: true };
  }
  const key = input.key && input.key.trim() ? input.key.trim() : input.role;
  const sessionId = `${prefix}-${key}`;
  const resume = round > 1 && !input.retry;
  return { role: input.role, round, sessionId, metricsId: sessionId, resume, fresh: !resume };
}

/** True when the role keeps a Pi session across repair rounds. */
export function isStatefulPiSessionRole(role: PiSessionRole): boolean {
  return statefulRoles.includes(role);
}

/** One instrumented Pi invocation, aggregated into a run session summary. */
export interface SessionMetrics {
  sessionId: string;
  role: PiSessionRole;
  round: number;
  resumed: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCalls: number;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Builds the per-invocation metrics from the plan and the provider usage the
 * existing `UsageTracker` already collected. This is a *view* of the same
 * numbers that flow into `run.usage`; it is never added to them again, so
 * token totals cannot be double counted.
 */
export function buildSessionMetrics(
  plan: PiSessionPlan,
  durationMs: number,
  usage: PiUsage,
  modelCalls: number,
): SessionMetrics {
  return {
    sessionId: plan.metricsId,
    role: plan.role,
    round: plan.round,
    resumed: plan.resume,
    durationMs: nonNegativeInt(durationMs),
    inputTokens: nonNegativeInt(usage.input),
    outputTokens: nonNegativeInt(usage.output),
    cacheReadTokens: nonNegativeInt(usage.cacheRead),
    cacheWriteTokens: nonNegativeInt(usage.cacheWrite),
    modelCalls: nonNegativeInt(modelCalls),
  };
}

/**
 * Merges one invocation's metrics into the run's session summaries. Summaries
 * are keyed by `sessionId`, so a reused developer session accumulates across
 * rounds while a per-round reviewer session stays a separate entry.
 *
 * Returns a *new* array (the caller persists it as the additive `sessions` patch
 * on the run document). Because the whole array is written every time, an
 * at-least-once event delivery cannot double count: a re-applied patch replaces
 * its own previous value instead of summing it in.
 */
export function mergeSessionMetrics(
  existing: RunSessionSummary[] | undefined,
  metrics: SessionMetrics,
  at: string,
): RunSessionSummary[] {
  const summaries = (existing ?? []).map((entry) => ({
    ...entry,
    rounds: [...entry.rounds],
  }));
  const index = summaries.findIndex((entry) => entry.sessionId === metrics.sessionId);
  if (index === -1) {
    summaries.push({
      sessionId: metrics.sessionId,
      role: metrics.role,
      rounds: [metrics.round],
      calls: 1,
      resumed: metrics.resumed,
      durationMs: metrics.durationMs,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      modelCalls: metrics.modelCalls,
      firstAt: at,
      lastAt: at,
    });
    return summaries;
  }
  const current = summaries[index];
  const rounds = current.rounds.includes(metrics.round) ? current.rounds : [...current.rounds, metrics.round].sort((a, b) => a - b);
  summaries[index] = {
    ...current,
    rounds,
    calls: current.calls + 1,
    resumed: current.resumed || metrics.resumed,
    durationMs: current.durationMs + metrics.durationMs,
    inputTokens: current.inputTokens + metrics.inputTokens,
    outputTokens: current.outputTokens + metrics.outputTokens,
    cacheReadTokens: current.cacheReadTokens + metrics.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + metrics.cacheWriteTokens,
    modelCalls: current.modelCalls + metrics.modelCalls,
    firstAt: current.firstAt || at,
    lastAt: at,
  };
  return summaries;
}

/**
 * Mutable accumulator for one job. Seeded from the persisted run document so a
 * worker restart resumes the per-session totals instead of resetting them.
 */
export class SessionAccumulator {
  private state: RunSessionSummary[];

  constructor(initial: RunSessionSummary[] | undefined = undefined) {
    this.state = (initial ?? []).map((entry) => ({ ...entry, rounds: [...entry.rounds] }));
  }

  merge(metrics: SessionMetrics, at: string): RunSessionSummary[] {
    this.state = mergeSessionMetrics(this.state, metrics, at);
    return this.snapshot();
  }

  snapshot(): RunSessionSummary[] {
    return this.state.map((entry) => ({ ...entry, rounds: [...entry.rounds] }));
  }
}

/** Result of one transport invocation: the caller's value plus usage evidence. */
export interface PiSessionCallResult<T> {
  result: T;
  usage: PiUsage;
  /** Provider attempts made during this invocation (retries included). */
  modelCalls: number;
}

/**
 * Documented seam for a future Pi RPC/SDK transport. Today only the CLI
 * transport exists: it simply executes the supplied callback, which is what
 * `runPi` does (spawn the Pi CLI with the resolved `--session-id`). A future
 * transport can talk to a long-lived Pi process/session without changing
 * `PiSessionManager` or the metric emission.
 */
export interface PiSessionTransport {
  readonly kind: "cli" | "rpc";
  invoke<T>(plan: PiSessionPlan, call: () => Promise<PiSessionCallResult<T>>): Promise<PiSessionCallResult<T>>;
}

/** The only wired transport: wrap the existing CLI invocation. */
export function createCliTransport(): PiSessionTransport {
  return {
    kind: "cli",
    invoke: (_plan, call) => call(),
  };
}

/** Throws: no RPC/SDK transport exists yet (see `PiSessionTransport`). */
export function createRpcTransport(): PiSessionTransport {
  throw new Error(
    "PiSessionTransport rpc is not implemented: PiGO still spawns the Pi CLI per invocation. " +
      "Use createCliTransport() until an RPC/SDK transport is available.",
  );
}

export interface PiSessionExecuteInput<T> {
  plan: PiSessionPlan;
  signal: AbortSignal;
  onActivity: (message: string) => Promise<void>;
  /** Performs the underlying call with the plan's resolved CLI session id. */
  invoke: (
    sessionId: string | undefined,
    signal: AbortSignal,
    onActivity: (message: string) => Promise<void>,
  ) => Promise<PiSessionCallResult<T>>;
  /** Called once per invocation with the aggregated metrics. */
  onMetrics: (metrics: SessionMetrics) => Promise<void> | void;
}

/** Runs one Pi invocation and reports its session metrics. */
export interface PiSessionManager {
  readonly transport: PiSessionTransport;
  execute<T>(input: PiSessionExecuteInput<T>): Promise<PiSessionCallResult<T>>;
}

/**
 * CLI-backed manager. It adds instrumentation only: the transport still runs the
 * supplied CLI callback with the same session id the previous inline code used.
 */
export class CliSessionManager implements PiSessionManager {
  readonly transport: PiSessionTransport;

  constructor(transport: PiSessionTransport = createCliTransport()) {
    this.transport = transport;
  }

  async execute<T>(input: PiSessionExecuteInput<T>): Promise<PiSessionCallResult<T>> {
    const started = Date.now();
    const result = await this.transport.invoke(input.plan, () =>
      input.invoke(input.plan.sessionId, input.signal, input.onActivity),
    );
    const metrics = buildSessionMetrics(input.plan, Date.now() - started, result.usage, result.modelCalls);
    await input.onMetrics(metrics);
    return result;
  }
}
