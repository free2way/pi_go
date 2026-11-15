import { createShutdownHandler } from "./sandbox.js";
import {
  sandboxContainers,
  workspaceLocks,
  port,
  host,
  initializeSandbox,
  stopClaimingJobs,
  maxSubagents,
  diagnosticMessage,
  serializeWorktreeMutation,
  type JobInput,
  reviewerThinking,
} from "./worker-runtime.js";
import { triggerAuditRetention, postUpdate, redactJobSecrets, chat, update } from "./worker-web-client.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DevelopmentPlan, Run, SubAgentTask } from "../shared/types.js";
import { assignSubAgentCodenames } from "../shared/codenames.js";
import { CheckpointTracker, stages } from "./checkpoints.js";
import { conflictFreeBatches, executionWaves, fallbackPlan, parseDevelopmentPlan } from "./orchestrator.js";
import { addUsage, type UsageTotals, toRunUsage } from "./pi-events.js";
import { BudgetExceededError, type RunBudgetContext } from "./run-budget.js";
import { runHardenedGit } from "./git-hardening.js";
import { apiKeyEnvName, classifyProviderError, providerErrorSummary } from "./provider-errors.js";
import { PiInputTransportError, assertPiCliInput, reviewTransportLimits } from "./pi-cli-input.js";
import { failureOutputForEvent } from "./agent-failure.js";
import { redactWorkerDiagnostic } from "./diagnostic-redaction.js";
import { subAgentStateDirectory } from "./subagent-state.js";
import { captureFailedSubAgentWorktree } from "./subagent-artifacts.js";
import { runLocale, guardText, INVALID_PROTOCOL_TEXT, REVIEW_INPUT_BUDGET_TEXT, PI_INPUT_TRANSPORT_TEXT, reviewProviderErrorText } from "./runtime-locale.js";
import { localeInstruction } from "./prompt-locale.js";
import { SessionAccumulator, type PiSessionRole } from "./pi-session.js";
import { git } from "./worker-process.js";
import { runPiWithRetry } from "./pi-cli-runner.js";
import { parseReview } from "./review-protocol.js";
import { buildReviewDiff, reviewInputLimits, ReviewInputBudgetError } from "./review-input.js";
import { unresolvedFeedback } from "./review-findings.js";
import type { ReviewOutcome, ReviewInput } from "./run-review.js";
import { executeJob, type DevelopmentRoundInput } from "./run-execution.js";
import { createWorkerJobs } from "./worker-jobs.js";
import { createWorkerServer } from "./worker-http.js";

async function planDevelopment(run: Run, worktree: string, credentials: JobInput["credentials"], signal: AbortSignal, usage: UsageTotals, budget?: RunBudgetContext, sessions?: SessionAccumulator) {
  const prompt = [
    "You are the lead engineering planner. Inspect the current repository read-only and size the requested implementation.",
    `Task: ${run.task}`,
    `You may create at most ${maxSubagents} implementation tasks. Prefer one task for small cohesive changes.`,
    "Use multiple tasks only when work can be separated by component or file ownership.",
    "Tasks in the same dependency wave must not edit overlapping files. Add dependsOn for ordering when one task needs another.",
    // docs/24-i18n.md §10: the single locale instruction block.
    localeInstruction(runLocale(run)),
    "Return JSON only with this exact shape:",
    '{"complexity":"small|medium|large","rationale":"...","tasks":[{"id":"kebab-id","title":"...","description":"...","files":["relative/path"],"dependsOn":[]}]}',
  ].join("\n\n");
  try {
    const result = await runPiWithRetry({
      cwd: worktree,
      provider: run.developer.provider,
      model: run.developer.model,
      prompt,
      readOnly: true,
      // COST-006: planning is a sizing decision, so it runs with low reasoning.
      thinking: process.env.PI_PLANNER_THINKING === "high" || process.env.PI_PLANNER_THINKING === "medium" ? process.env.PI_PLANNER_THINKING : "low",
      apiKey: credentials.developer,
      diagnosticCredentials: Object.values(credentials),
      apiKeyEnvironmentName: apiKeyEnvName(run.developer.provider),
      signal,
      onActivity: (message) => postUpdate(run.id, { event: { round: run.round, source: "developer", type: "planner.activity", message: `主 Agent：${message}` } }),
    }, { runId: run.id, round: run.round, label: "主 Agent 规划", role: "planner", budget, sessions, usage });
    addUsage(usage, result.usage);
    return parseDevelopmentPlan(redactJobSecrets(result.text, credentials), maxSubagents);
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof PiInputTransportError) throw error;
    const safeMessage = diagnosticMessage(error, Object.values(credentials));
    await postUpdate(run.id, { event: { round: run.round, source: "system", type: "planner.fallback", message: `任务拆分失败，安全回退到单 Agent：${safeMessage}` } });
    return fallbackPlan(run.task);
  }
}

async function runDeveloperAgent(input: {
  run: Run;
  worktree: string;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  prompt: string;
  sessionSuffix: string;
  activityPrefix?: string;
  /** Item-3: sub-agent codename surfaced in chat instead of only the task title. */
  agentName?: string;
  usage: UsageTotals;
  budget?: RunBudgetContext;
  role?: PiSessionRole;
  sessions?: SessionAccumulator;
  /** Pi state outside a nested sub-agent worktree. */
  statePath?: string;
}) {
  const extra = input.agentName ? { agent: input.agentName } : {};
  await chat(input.run, "developer", "orchestrator", "developer", "prompt", input.prompt, input.signal, extra);
  const result = await runPiWithRetry({
    cwd: input.worktree,
    provider: input.run.developer.provider,
    model: input.run.developer.model,
    prompt: input.prompt,
    apiKey: input.credentials.developer,
    diagnosticCredentials: Object.values(input.credentials),
    apiKeyEnvironmentName: apiKeyEnvName(input.run.developer.provider),
    signal: input.signal,
    onActivity: (message) => postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "agent.activity",
        message: input.activityPrefix ? `${input.activityPrefix}：${message}` : message,
      },
    }),
    ...(input.statePath ? { statePath: input.statePath } : {}),
  }, { runId: input.run.id, round: input.run.round, label: input.activityPrefix ?? "开发 Agent", role: input.role ?? "developer", sessionKey: input.sessionSuffix, budget: input.budget, sessions: input.sessions, usage: input.usage });
  addUsage(input.usage, result.usage);
  await chat(input.run, "developer", "developer", "orchestrator", "response", redactJobSecrets(result.text, input.credentials), input.signal, extra);
  return result.text;
}

/**
 * Item-3: stamp every task of a split plan with a deterministic codename. The
 * single-task plan is left untouched (it is the developer agent, not a sub-agent).
 * Idempotent: a restored checkpoint already carrying names keeps them, and a
 * fresh assignment is reproducible from runId + task id.
 */
function assignPlanCodenames(runId: string, plan: DevelopmentPlan): DevelopmentPlan {
  if (plan.tasks.length <= 1) return plan;
  if (plan.tasks.every((task) => task.name)) return plan;
  const names = assignSubAgentCodenames(runId, plan.tasks.map((task) => task.id));
  plan.tasks.forEach((task, index) => { task.name = task.name ?? names[index]; });
  return plan;
}

/** Item-3: event/chat label — codename when assigned, task title otherwise. */
function subAgentLabel(task: SubAgentTask): string {
  return task.name ? `${task.name}｜${task.title}` : task.title;
}

type SubAgentResult = {
  task: SubAgentTask;
  branch: string;
  worktree: string;
  commit?: string;
  error?: string;
};

async function runSubAgent(input: {
  run: Run;
  project: string;
  mainBranch: string;
  task: SubAgentTask;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  usage: UsageTotals;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
}): Promise<SubAgentResult> {
  const startedAt = Date.now();
  const branch = `${input.mainBranch}-sub-${input.task.id}`;
  const worktree = path.join(input.project, "subagents", input.task.id);
  input.task.status = "running";
  input.task.branch = branch;
  await mkdir(path.dirname(worktree), { recursive: true });
  await postUpdate(input.run.id, {
    event: {
      round: input.run.round,
      source: "developer",
      type: "subagent.started",
      message: `Sub Agent「${subAgentLabel(input.task)}」开始执行`,
      meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
    },
  });
  try {
    await serializeWorktreeMutation(() => git(input.project, ["worktree", "add", "-b", branch, worktree, input.mainBranch], input.signal));
    const prompt = [
      "You are a focused implementation sub-agent. Work only in the current Git worktree.",
      `Overall task: ${input.run.task}`,
      input.task.name ? `Your codename: ${input.task.name}` : "",
      `Your assigned task: ${input.task.title}\n${input.task.description}`,
      input.task.files.length ? `Primary file ownership: ${input.task.files.join(", ")}` : "Inspect and limit changes to the smallest coherent scope.",
      "Implement only your assigned part and its focused tests. Do not push, deploy, read credentials, or modify unrelated areas.",
      "Other sub-agents may work in parallel. Avoid broad formatting and generated dependency updates unless explicitly required.",
      // docs/24-i18n.md §10: the single locale instruction block.
      localeInstruction(runLocale(input.run)),
    ].filter(Boolean).join("\n\n");
    const summary = await runDeveloperAgent({
      run: input.run,
      worktree,
      credentials: input.credentials,
      signal: input.signal,
      prompt,
      sessionSuffix: `sub-${input.task.id}`,
      activityPrefix: `Sub Agent「${subAgentLabel(input.task)}」`,
      agentName: input.task.name,
      usage: input.usage,
      budget: input.budget,
      role: "sub-agent",
      sessions: input.sessions,
      // A sibling root keeps child auth/session files out of the main agent's mount.
      statePath: subAgentStateDirectory(input.project, input.task.id),
    });
    const changed = await git(worktree, ["status", "--porcelain"], input.signal);
    let commit: string | undefined;
    if (changed) {
      await git(worktree, ["add", "-A"], input.signal);
      await git(worktree, ["-c", "user.name=PiGO Sub Agent", "-c", "user.email=agent@pigo.local", "commit", "-m", `subagent: ${input.task.title}`], input.signal);
      commit = await git(worktree, ["rev-parse", "HEAD"], input.signal);
    }
    input.task.status = "completed";
    input.task.summary = redactJobSecrets(summary, input.credentials).slice(0, 1_000) || (commit ? "Implementation committed" : "No code changes were required");
    input.task.durationMs = Date.now() - startedAt;
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "subagent.completed",
        message: `Sub Agent「${subAgentLabel(input.task)}」完成`,
        meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
      },
    });
    return { task: input.task, branch, worktree, commit };
  } catch (error) {
    const safeMessage = diagnosticMessage(error, Object.values(input.credentials));
    input.task.status = "failed";
    input.task.summary = safeMessage.slice(0, 1_000);
    input.task.durationMs = Date.now() - startedAt;
    // GAP-05 / AT-AGENT-008: keep a bounded, redacted tail of the failed call's
    // output as a run event so the failure stays diagnosable after the
    // sub-agent worktree is force-removed.
    const captured = failureOutputForEvent(error, undefined, (text) => redactWorkerDiagnostic(text, Object.values(input.credentials)));
    if (captured) {
      const meta: Record<string, unknown> = { taskId: input.task.id, codename: input.task.name, exitCode: captured.exitCode };
      if (captured.stdout) meta.stdoutTail = captured.stdout;
      if (captured.stderr) meta.stderrTail = captured.stderr;
      await postUpdate(input.run.id, {
        event: {
          round: input.run.round,
          source: "developer",
          type: "subagent.failure_output",
          message: `Sub Agent「${subAgentLabel(input.task)}」失败输出已保留（退出码 ${captured.exitCode}，每路最多 8 KB）`,
          meta,
        },
      }).catch(() => undefined);
    }
    await postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "subagent.failed",
        message: `Sub Agent「${subAgentLabel(input.task)}」失败，将由集成 Agent 接管：${safeMessage.slice(0, 200)}`,
        meta: { taskId: input.task.id, codename: input.task.name, title: input.task.title },
      },
    });
    return { task: input.task, branch, worktree, error: safeMessage };
  }
}

async function removeSubAgentWorktree(project: string, worktree: string) {
  await serializeWorktreeMutation(() => git(project, ["worktree", "remove", "--force", worktree])).catch(() => undefined);
  // v0.26.1 compatibility: remove the legacy Pi state sibling that older
  // workers created inside the main run repository (`subagents/<id>.state`).
  await rm(`${worktree}.state`, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * AT-AGENT-008: before a failed sub-agent's worktree is force-removed, persist
 * its uncommitted work (patch + per-file inventory) under the run's
 * `.state/artifacts/` and emit a `subagent.failure_artifact` event. A capture
 * failure is recorded as `subagent.failure_artifact_failed`, never dropped.
 */
async function captureFailedSubAgentArtifact(run: Run, mainWorktree: string, worktree: string, task: SubAgentTask) {
  const artifactsDirectory = path.join(`${mainWorktree}.state`, "artifacts");
  const result = await captureFailedSubAgentWorktree({
    worktree,
    artifactsDirectory,
    taskId: task.id,
    // Deliberately independent of the run's abort signal: retention must still
    // work when the sub-agent failed because the run was cancelled/timed out.
    exec: (args) => runHardenedGit({ cwd: worktree, args, timeoutMs: 30_000 }),
  });
  if (result.ok) {
    const artifact = result.artifact;
    await postUpdate(run.id, {
      event: {
        round: run.round,
        source: "developer",
        type: "subagent.failure_artifact",
        message: `Sub Agent「${subAgentLabel(task)}」未提交成果已保留为制品 ${artifact.id}（patch ${artifact.patchBytes} 字节 sha256=${artifact.patchSha256}；共 ${artifact.files.length} 个文件）`,
        meta: {
          taskId: task.id,
          codename: task.name,
          artifactId: artifact.id,
          path: artifact.patchPath,
          bytes: artifact.patchBytes,
          sha256: artifact.patchSha256,
          inventoryPath: artifact.inventoryPath,
          inventorySha256: artifact.inventorySha256,
          files: artifact.files.length,
          truncated: artifact.truncated,
        },
      },
    }).catch(() => undefined);
    return;
  }
  await postUpdate(run.id, {
    event: {
      round: run.round,
      source: "developer",
      type: "subagent.failure_artifact_failed",
      message: `Sub Agent「${subAgentLabel(task)}」未提交成果保存失败：${result.error}`,
      meta: { taskId: task.id, codename: task.name, error: result.error },
    },
  }).catch(() => undefined);
}

async function deleteSubAgentBranch(project: string, branch: string) {
  await serializeWorktreeMutation(() => git(project, ["branch", "-D", branch])).catch(() => undefined);
}

async function orchestrateSubAgents(input: {
  run: Run;
  project: string;
  worktree: string;
  plan: DevelopmentPlan;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  usage: UsageTotals;
  tracker: CheckpointTracker;
  budget?: RunBudgetContext;
  sessions?: SessionAccumulator;
}) {
  const integrationNotes: string[] = [];
  const restored: string[] = [];
  for (const wave of executionWaves(input.plan.tasks)) {
    // REL-003 / AT-REL-002: sub-agents that finished before a restart are not
    // executed again; their committed work is already in the integration worktree.
    for (const task of wave) {
      if (!input.tracker.isCompleted(stages.task(task.id))) continue;
      const stored = input.tracker.payload<{ status?: string; summary?: string; durationMs?: number }>(stages.task(task.id)) ?? {};
      task.status = stored.status === "failed" ? "failed" : "merged";
      task.summary = stored.summary ?? "从检查点恢复：该 Sub Agent 已完成";
      task.durationMs = stored.durationMs;
      restored.push(task.title);
    }
    if (restored.length > 0) {
      await postUpdate(input.run.id, {
        patch: { plan: input.plan },
        event: { round: input.run.round, source: "system", type: "subagents.restored", message: `从检查点恢复 ${restored.length} 个已完成 Sub Agent，跳过重复模型调用` },
      });
      restored.length = 0;
    }
    const runnable = wave.filter((task) => task.status === "planned" && task.dependsOn.every((id) => input.plan.tasks.find((item) => item.id === id)?.status === "merged"));
    for (const task of wave.filter((item) => item.status === "planned" && !runnable.includes(item))) {
      task.status = "failed";
      task.summary = "A dependency failed to merge";
      integrationNotes.push(`${task.title}: skipped because a dependency failed`);
    }
    if (runnable.length === 0) {
      if (wave.length > 0) await postUpdate(input.run.id, { patch: { plan: input.plan } });
      continue;
    }
    for (const task of runnable) task.status = "running";
    const batches = conflictFreeBatches(runnable);
    await postUpdate(input.run.id, {
      patch: { plan: input.plan },
      event: {
        round: input.run.round,
        source: "system",
        type: "subagents.wave_started",
        message: batches.length > 1
          ? `并行启动 ${runnable.length} 个 Sub Agent（检测到声明的文件范围重叠，分 ${batches.length} 批串行化执行）`
          : `并行启动 ${runnable.length} 个 Sub Agent`,
      },
    });
    for (const batch of batches) {
      const results = await Promise.all(batch.map((task) => runSubAgent({
        run: input.run,
        project: input.project,
        mainBranch: input.run.branch,
        task,
        credentials: input.credentials,
        signal: input.signal,
        usage: input.usage,
        budget: input.budget,
        sessions: input.sessions,
      })));
      for (const result of results) {
        let keepBranch = false;
        try {
          if (result.error) {
            integrationNotes.push(`${result.task.title}: ${result.error}`);
            await input.tracker.complete(stages.task(result.task.id), {
              status: "failed",
              summary: result.task.summary,
              durationMs: result.task.durationMs,
            });
            continue;
          }
          if (result.commit) {
            const merged = await runHardenedGit({ cwd: input.worktree, args: ["-c", "user.name=PiGO Integration", "-c", "user.email=agent@pigo.local", "cherry-pick", result.commit], signal: input.signal, timeoutMs: 120_000 });
            if (merged.code !== 0) {
              await runHardenedGit({ cwd: input.worktree, args: ["cherry-pick", "--abort"], timeoutMs: 120_000 }).catch(() => undefined);
              result.task.status = "failed";
              result.task.summary = `Merge conflict from ${result.branch}`;
              integrationNotes.push(`${result.task.title}: merge ${result.branch} manually (${(merged.stderr || merged.stdout).trim().slice(0, 160)})`);
              keepBranch = true;
              await input.tracker.complete(stages.task(result.task.id), {
                status: "failed",
                summary: result.task.summary,
                durationMs: result.task.durationMs,
              });
              continue;
            }
          }
          result.task.status = "merged";
          await input.tracker.complete(stages.task(result.task.id), {
            status: "merged",
            summary: result.task.summary,
            durationMs: result.task.durationMs,
          });
          await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.merged", message: `Sub Agent「${subAgentLabel(result.task)}」已合并`, meta: { taskId: result.task.id, codename: result.task.name, title: result.task.title } } });
        } finally {
          // AT-AGENT-008: retain the failed sub-agent's uncommitted work before
          // its worktree is force-removed.
          if (result.error) await captureFailedSubAgentArtifact(input.run, input.worktree, result.worktree, result.task);
          await removeSubAgentWorktree(input.project, result.worktree);
          if (!keepBranch) await deleteSubAgentBranch(input.project, result.branch);
        }
      }
    }
    await postUpdate(input.run.id, { patch: { plan: input.plan }, event: { round: input.run.round, source: "system", type: "subagents.wave_completed", message: "本批 Sub Agent 执行完成，主 Agent 正在整合" } });
  }
  return integrationNotes;
}

async function performReview(input: ReviewInput): Promise<ReviewOutcome> {
  // COST/latency (incident run_e7c565d6335a4bc7): the diff handed to the reviewer
  // is budget-trimmed (lockfiles/build outputs excluded, per-file and total byte
  // caps) and always carries a manifest of everything excluded or trimmed, so the
  // reviewer sees what it is NOT being shown instead of silently losing context.
  const reviewPrefix = [
    "You are an independent read-only code reviewer. Do not modify files.",
    `Original task: ${input.run.task}`,
    "Review the diff below for correctness, missing requirements, security, regressions, and test quality.",
    "Work diff-first: inspect changed files, their direct dependencies, and related tests. Do not inventory or scan the whole repository without a concrete concern from the diff. Aim for at most 12 targeted tool calls; exceed that only when you can name the risk being verified.",
    "The diff may be budget-trimmed: a trailing [PiGO review input manifest] lists every excluded or trimmed file with +A/-B stats and the reason.",
    "Lockfiles (package-lock.json/yarn.lock/pnpm-lock.yaml/*.lock) and build outputs (dist/, build/, node_modules/) are excluded unless the original task explicitly targets them. Flag out-of-scope changes (e.g. docs or lockfile edits unrelated to the task) as findings.",
    "Return JSON only with this exact shape:",
    '{"verdict":"approved|changes_requested","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low","file":null,"line":null,"title":"...","evidence":"...","requiredChange":"..."}]}',
    "Use changes_requested only for actionable defects. approved must not contain critical/high/medium findings.",
    // docs/24-i18n.md §10: the single locale instruction block. The reviewer's
    // own response is the run's visible output (summary + findings), so its
    // language follows the run's locale.
    localeInstruction(runLocale(input.run)),
  ].join("\n\n") + "\n\nDiff:\n";
  let reviewInput: ReturnType<typeof buildReviewDiff>;
  let reviewPrompt: string;
  try {
    const limits = reviewTransportLimits(reviewPrefix, reviewInputLimits());
    reviewInput = buildReviewDiff(input.diff, limits);
    reviewPrompt = reviewPrefix + reviewInput.text;
    assertPiCliInput(reviewPrompt);
  } catch (error) {
    if (!(error instanceof ReviewInputBudgetError) && !(error instanceof PiInputTransportError)) throw error;
    const transport = error instanceof PiInputTransportError;
    const stopped = guardText(transport ? PI_INPUT_TRANSPORT_TEXT : REVIEW_INPUT_BUDGET_TEXT, runLocale(input.run));
    await update(input.run, "needs_human", "reviewer", transport ? "pi.input_transport_blocked" : "review.input_budget_exceeded", stopped.message, {
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
      summary: stopped.message,
    }, { meta: { ...stopped.meta, originalDiffBytes: Buffer.byteLength(input.diff), ...(transport ? { reason: error.reason, inputBytes: error.bytes, transportLimit: error.limit } : {}) } });
    return { stopped: true };
  }
  await postUpdate(input.run.id, {
    event: {
      round: input.round,
      source: "reviewer",
      type: "review.input_prepared",
      message: `审核输入 ${reviewInput.originalBytes} → ${Buffer.byteLength(reviewInput.text)} 字节（thinking=${reviewerThinking}）`,
      meta: {
        originalDiffBytes: reviewInput.originalBytes,
        includedDiffBytes: reviewInput.includedBytes,
        emittedDiffBytes: Buffer.byteLength(reviewInput.text),
        promptBytes: Buffer.byteLength(reviewPrompt),
        fileCount: reviewInput.files.length,
        includedFiles: reviewInput.files.filter((file) => file.included).length,
        excludedFiles: reviewInput.files.filter((file) => !file.included).length,
        trimmedFiles: reviewInput.files.filter((file) => file.trimmed).length,
        trimmed: reviewInput.trimmed,
        thinking: reviewerThinking,
      },
    },
  }).catch(() => undefined);
  let firstReview: { text: string; usage: UsageTotals };
  await chat(input.run, "reviewer", "orchestrator", "reviewer", "prompt", reviewPrompt, input.signal);
  try {
    firstReview = await runPiWithRetry({
      cwd: input.snapshotPath,
      provider: input.run.reviewer.provider,
      model: input.run.reviewer.model,
      prompt: reviewPrompt,
      readOnly: true,
      thinking: reviewerThinking,
      apiKey: input.credentials.reviewer,
      diagnosticCredentials: Object.values(input.credentials),
      apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
      signal: input.signal,
      onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
    }, { runId: input.run.id, round: input.round, label: "审核 Agent", role: "reviewer", budget: input.budget, sessions: input.sessions, usage: input.usage });
  } catch (providerError) {
    if (providerError instanceof BudgetExceededError || providerError instanceof PiInputTransportError) throw providerError;
    const reason = diagnosticMessage(providerError, Object.values(input.credentials), 500);
    const kind = classifyProviderError(reason);
    const locale = runLocale(input.run);
    const failure = guardText(reviewProviderErrorText(kind, reason), locale);
    await update(input.run, "needs_human", "reviewer", "review.provider_error", failure.message, {
      usage: toRunUsage(input.usage),
      durationMs: Date.now() - input.started,
      summary: providerErrorSummary(kind, reason, locale).slice(0, 500),
    }, { meta: failure.meta });
    return { stopped: true };
  }
  addUsage(input.usage, firstReview.usage);
  await chat(input.run, "reviewer", "reviewer", "orchestrator", "response", redactJobSecrets(firstReview.text, input.credentials), input.signal);
  try {
    return { stopped: false, review: parseReview(redactJobSecrets(firstReview.text, input.credentials), input.round) };
  } catch (protocolError) {
    const reason = diagnosticMessage(protocolError, Object.values(input.credentials), 200);
    await postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "review.retry", message: `审核输出无法解析（${reason}），已要求 Reviewer 重新输出` } });
    let retryReview: { text: string; usage: UsageTotals };
    try {
      const protocolRepairPrompt = [
        "You are repairing the format of a completed code-review response. Do not inspect the repository and do not perform a new review.",
        `The previous response was rejected: ${reason}.`,
        "Return JSON only with this exact shape:",
        '{"verdict":"approved|changes_requested","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low","file":null,"line":null,"title":"...","evidence":"...","requiredChange":"..."}]}',
        "Preserve the previous response's substantive verdict and findings; only repair its protocol shape.",
        `Previous response:\n${redactJobSecrets(firstReview.text, input.credentials).slice(0, 64_000)}`,
      ].join("\n\n");
      retryReview = await runPiWithRetry({
        cwd: input.snapshotPath,
        provider: input.run.reviewer.provider,
        model: input.run.reviewer.model,
        prompt: protocolRepairPrompt,
        readOnly: true,
        thinking: "low",
        apiKey: input.credentials.reviewer,
        diagnosticCredentials: Object.values(input.credentials),
        apiKeyEnvironmentName: apiKeyEnvName(input.run.reviewer.provider),
        signal: input.signal,
        onActivity: (message) => postUpdate(input.run.id, { event: { round: input.round, source: "reviewer", type: "agent.activity", message } }),
      }, { runId: input.run.id, round: input.round, label: "审核 Agent（协议重试）", role: "reviewer", retry: true, budget: input.budget, sessions: input.sessions, usage: input.usage });
    } catch (providerError) {
      if (providerError instanceof BudgetExceededError || providerError instanceof PiInputTransportError) throw providerError;
      const providerReason = diagnosticMessage(providerError, Object.values(input.credentials), 500);
      const kind = classifyProviderError(providerReason);
      const failure = guardText(reviewProviderErrorText(kind, providerReason), runLocale(input.run));
      await update(input.run, "needs_human", "reviewer", "review.provider_error", failure.message, {
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
        summary: providerErrorSummary(kind, providerReason, runLocale(input.run)).slice(0, 500),
      }, { meta: failure.meta });
      return { stopped: true };
    }
    addUsage(input.usage, retryReview.usage);
    try {
      return { stopped: false, review: parseReview(redactJobSecrets(retryReview.text, input.credentials), input.round) };
    } catch (retryError) {
      const locale = runLocale(input.run);
      const invalidProtocol = guardText(INVALID_PROTOCOL_TEXT, locale);
      await update(input.run, "needs_human", "reviewer", "review.invalid_protocol", invalidProtocol.message, {
        usage: toRunUsage(input.usage),
        durationMs: Date.now() - input.started,
        summary: providerErrorSummary("protocol", `审核输出无法解析：${diagnosticMessage(retryError, Object.values(input.credentials), 300)}`, locale).slice(0, 500),
      }, { meta: invalidProtocol.meta });
      return { stopped: true };
    }
  }
}

function createRunActions() {
  return {
    performReview,
    async developRound(roundInput: DevelopmentRoundInput) {
      const { job: input, run, worktree, tracker, controller, usage, budget, sessions, round, firstRound, humanInstruction } = roundInput;
      let { plan, feedback, findings } = roundInput;
      const developmentDone = tracker.isCompleted(stages.development(round));
      if (developmentDone) {
        // AT-REL-002: the developer stage already finished before the restart, so
        // no developer model call is repeated; continue with checks and review.
        plan = tracker.payload<DevelopmentPlan>(stages.planning) ?? plan ?? fallbackPlan(run.task);
        assignPlanCodenames(run.id, plan);
        run.plan = plan;
        await update(run, "developing", "system", "checkpoint.development_restored", `第 ${round} 轮开发已由检查点确认完成，跳过重复的模型调用`, { plan });
        feedback = unresolvedFeedback(run.findings);
        findings = [...(run.findings ?? [])];
      } else if (round === 1) {
        const storedPlan = tracker.isCompleted(stages.planning) ? tracker.payload<DevelopmentPlan>(stages.planning) : undefined;
        plan = storedPlan ?? await planDevelopment(run, worktree, input.credentials, controller.signal, usage, budget, sessions);
        assignPlanCodenames(run.id, plan);
        run.plan = plan;
        if (storedPlan) {
          await postUpdate(run.id, {
            patch: { plan, usage: toRunUsage(usage) },
            event: { round, source: "system", type: "plan.restored", message: "从检查点恢复开发计划，跳过已完成的主 Agent 规划调用" },
          });
        } else {
          await postUpdate(run.id, {
            patch: { plan, usage: toRunUsage(usage) },
            event: {
              round,
              source: "developer",
              type: "plan.created",
              message: plan.tasks.length === 1
                ? `主 Agent 判定为${plan.complexity}任务，由单 Agent 完成`
                : `主 Agent 判定为${plan.complexity}任务，自动拆分为 ${plan.tasks.length} 个 Sub Agent`,
            },
          });
          await tracker.complete(stages.planning, plan);
        }
        if (plan.tasks.length > 1) {
          const integrationNotes = await orchestrateSubAgents({ run, project: worktree, worktree, plan, credentials: input.credentials, signal: controller.signal, usage, tracker, budget, sessions });
          const integrationPrompt = [
            "You are the lead integration agent. Work only in the current Git worktree.",
            `Original task: ${run.task}`,
            `Sub-agent plan and final states:\n${JSON.stringify(plan, null, 2)}`,
            integrationNotes.length ? `Items requiring your direct attention:\n${integrationNotes.join("\n")}` : "All completed sub-agent commits were merged successfully.",
            "Inspect the combined code, resolve integration gaps, complete any skipped work, and add or update end-to-end tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not undo correct sub-agent work.",
            // docs/24-i18n.md §10: the single locale instruction block.
            localeInstruction(runLocale(run)),
          ].join("\n\n");
          await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: integrationPrompt, sessionSuffix: "integrator", activityPrefix: "集成 Agent", usage, budget, role: "integrator", sessions });
        } else {
          const task = plan.tasks[0];
          task.status = "running";
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.started", message: "单 Agent 开始实现" } });
          const developerPrompt = [
            "You are the developer agent. Work only in the current Git worktree.",
            `Task: ${run.task}`,
            "Inspect the repository, implement the task completely, and add or update tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not claim checks passed unless you ran them.",
            // docs/24-i18n.md §10: the single locale instruction block.
            localeInstruction(runLocale(run)),
          ].join("\n\n");
          const summary = await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: developerPrompt, sessionSuffix: "developer", usage, budget, sessions });
          task.status = "merged";
          task.summary = redactJobSecrets(summary, input.credentials).slice(0, 1_000);
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.completed", message: "单 Agent 实现完成" } });
        }
      } else {
        const repairSections = [
          "You are the repair developer agent. Work only in the current Git worktree.",
          `Original task: ${run.task}`,
          `Required fixes from checks or review:\n${feedback}`,
        ];
        if (round === firstRound && humanInstruction) {
          repairSections.push(`人工指令（来自工作区所有者，最高优先级，必须满足）：\n${humanInstruction}`);
        }
        repairSections.push("Inspect the existing combined implementation, make the required fixes, and update tests.", "Do not push, deploy, delete the repository, or read credentials.");
        // docs/24-i18n.md §10: the single locale instruction block.
        repairSections.push(localeInstruction(runLocale(run)));
        // COST-004: 返修复用 Developer 会话（保留已实现上下文），只注入新增反馈与必要上下文。
        await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: repairSections.join("\n\n"), sessionSuffix: "developer", activityPrefix: "修复 Agent", usage, budget, sessions });
      }
      if (!developmentDone) await tracker.complete(stages.development(round), { round, at: new Date().toISOString() });
      return { plan, feedback, findings };
    },
  };
}

const runActions = createRunActions();
const jobs = createWorkerJobs((input, controller) => executeJob(input, controller, runActions));
const { pendingJobWake, drainDeferredJobs } = jobs;
const server = createWorkerServer(jobs);

await initializeSandbox();

// P1: on SIGTERM/SIGINT stop claiming jobs, stop the sandbox containers this
// worker started (bounded wait, then force-kill) and only then exit, so no
// sandbox is left writing into a run worktree. GAP-05: never leave a workspace
// locked by a worker that is shutting down.
const shutdown = createShutdownHandler({
  stopClaiming: () => {
    stopClaimingJobs();
    pendingJobWake.stop();
    server.close();
  },
  stopSandboxes: () => sandboxContainers.stopAll(),
  releaseLocks: () => workspaceLocks.releaseAllSync(),
  exit: (code) => process.exit(code),
  log: (message) => process.stdout.write(`${message}\n`),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // `on`, not `once`: a repeated signal must reach the handler (which ignores it)
  // instead of falling through to the default handler and killing the process
  // before the sandboxes have stopped.
  process.on(signal, () => { void shutdown(signal); });
}

server.listen(port, host, () => {
  process.stdout.write(`pigo-worker listening on http://${host}:${port}\n`);
  pendingJobWake.wake();
  const timer = setInterval(() => {
    pendingJobWake.wake();
    // A deferred job whose holder went stale (crash) has no release event.
    void drainDeferredJobs();
    // AT-JEV-056: hourly (self-throttled) decision-audit retention sweep. A
    // no-op unless PI_DECISION_AUDIT_RETENTION_DAYS is a positive integer, and
    // it never rejects, so it cannot affect the maintenance loop.
    void triggerAuditRetention();
  }, 60_000);
  timer.unref?.();
});
