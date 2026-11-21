import { stat } from "node:fs/promises";
import path from "node:path";
import type { DevelopmentPlan, Finding, Run, RunState } from "../shared/types.js";
import { isCheckpointCurrent, stages, type CheckpointTracker, type StoredChecks, type StoredReview } from "./checkpoints.js";
import { toRunUsage, type UsageTotals } from "./pi-events.js";
import { readBudgetLimits } from "./budget.js";
import { BudgetExceededError, createRunBudget, type RunBudgetContext } from "./run-budget.js";
import { classifyProviderError, providerErrorSummary } from "./provider-errors.js";
import { sleep } from "./provider-retry.js";
import type { ReviewResult } from "./review-protocol.js";
import { convergenceStop } from "./review-convergence.js";
import { PiInputTransportError } from "./pi-cli-input.js";
import { blockingFindings, deferredFindings, deferredMessage, isDeferral, resolveReviewScope, shouldAcceptRound } from "./review-scope.js";
import { SandboxUnavailableError } from "./sandbox.js";
import { mergeFindings, repeatedSevereFindings, severeRepeatThreshold, unresolvedFeedback } from "./review-findings.js";
import { destroyReviewSnapshot } from "./review-snapshot.js";
import { migrateLegacySubAgentState } from "./subagent-state.js";
import { planRecovery, recoveryResumePhase, recoveryUpdateState } from "./run-recovery.js";
import {
  CANCELLED_SUMMARY,
  CANCELLED_TEXT,
  changesRequestedText,
  completionBlockedText,
  COMPLETION_BLOCKED_SUMMARY,
  budgetExhaustedText,
  deadlineExceededText,
  guardText,
  MAX_ROUNDS_TEXT,
  PI_INPUT_TRANSPORT_TEXT,
  runFailureText,
  runLocale,
  SANDBOX_UNAVAILABLE_SUMMARY,
  severeRepeatLabels,
  severeRepeatSummary,
  severeRepeatText,
  storageErrorText,
  type LocalizedText,
} from "./runtime-locale.js";
import { persistDiffArtifact } from "./diff-artifacts.js";
import { startRunDeadline } from "./run-deadline.js";
import { detectProjectPlugins } from "./plugin-policy.js";
import { SessionAccumulator } from "./pi-session.js";
import { recordVerdictThenReviewTriage } from "./decision-triage.js";
import {
  assertSandboxReady,
  sandboxMode,
  sandboxDegraded,
  sandboxReason,
  runsRoot,
  workspaceRoot,
  allowProjectPlugins,
  reviewConvergenceGuardEnabled,
  reviewStallRoundsThreshold,
  diagnosticMessage,
  active,
  type JobInput,
} from "./worker-runtime.js";
import { git, snapshotHash } from "./worker-process.js";
import { loadTracker, postUpdate, startJobHeartbeat, update, chat, triggerReviewTriage, jobApi } from "./worker-web-client.js";
import { resolveProject, prepareRunDirectory, commitRoundWork, collectDiff } from "./worker-git.js";
import { executeRetryReview, runChecks, prepareReviewSnapshot, type ReviewOutcome, type ReviewRun } from "./run-review.js";

export interface DevelopmentRoundInput {
  job: JobInput;
  run: Run;
  worktree: string;
  controller: AbortController;
  tracker: CheckpointTracker;
  usage: UsageTotals;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
  round: number;
  firstRound: number;
  humanInstruction?: string;
  plan?: DevelopmentPlan;
  feedback: string;
  findings: Finding[];
}

interface RunActions {
  developRound: (input: DevelopmentRoundInput) => Promise<Pick<DevelopmentRoundInput, "plan" | "feedback" | "findings">>;
  performReview: ReviewRun;
}

function usageFromRun(documentUsage: Run["usage"] | undefined): UsageTotals {
  return {
    input: documentUsage?.inputTokens ?? 0,
    output: documentUsage?.outputTokens ?? 0,
    cacheRead: documentUsage?.cacheReadTokens ?? 0,
    cacheWrite: documentUsage?.cacheWriteTokens ?? 0,
    totalTokens: documentUsage?.totalTokens ?? 0,
    cost: documentUsage?.estimatedCost ?? 0,
  };
}

export async function executeJob(input: JobInput, controller: AbortController, actions: RunActions) {
  const run = input.run;
  const started = Date.now();
  // AUD-10: resumes, worker restarts and human continuations accumulate into the
  // persisted usage instead of resetting it.
  const usage: UsageTotals = usageFromRun(run.usage);
  // Sprint 2: per-session summary, seeded from the run document so a restart
  // resumes the totals instead of resetting them.
  const sessions = new SessionAccumulator(run.sessions);
  const tracker = await loadTracker(run.id, input.credentials);
  // COST-002/003: budgets are evaluated before every model call and after each
  // one, with a single 80% warning per dimension.
  const runLimits = run.budget ?? readBudgetLimits();
  const budget = createRunBudget({
    run,
    startedAt: started,
    limits: runLimits,
    usage: () => toRunUsage(usage),
    persist: (patch) => { void postUpdate(run.id, { patch }).catch(() => undefined); },
    onWarning: async (message) => {
      await postUpdate(run.id, {
        patch: { usageRoles: run.usageRoles, modelCalls: run.modelCalls },
        event: { round: run.round, source: "system", type: "run.budget_warning", message },
      }).catch(() => undefined);
    },
  });
  // A re-claimed job (worker restart) resumes against the checkpoints already
  // recorded for this run: reuse the worktree and skip finished stages (REL-002/003).
  const recovering = Boolean(!input.resume && !input.retryReview && (input.recovery || tracker.size > 0));
  const heartbeat = startJobHeartbeat(input.jobId, input.credentials, controller);
  let outcomeState: "done" | "failed" | "cancelled" = "done";
  let terminalRecorded = true;
  // AUD-10: one Run level deadline covers model calls, checks and container work.
  // COST-002: a duration budget of 0/absent means unlimited, so no timer is armed.
  let deadlineExceeded = false;
  const deadline = startRunDeadline({
    startedAt: started,
    createdAt: new Date(run.createdAt).getTime(),
    maxDurationSeconds: runLimits.maxDurationSeconds,
    // RESUME: a human continue/resume stamps a fresh window base so the round is
    // not aborted against the original createdAt window that already elapsed.
    deadlineBaseAt: run.deadlineBaseAt ? new Date(run.deadlineBaseAt).getTime() : undefined,
  }, () => {
    deadlineExceeded = true;
    controller.abort();
  });
  try {
    // P1 (fail-closed): refuse before touching the workspace at all when the
    // container sandbox is unavailable; the run fails with an actionable Chinese
    // message instead of silently running without isolation.
    assertSandboxReady();
    // P1: a non-container sandbox is never silent — record it on the run itself,
    // not only in the worker log.
    if (sandboxMode === "process") {
      await postUpdate(run.id, {
        event: {
          round: run.round,
          source: "system",
          type: "sandbox.degraded",
          message: sandboxDegraded
            ? `容器沙箱不可用，已按 PI_SANDBOX_ALLOW_DEGRADED=1 降级为 worker 进程内执行（隔离已关闭）：${sandboxReason ?? "未提供原因"}`
            : `已按 PI_SANDBOX_MODE=process 在 worker 进程内执行 Agent（容器隔离已关闭）：${sandboxReason ?? "未提供原因"}`,
          meta: { mode: sandboxMode, degraded: sandboxDegraded, reason: sandboxReason, requested: process.env.PI_SANDBOX_MODE ?? "auto" },
        },
      }).catch(() => undefined);
    }
    // R3-001 / R3-FINAL-ROUND-AMBIGUOUS: terminal stop conditions are evaluated
    // before any worktree-dependent recovery/preparation, so a reclaimed run that
    // already reached its round cap, exhausted its budget or overran its deadline
    // stops with the existing event/message semantics instead of being processed
    // further. The worktree is still required (fail-closed) for a genuine
    // mid-flight resume, which the planner lets through.
    if (recovering) {
      const plan = planRecovery({
        state: run.state,
        recovery: true,
        resume: Boolean(input.resume),
        retryReview: Boolean(input.retryReview),
        round: run.round,
        maxRounds: run.maxRounds,
        usage: run.usage,
        modelCalls: run.modelCalls,
        limits: runLimits,
        createdAt: run.createdAt,
        deadlineBaseAt: run.deadlineBaseAt,
        locale: runLocale(run),
      });
      if (plan.stop) {
        const maxRoundsStop = plan.reason === "max_rounds";
        await update(run, "needs_human", "system", plan.eventType, plan.message, {
          ...(maxRoundsStop ? { findings: run.findings } : {}),
          usage: toRunUsage(usage),
          usageRoles: run.usageRoles,
          modelCalls: run.modelCalls,
          durationMs: Date.now() - started,
          summary: maxRoundsStop ? plan.message : plan.message.slice(0, 300),
        }, { meta: { locale: runLocale(run), messageEn: plan.messageEn } });
        return;
      }
    }
    const project = await resolveProject(run.repository);
    const dirty = await git(project, ["status", "--porcelain"], controller.signal);
    if (dirty) throw new Error("Source repository has uncommitted changes; clean it before starting a real run");
    if (!/^[a-f0-9]{64}$/.test(run.ownerId)) throw new Error("Invalid run owner");
    // AUD-01: the run directory is a standalone clone; source repositories are
    // never mounted into agent containers and their Git metadata is never shared.
    const worktree = path.join(runsRoot, run.ownerId, run.id);
    const reuseWorktree = Boolean(input.resume || input.retryReview || recovering);
    const humanInstruction = input.resume?.instruction?.trim() || "";
    if (recovering) {
      await postUpdate(run.id, {
        event: { round: run.round, source: "system", type: "run.recovered", message: `Worker 恢复未完成任务：从 ${tracker.size} 个检查点继续，不重复已完成的模型调用` },
      });
    }

    let baseCommit = run.baseSha ?? await git(project, ["rev-parse", "HEAD"], controller.signal);
    if (reuseWorktree) {
      const exists = await stat(worktree).then(() => true).catch(() => false);
      if (!exists) throw new Error("无法恢复：任务运行目录不存在（可能已被清理）");
      const branch = await git(worktree, ["branch", "--show-current"], controller.signal);
      if (branch !== run.branch) throw new Error(`无法恢复：运行目录当前分支为 ${branch || "detached"}，期望 ${run.branch}`);
      const head = await git(worktree, ["rev-parse", "HEAD"], controller.signal);
      const pending = await git(worktree, ["status", "--porcelain"], controller.signal);
      // AT-GIT-001: the pinned base SHA keeps diffs and recovery stable even if
      // the source branch moved on while the task was queued.
      baseCommit = run.baseSha ?? baseCommit;
      const recoveryLabel = input.retryReview
        ? `重试审核：复用现有运行目录（HEAD ${head.slice(0, 7)}）`
        : input.resume
          ? `人工恢复：复用已有运行目录（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的人工修改" : ""}）`
          : `Worker 恢复：复用已有运行目录（HEAD ${head.slice(0, 7)}${pending ? "，包含未提交的修改" : ""}）`;
      const recoveryState = recoveryUpdateState({
        current: run.state,
        resume: Boolean(input.resume),
        retryReview: Boolean(input.retryReview),
      });
      await update(run,
        recoveryState,
        "system",
        input.retryReview ? "review.retry_started" : input.resume ? "run.resume_detected" : "run.recovery_detected",
        recoveryLabel,
        {
          worktree: path.relative(workspaceRoot, worktree),
          summary: input.retryReview ? "Reviewer Agent 正在重新审核" : input.resume ? "人工恢复：正在准备继续执行" : `Worker 恢复：保留当前阶段（${recoveryResumePhase(recoveryState)}）并从检查点继续`,
        });
      if (humanInstruction) {
        await postUpdate(run.id, { event: { round: run.round, source: "system", type: "run.resume_instruction", message: `人工指令：${humanInstruction.slice(0, 500)}` } });
      }
    } else {
      await update(run, "preparing", "system", "workspace.preparing", "正在创建独立运行目录（克隆）", { worktree: path.relative(workspaceRoot, worktree) });
      const prepared = await prepareRunDirectory({
        project,
        runDir: worktree,
        branch: run.branch,
        baseSha: run.baseSha,
        reuse: false,
        signal: controller.signal,
      });
      baseCommit = prepared.baseSha;
      if (!run.baseSha) {
        run.baseSha = prepared.baseSha;
        await postUpdate(run.id, { patch: { baseSha: prepared.baseSha } });
      }
    }

    // Isolate legacy child sessions before planner/developer/reviewer mounts exist.
    await migrateLegacySubAgentState(worktree);

    // AT-PI-006: project-local plugin resources stay unloaded (the `--no-*`
    // flags disable discovery); report them so an unapproved extension is
    // visible in the run audit instead of silently ignored.
    const ignoredPlugins = await detectProjectPlugins(worktree).catch(() => []);
    if (ignoredPlugins.length > 0 && !allowProjectPlugins) {
      await postUpdate(run.id, {
        event: {
          round: run.round,
          source: "system",
          type: "workspace.plugins_ignored",
          message: `检测到仓库内插件资源但默认不加载：${ignoredPlugins.join("、")}。仅启用管理员 allowlist（PI_PLUGIN_ALLOWLIST）中的插件。`,
          meta: { ignored: ignoredPlugins },
        },
      }).catch(() => undefined);
    }

    if (input.retryReview) {
      await executeRetryReview({ run, worktree, baseCommit, credentials: input.credentials, controller, usage, started, budget, sessions, checks: input.checks }, actions.performReview);
      return;
    }
    await update(run, "developing", "developer", "agent.started", `${run.developer.model} 主 Agent 开始评估工作量`, { summary: "主 Agent 正在分析任务并决定是否拆分 Sub Agent" });

    let feedback = input.resume || recovering ? unresolvedFeedback(run.findings) : "";
    let findings: Finding[] = input.resume || recovering ? [...(run.findings ?? [])] : [];
    let plan: DevelopmentPlan | undefined;
    const firstRound = input.resume ? Math.max(2, run.round) : recovering ? Math.max(1, run.round) : 1;
    for (let round = firstRound; round <= run.maxRounds; round += 1) {
      run.round = round;
      await postUpdate(run.id, { patch: { round }, event: { round, source: "system", type: "round.started", message: `开始第 ${round} 轮开发` } });
      ({ plan, feedback, findings } = await actions.developRound({
        job: input, run, worktree, controller, tracker, usage, budget, sessions,
        round, firstRound, humanInstruction, plan, feedback, findings,
      }));
      // E2E-01b: the run branch must carry this round's work before anything is
      // diffed, hashed, checked, reviewed or merged. Covers the fresh/repair
      // developer, the integrator's own edits and a checkpoint-recovered round
      // whose worktree is still dirty; a clean worktree is a no-op.
      await commitRoundWork(run, worktree, round, controller.signal);
      const diff = await collectDiff(worktree, controller.signal, baseCommit);
      const checkSnapshot = await snapshotHash(worktree, controller.signal);
      // NEW-07: persist the full diff durably before reporting it, so an
      // oversized inline patch is always recoverable (visible in the audit log).
      const checkDiffArtifact = await persistDiffArtifact(worktree, diff, round);
      await postUpdate(run.id, { event: {
        round, source: "checks", type: "diff.artifact_persisted",
        message: `第 ${round} 轮完整 diff 已持久化为制品 ${checkDiffArtifact.id}（${checkDiffArtifact.bytes} 字节，sha256=${checkDiffArtifact.sha256}）`,
        meta: { artifactId: checkDiffArtifact.id, sha256: checkDiffArtifact.sha256, bytes: checkDiffArtifact.bytes, kind: "diff" },
      } });
      await update(run, "checking", "checks", "checks.started", "Developer 完成，开始确定性检查", { diff, checkSnapshot, summary: "正在运行项目检查", usage: toRunUsage(usage) }, { diffArtifact: checkDiffArtifact });
      const storedChecksRaw = tracker.isCompleted(stages.checks(round)) ? tracker.payload<StoredChecks>(stages.checks(round)) : undefined;
      const storedChecks = isCheckpointCurrent(storedChecksRaw, { round, snapshotHash: checkSnapshot }) ? storedChecksRaw : undefined;
      if (storedChecks) {
        await postUpdate(run.id, { event: { round, source: "checks", type: "checks.checkpoint_restored", message: `从检查点恢复第 ${round} 轮检查结果，未重复执行检查命令` } });
      } else if (storedChecksRaw) {
        // NEW-03: the recorded checks were produced for different content; never
        // reuse them, re-run instead of trusting a stale verdict.
        await postUpdate(run.id, { event: { round, source: "checks", type: "checks.checkpoint_stale", message: `第 ${round} 轮检查点与当前内容不匹配，重新执行检查命令` } });
      }
      const checked = storedChecks ?? await runChecks(run, worktree, input.checks, controller.signal, input.credentials);
      if (!storedChecks) await tracker.complete(stages.checks(round), { ...checked, round, snapshotHash: checkSnapshot });
      if (!checked.passed) {
        feedback = `The deterministic checks failed. Fix these failures:\n${checked.results.filter((item) => item.status === "failed").map((item) => `${item.command}\n${item.output}`).join("\n\n")}`;
        await chat(run, "handoff", "checks", "developer", "feedback", feedback, controller.signal);
        await update(run, "developing", "checks", "checks.returned", "检查失败，已退回 Developer 修复", { summary: "检查失败，等待修复", checkPassed: false, ...(storedChecks ? {} : { checks: checked.results }) });
        continue;
      }

      const latestDiff = await collectDiff(worktree, controller.signal, baseCommit);
      const reviewSnapshot = await snapshotHash(worktree, controller.signal);
      const reviewDiffArtifact = await persistDiffArtifact(worktree, latestDiff, round);
      // AT-REL-003: a review that already produced a verdict is reused, so a
      // restarted worker can never emit two conflicting verdicts for one round.
      let review: ReviewResult;
      const storedReviewRaw = tracker.isCompleted(stages.review(round)) ? tracker.payload<StoredReview>(stages.review(round)) : undefined;
      const storedReview = isCheckpointCurrent(storedReviewRaw, { round, snapshotHash: reviewSnapshot }) ? storedReviewRaw : undefined;
      if (storedReview) {
        await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, checkSnapshot, reviewSnapshot, checkPassed: true, checks: checked.results, summary: "Reviewer Agent 正在审核" }, { diffArtifact: reviewDiffArtifact });
        review = storedReview;
        await postUpdate(run.id, { event: { round, source: "system", type: "review.checkpoint_restored", message: "从检查点恢复本轮审核结论，跳过重复的审核模型调用" } });
      } else {
        if (storedReviewRaw) {
          await postUpdate(run.id, { event: { round, source: "system", type: "review.checkpoint_stale", message: "本轮审核检查点与当前内容不匹配，重新执行审核" } });
        }
        // GAP-03: materialize the reviewer's immutable snapshot before announcing
        // the review, so the reviewer never reads the developer's live worktree.
        const snapshotPath = await prepareReviewSnapshot({ run, worktree, round, signal: controller.signal, credentials: input.credentials });
        if (!snapshotPath) return;
        await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, checkSnapshot, reviewSnapshot, checkPassed: true, checks: checked.results, summary: "Reviewer Agent 正在审核" }, { diffArtifact: reviewDiffArtifact });
        await tracker.start(stages.review(round));
        let outcome: ReviewOutcome;
        try {
          outcome = await actions.performReview({ run, snapshotPath, credentials: input.credentials, round, diff: latestDiff, signal: controller.signal, usage, started, budget, sessions });
        } finally {
          // AT-REVIEW-012: snapshot and its state are destroyed after one use.
          await destroyReviewSnapshot(snapshotPath);
        }
        if (outcome.stopped) return;
        review = outcome.review;
        await tracker.complete(stages.review(round), { ...review, round, snapshotHash: reviewSnapshot });
      }
      findings = mergeFindings(findings, review.findings, { round, approved: review.verdict === "approved" });
      const scope = resolveReviewScope(run);
      const blocking = blockingFindings(findings, scope);
      // AT-REVIEW-010 / REVIEW-007: stop auto-repairing when the same severe
      // finding persists across the policy threshold of consecutive rounds,
      // instead of starting yet another repair round.
      const repeatedSevere = repeatedSevereFindings(findings);
      if (repeatedSevere.length > 0) {
        const locale = runLocale(run);
        const labels = severeRepeatLabels(
          repeatedSevere.slice(0, 3).map((finding) => ({
            severity: finding.severity,
            title: finding.title,
            rounds: finding.consecutiveRounds ?? 0,
          })),
          locale,
        );
        const repeated = guardText(severeRepeatText(severeRepeatThreshold, labels), locale);
        await update(
          run,
          "needs_human",
          "reviewer",
          "review.severe_finding_repeated",
          repeated.message,
          {
            findings,
            diff: latestDiff,
            summary: guardText(severeRepeatSummary(severeRepeatThreshold), locale).message,
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
          },
          { diffArtifact: reviewDiffArtifact, meta: repeated.meta },
        );
        return;
      }
      if (shouldAcceptRound({ verdict: review.verdict, scope, blocking })) {
        // AUD-03/AUD-04: independent completion guard. The review verdict alone
        // never completes a run: the checks for this snapshot must have passed
        // and no blocking finding may remain open. Under scope "blocking" the
        // blocking set is critical/high only, so a changes_requested review whose
        // remaining findings are medium/low becomes an approval-with-notes.
        const snapshotConsistent = !run.checkSnapshot || !reviewSnapshot || run.checkSnapshot === reviewSnapshot;
        if (blocking.length > 0 || !checked.passed || !snapshotConsistent) {
          const locale = runLocale(run);
          const reasons = [
            blocking.length > 0 ? `${blocking.length} 个阻断级问题未解决` : "",
            checked.passed ? "" : "当前快照检查未通过",
            snapshotConsistent ? "" : "检查与审核的快照不一致（代码在检查后被修改）",
          ].filter(Boolean).join("；");
          const reasonsEn = [
            blocking.length > 0 ? `${blocking.length} unresolved blocking finding(s)` : "",
            checked.passed ? "" : "the current snapshot's checks did not pass",
            snapshotConsistent ? "" : "the check and review snapshots differ (the code changed after the checks)",
          ].filter(Boolean).join("; ");
          const blocked = guardText(
            locale === "en" ? completionBlockedText(reasonsEn) : completionBlockedText(reasons),
            locale,
          );
          await update(run, "needs_human", "system", "run.completion_blocked", blocked.message, {
            findings,
            diff: latestDiff,
            checkSnapshot,
            reviewSnapshot,
            checkPassed: checked.passed,
            summary: guardText(COMPLETION_BLOCKED_SUMMARY, locale).message,
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
          }, { diffArtifact: reviewDiffArtifact, meta: blocked.meta });
          return;
        }
        const deferred = deferredFindings(findings, scope);
        if (isDeferral(scope, deferred)) {
          // The non-blocking findings stay on the run (and in the acceptance
          // snapshot's remaining list); this event keeps them visible instead of
          // silently dropped.
          await postUpdate(run.id, {
            event: {
              round,
              source: "reviewer",
              type: "review.nonblocking_deferred",
              message: deferredMessage(round, deferred),
              meta: { round, scope, count: deferred.length, ids: deferred.map((finding) => finding.id) },
            },
          });
        }
        await recordVerdictThenReviewTriage({
          runId: run.id,
          recordVerdict: () => update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
            findings,
            diff: latestDiff,
            summary: review.summary,
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
          }, { diffArtifact: reviewDiffArtifact }),
          trigger: triggerReviewTriage,
        });
        return;
      }
      // Convergence guard (incident run_e2eabf51532448b3): fire BEFORE another
      // repair round starts when the reviewer keeps raising NEW severe findings.
      // Runs after the repeated-severe/budget/deadline guards and the completion
      // path, so it never overrides a stronger terminal reason.
      const convergence = convergenceStop({
        findings,
        currentRound: round,
        enabled: reviewConvergenceGuardEnabled,
        requiredUnresolvedRounds: reviewStallRoundsThreshold,
      });
      if (convergence.stop) {
        const locale = runLocale(run);
        const convergenceText = { zh: convergence.message, en: convergence.messageEn };
        const rendered = guardText(convergenceText, locale);
        const summaryText = convergence.message
          ? { zh: convergence.message.slice(0, 300), en: convergence.messageEn.slice(0, 300) }
          : { zh: "审核未收敛，已停止自动返修并转人工处理", en: "Review not converging; auto-repair stopped for human handling" };
        await update(run, "needs_human", "reviewer", "review.not_converging", rendered.message, {
          findings,
          diff: latestDiff,
          checkSnapshot,
          reviewSnapshot,
          checkPassed: checked.passed,
          summary: guardText(summaryText, locale).message,
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        }, { diffArtifact: reviewDiffArtifact, meta: { ...convergence.meta, ...rendered.meta } });
        return;
      }
      feedback = JSON.stringify(review.findings, null, 2);
      await chat(run, "handoff", "reviewer", "developer", "feedback", feedback, controller.signal, { findings: review.findings.map((item) => ({ ...item, resolved: false })) });
      const changesRequested = guardText(changesRequestedText(review.findings.length), runLocale(run));
      // docs/26 §9.1: record the authoritative verdict first, then (opt-in) fire
      // the shadow review triage for this round.
      await recordVerdictThenReviewTriage({
        runId: run.id,
        recordVerdict: () => update(run, "developing", "reviewer", "review.changes_requested", changesRequested.message, { findings, summary: review.summary, usage: toRunUsage(usage) }, { meta: changesRequested.meta }),
        trigger: triggerReviewTriage,
      });
    }
    const maxRounds = guardText(MAX_ROUNDS_TEXT, runLocale(run));
    await update(run, "needs_human", "system", "run.needs_human", maxRounds.message, { findings, usage: toRunUsage(usage), usageRoles: run.usageRoles, modelCalls: run.modelCalls, durationMs: Date.now() - started }, { meta: maxRounds.meta });
  } catch (error) {
    const locale = runLocale(run);
    if (heartbeat.leaseLost()) {
      outcomeState = "cancelled";
      terminalRecorded = false;
      console.warn(`[jobs] ${input.jobId ?? run.id} stopped after losing its durable lease; terminal callback suppressed`);
      return;
    }
    if (deadlineExceeded) {
      terminalRecorded = false;
      const deadline = guardText(deadlineExceededText(runLimits.maxDurationSeconds), locale);
      const message = deadline.message;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await update(run, "needs_human", "system", "run.deadline_exceeded", message, {
            usage: toRunUsage(usage),
            usageRoles: run.usageRoles,
            modelCalls: run.modelCalls,
            durationMs: Date.now() - started,
            summary: message,
          }, { meta: deadline.meta });
          terminalRecorded = true;
          break;
        } catch (writeError) {
          console.warn(`[store] deadline terminal update failed (attempt ${attempt}): ${diagnosticMessage(writeError, Object.values(input.credentials))}`);
          if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
        }
      }
      return;
    }
    const cancelled = controller.signal.aborted;
    outcomeState = cancelled ? "cancelled" : "failed";
    // AUD-06: nothing is recorded yet; the finally block may only finish the job
    // after this retry loop wrote the terminal state successfully.
    terminalRecorded = false;
    if (error instanceof BudgetExceededError && !cancelled) {
      // COST-003 / AT-PERF-008: 100% of a hard budget stops new model calls.
      outcomeState = "failed";
      const budget = guardText(budgetExhaustedText(error.message), locale);
      const message = budget.message;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await update(run, "needs_human", "system", "run.budget_exhausted", message, {
            usage: toRunUsage(usage),
            usageRoles: run.usageRoles,
            modelCalls: run.modelCalls,
            durationMs: Date.now() - started,
            summary: message.slice(0, 300),
          }, { meta: budget.meta });
          terminalRecorded = true;
          break;
        } catch (writeError) {
          console.warn(`[store] budget terminal update failed (attempt ${attempt}): ${diagnosticMessage(writeError, Object.values(input.credentials))}`);
          if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
        }
      }
      return;
    }
    // P1 (fail-closed): the sandbox unavailable error is never classified as a
    // provider/storage problem (its reason may contain ECONNREFUSED etc.) and
    // never parked: the run fails with the actionable sandbox message.
    const sandboxUnavailable = !cancelled && error instanceof SandboxUnavailableError;
    const inputTransport = !cancelled && error instanceof PiInputTransportError ? error : undefined;
    const safeMessage = diagnosticMessage(error, Object.values(input.credentials));
    const followup = Boolean(input.resume || input.retryReview);
    const kind = cancelled || sandboxUnavailable ? undefined : classifyProviderError(safeMessage);
    // AT-REL-006/007: classified provider and storage failures are parked for a
    // human (bounded retries already happened above); only unclassified errors
    // mark the run permanently failed.
    const parked = sandboxUnavailable ? false : Boolean(inputTransport) || followup || recovering || (kind !== undefined && kind !== "unknown");
    const state: RunState = cancelled ? "cancelled" : parked ? "needs_human" : "failed";
    const type = cancelled
      ? "run.cancelled"
      : inputTransport
        ? "pi.input_transport_blocked"
      : sandboxUnavailable
        ? "run.sandbox_unavailable"
        : kind === "storage"
          ? "run.storage_error"
          : parked
            ? "run.provider_error"
            : followup
              ? "run.resume_failed"
              : recovering
                ? "run.recovery_failed"
                : "run.failed";
    const message = cancelled
      ? guardText(CANCELLED_TEXT, locale).message
      : inputTransport
        ? guardText(PI_INPUT_TRANSPORT_TEXT, locale).message
      : sandboxUnavailable
        ? safeMessage
        : kind === "storage"
          ? guardText(storageErrorText(kind, safeMessage), locale).message
          : guardText(runFailureText(kind ?? "unknown", safeMessage, followup ? "followup" : recovering ? "recovering" : "run"), locale).message;
    const summaryText: LocalizedText = cancelled
      ? CANCELLED_SUMMARY
      : inputTransport
        ? PI_INPUT_TRANSPORT_TEXT
      : sandboxUnavailable
        ? SANDBOX_UNAVAILABLE_SUMMARY
        : { zh: providerErrorSummary(kind ?? "unknown", safeMessage).slice(0, 800), en: providerErrorSummary(kind ?? "unknown", safeMessage, "en").slice(0, 800) };
    // AT-REL-007: retry the terminal write so a short store outage cannot leave
    // the run silently mid-flight; if it still fails the job stays claimed and a
    // later reclaim repeats this stage (never marking a false completion).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await update(run, state, "system", type, message, {
          summary: guardText(summaryText, locale).message,
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        }, { meta: { locale, messageEn: summaryText.en, ...(inputTransport ? { reason: inputTransport.reason, inputBytes: inputTransport.bytes, transportLimit: inputTransport.limit } : {}) } });
        terminalRecorded = true;
        break;
      } catch (writeError) {
        // The user cancellation may have committed before our callback. Keep
        // its terminal state/event intact, but settle our still-fenced job.
        if (cancelled && (writeError as { code?: unknown })?.code === "RUN_ALREADY_CANCELLED") {
          terminalRecorded = true;
          break;
        }
        console.warn(`[store] terminal update failed (attempt ${attempt}): ${diagnosticMessage(writeError, Object.values(input.credentials))}`);
        if (attempt < 3) await sleep(1_000 * 2 ** (attempt - 1));
      }
    }
    if (!terminalRecorded) {
      console.error(`[store] could not record the terminal state for ${run.id}; leaving the job for reclaim`);
    }
  } finally {
    deadline.cancel();
    heartbeat.stop();
    if (input.jobId && terminalRecorded && !heartbeat.leaseLost()) {
      await jobApi.finish(input.jobId, outcomeState).catch((error) => console.warn(`[jobs] finish failed: ${diagnosticMessage(error, Object.values(input.credentials))}`));
    } else if (input.jobId && !heartbeat.leaseLost()) {
      console.warn(`[jobs] keeping ${input.jobId} claimed so it can be retried after the store recovers`);
    }
    input.credentials.developer = "";
    input.credentials.reviewer = "";
    active.delete(run.id);
  }
}
