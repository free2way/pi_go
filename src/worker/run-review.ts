import path from "node:path";
import type { Run } from "../shared/types.js";
import { runChecks as runCheckSuite } from "./checks.js";
import { toRunUsage, type UsageTotals } from "./pi-events.js";
import type { RunBudgetContext } from "./run-budget.js";
import { scrubEnvironment } from "./pi-env.js";
import type { ReviewResult } from "./review-protocol.js";
import { blockingFindings, deferredFindings, deferredMessage, isDeferral, resolveReviewScope, shouldAcceptRound } from "./review-scope.js";
import { mergeFindings } from "./review-findings.js";
import { buildSnapshotDivergenceFinding, destroyReviewSnapshot, evaluateSnapshotDivergence, reviewSnapshotDirectory, type MaterializedReviewSnapshot } from "./review-snapshot.js";
import {
  CHECKS_BLOCKED_RETRY_SUMMARY,
  changesRequestedRetryText,
  checksBlockedRetryText,
  completionBlockedApprovedText,
  COMPLETION_BLOCKED_UNRESOLVED_SUMMARY,
  guardText,
  runLocale,
  SNAPSHOT_DIVERGED_SUMMARY,
  SNAPSHOT_FAILED_SUMMARY,
  snapshotDivergedText,
  snapshotFailedText,
} from "./runtime-locale.js";
import { persistDiffArtifact } from "./diff-artifacts.js";
import { SessionAccumulator } from "./pi-session.js";
import { recordVerdictThenReviewTriage } from "./decision-triage.js";
import { assertSandboxReady, sandboxMode, materializeReviewSnapshot, diagnosticMessage, workspaceRoot, type JobInput } from "./worker-runtime.js";
import { runInSandbox, repositoryForWorktree, sandboxEnvironment, command, snapshotHash } from "./worker-process.js";
import { update, postUpdate, chat, triggerReviewTriage } from "./worker-web-client.js";
import { commitRoundWork, collectDiff } from "./worker-git.js";

export async function runChecks(run: Run, worktree: string, commands: string[], signal: AbortSignal, credentials: JobInput["credentials"]) {
  // Delegates to the extracted suite so check execution, cancellation handling
  // and the structured `checks` chat entries are unit-tested in one place.
  return runCheckSuite({
    commands,
    signal,
    secrets: [
      ...Object.values(credentials),
      ...Object.entries(process.env)
        .filter(([name]) => scrubEnvironment({ [name]: process.env[name] })[name] === undefined)
        .map(([, value]) => value ?? ""),
    ],
    execute: async (checkCommand, execSignal) => {
      // P1 (fail-closed): checks execute untrusted repository commands, so they
      // must never silently fall back to an in-process shell.
      assertSandboxReady();
      // SEC-004/010: check commands run with the worker's secrets stripped, so a
      // malicious check cannot read the internal callback token or provider keys.
      return sandboxMode === "container"
        ? await runInSandbox({
            argv: ["/bin/sh", "-lc", checkCommand],
            worktree,
            repository: await repositoryForWorktree(worktree),
            env: sandboxEnvironment({}),
            network: "none",
            timeoutMs: 600_000,
            signal: execSignal,
            label: "check",
            ephemeralState: true,
          })
        : await command("/bin/sh", ["-lc", checkCommand], {
            cwd: worktree,
            signal: execSignal,
            timeoutMs: 600_000,
            env: scrubEnvironment(process.env),
          });
    },
    started: (checks, checkCommand) =>
      update(run, "checking", "checks", "check.started", `执行检查：${checkCommand}`, { checks }),
    finished: (checks, checkCommand, passed) =>
      postUpdate(run.id, {
        patch: { checks },
        event: { round: run.round, source: "checks", type: passed ? "check.passed" : "check.failed", message: `${checkCommand} ${passed ? "通过" : "失败"}` },
      }),
    chat: (payload) => chat(run, payload.channel, payload.from, payload.to, payload.role, payload.content, signal),
  });
}

export type ReviewOutcome = { stopped: true } | { stopped: false; review: ReviewResult };

/**
 * GAP-03: materialize and verify the reviewer's immutable snapshot before the
 * review phase. Returns the snapshot directory to review, or `undefined` when
 * the run was escalated (snapshot creation failed, or the developer tree moved
 * under the snapshot). The live worktree is never handed to the reviewer.
 */
export async function prepareReviewSnapshot(input: {
  run: Run;
  worktree: string;
  round: number;
  signal: AbortSignal;
  credentials: JobInput["credentials"];
}): Promise<string | undefined> {
  const { run, round } = input;
  const directory = reviewSnapshotDirectory(input.worktree, round);
  let materialized: MaterializedReviewSnapshot;
  try {
    materialized = await materializeReviewSnapshot({ worktree: input.worktree, snapshotDir: directory, signal: input.signal });
  } catch (error) {
    await destroyReviewSnapshot(directory);
    const snapshotFailed = guardText(snapshotFailedText(diagnosticMessage(error, Object.values(input.credentials), 300)), runLocale(run));
    await update(run, "needs_human", "reviewer", "review.snapshot_failed", snapshotFailed.message, {
      summary: guardText(SNAPSHOT_FAILED_SUMMARY, runLocale(run)).message,
    }, { meta: snapshotFailed.meta });
    return undefined;
  }
  const decision = evaluateSnapshotDivergence(materialized);
  const evidence = {
    round,
    developerTree: materialized.developerTreeHash,
    developerTreeAfter: materialized.developerTreeHashAfter,
    snapshotTree: materialized.snapshotTreeHash,
    directory: path.relative(workspaceRoot, directory),
    diverged: decision.divergent,
    at: new Date().toISOString(),
  };
  await postUpdate(run.id, {
    event: {
      round,
      source: "reviewer",
      type: "review.snapshot_created",
      message: `已创建第 ${round} 轮审核只读快照（tree ${materialized.snapshotTreeHash.slice(0, 12)}）${decision.divergent ? "：与开发 worktree 不一致" : ""}`,
      meta: evidence,
    },
  });
  if (decision.divergent) {
    // GAP-03: reviewing a different tree is never allowed, so this is a
    // blocking escalation rather than a warning.
    const findings = mergeFindings(run.findings ?? [], [buildSnapshotDivergenceFinding(round, decision.reasons)]);
    await destroyReviewSnapshot(directory);
    const locale = runLocale(run);
    const diverged = guardText(snapshotDivergedText(decision.reasons.join(locale === "en" ? "; " : "；")), locale);
    await update(run, "needs_human", "reviewer", "review.snapshot_diverged", diverged.message, {
      findings,
      summary: guardText(SNAPSHOT_DIVERGED_SUMMARY, locale).message,
    }, { meta: diverged.meta });
    return undefined;
  }
  return directory;
}

export interface ReviewInput {
  run: Run;
  /** GAP-03: immutable snapshot directory the reviewer reads (never the live worktree). */
  snapshotPath: string;
  credentials: JobInput["credentials"];
  round: number;
  diff: string;
  signal: AbortSignal;
  usage: UsageTotals;
  started: number;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
}

export type ReviewRun = (input: ReviewInput) => Promise<ReviewOutcome>;

/** Human-triggered re-review: no development happens, the reviewer checks the current worktree again. */
export async function executeRetryReview(input: {
  run: Run;
  worktree: string;
  baseCommit: string;
  credentials: JobInput["credentials"];
  controller: AbortController;
  usage: UsageTotals;
  started: number;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
  checks: string[];
}, performReview: ReviewRun) {
  const { run } = input;
  // E2E-01b: a retry-review (human-triggered re-review) can precede a merge, and
  // it never runs a developer stage, so the worktree may still hold uncommitted
  // work (e.g. a run started before this fix, or a resume with manual edits).
  // Commit it onto the run branch before the checks/diff/review artifacts so the
  // reviewed snapshot is exactly what the merge will fetch.
  await commitRoundWork(run, input.worktree, run.round, input.controller.signal);
  // AUD-04 / AT-RUN-007 / CHECK-003: an approval may only be produced for a
  // snapshot whose required checks passed. Re-run them here instead of trusting
  // a previous round or manual edits.
  await update(run, "checking", "checks", "checks.started", "重新审核前先复验当前代码快照", { summary: "正在复验检查命令" });
  const checked = await runChecks(run, input.worktree, input.checks, input.controller.signal, input.credentials);
  const checkSnapshot = await snapshotHash(input.worktree, input.controller.signal);
  await postUpdate(run.id, { patch: { checks: checked.results, checkSnapshot, checkPassed: checked.passed } });
  if (!checked.passed) {
    const failed = checked.results.filter((item) => item.status === "failed").map((item) => item.command);
    const locale = runLocale(run);
    const blocked = guardText(checksBlockedRetryText(failed.join(" / ")), locale);
    await update(run, "needs_human", "checks", "checks.blocked_retry_review", blocked.message, {
      summary: guardText(CHECKS_BLOCKED_RETRY_SUMMARY, locale).message,
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
    }, { meta: blocked.meta });
    return;
  }
  const diff = await collectDiff(input.worktree, input.controller.signal, input.baseCommit);
  const reviewSnapshot = await snapshotHash(input.worktree, input.controller.signal);
  // NEW-07: durable full-diff artifact for the retry-review path too.
  const retryDiffArtifact = await persistDiffArtifact(input.worktree, diff, run.round);
  // GAP-03: the reviewer reads an immutable snapshot, never the live worktree.
  const snapshotPath = await prepareReviewSnapshot({ run, worktree: input.worktree, round: run.round, signal: input.controller.signal, credentials: input.credentials });
  if (!snapshotPath) return;
  await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 重新审核（人工触发）`, { summary: "Reviewer Agent 正在重新审核" });
  let outcome: ReviewOutcome;
  try {
    outcome = await performReview({
      run,
      snapshotPath,
      credentials: input.credentials,
      round: run.round,
      diff,
      signal: input.controller.signal,
      usage: input.usage,
      started: input.started,
      budget: input.budget,
      sessions: input.sessions,
    });
  } finally {
    // AT-REVIEW-012: the one-shot snapshot (and its Pi state) is discarded after
    // the review, so the reviewer can never leave files behind.
    await destroyReviewSnapshot(snapshotPath);
  }
  if (outcome.stopped) return;
  const review = outcome.review;
  const findings = mergeFindings(run.findings ?? [], review.findings, { approved: review.verdict === "approved" });
  const scope = resolveReviewScope(run);
  const blocking = blockingFindings(findings, scope);
  if (shouldAcceptRound({ verdict: review.verdict, scope, blocking })) {
    if (blocking.length > 0) {
      const locale = runLocale(run);
      const blocked = guardText(completionBlockedApprovedText(blocking.length), locale);
      await update(run, "needs_human", "system", "run.completion_blocked", blocked.message, {
        findings,
        diff,
        checkSnapshot,
        reviewSnapshot,
        summary: guardText(COMPLETION_BLOCKED_UNRESOLVED_SUMMARY, locale).message,
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
      }, { diffArtifact: retryDiffArtifact, meta: blocked.meta });
      return;
    }
    const deferred = deferredFindings(findings, scope);
    if (isDeferral(scope, deferred)) {
      await postUpdate(run.id, {
        event: {
          round: run.round,
          source: "reviewer",
          type: "review.nonblocking_deferred",
          message: deferredMessage(run.round, deferred),
          meta: { round: run.round, scope, count: deferred.length, ids: deferred.map((finding) => finding.id) },
        },
      });
    }
    await recordVerdictThenReviewTriage({
      runId: run.id,
      recordVerdict: () => update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
        findings,
        diff,
        checkSnapshot,
        reviewSnapshot,
        checkPassed: true,
        summary: review.summary,
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
      }, { diffArtifact: retryDiffArtifact }),
      trigger: triggerReviewTriage,
    });
    return;
  }
  const retryReviewLocale = runLocale(run);
  const changesRequested = guardText(changesRequestedRetryText(review.findings.length), retryReviewLocale);
  // docs/26 §9.1: the verdict is recorded first; the (opt-in) shadow triage runs
  // strictly after it and can never change or delay this outcome.
  await recordVerdictThenReviewTriage({
    runId: run.id,
    recordVerdict: () => update(run, "needs_human", "reviewer", "review.changes_requested", changesRequested.message, {
      findings,
      diff,
      checkSnapshot,
      reviewSnapshot,
      summary: review.summary,
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
    }, { diffArtifact: retryDiffArtifact, meta: changesRequested.meta }),
    trigger: triggerReviewTriage,
  });
}
