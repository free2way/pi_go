import path from "node:path";
import type { RunRoleUsage } from "../shared/types.js";
import { type CommandResult } from "./checks.js";
import { UsageTracker, addUsage, assistantErrorFromEvent, assistantTextFromEvent, emptyUsage, toolNameFromEvent, type UsageTotals } from "./pi-events.js";
import { BudgetExceededError, type RunBudgetContext } from "./run-budget.js";
import { runProviderOperation } from "./provider-attempts.js";
import { roleCredentialVariables, scrubEnvironment } from "./pi-env.js";
import { prepareProcessPiState } from "./pi-process-state.js";
import { createPiAdmission, PiAdmissionProtocolError } from "./pi-admission.js";
import { apiKeyEnvNames } from "./provider-errors.js";
import { assertPiCliInput } from "./pi-cli-input.js";
import { prepareSandboxStateDirectory, sandboxStateDirectory } from "./sandbox.js";
import { PiRunError } from "./agent-failure.js";
import { redactWorkerDiagnostic } from "./diagnostic-redaction.js";
import { pluginArguments, pluginMounts, selectPlugins, verifyPluginPins, type PluginDenial } from "./plugin-policy.js";
import { SessionAccumulator, planPiSession, type PiSessionRole } from "./pi-session.js";
import { shouldRetryProviderAttempt } from "./review-performance.js";
import {
  assertSandboxReady, pluginPolicy, requirePluginPin, sandboxMode, pluginContainerBase,
  diagnosticMessage, agentNetwork, sessionReuse, cliSessionManager, reviewerRetryMaxElapsed,
} from "./worker-runtime.js";
import { runInSandbox, repositoryForWorktree, sandboxEnvironment, command } from "./worker-process.js";
import { postUpdate } from "./worker-web-client.js";

const reportedPluginEvents = new Set<string>();
async function reportPluginPolicy(runId: string, round: number, enabled: string[], denials: PluginDenial[]) {
  if (reportedPluginEvents.size > 500) reportedPluginEvents.clear();
  for (const denial of denials) {
    const key = `${runId}:denied:${denial.path}:${denial.reason}`;
    if (reportedPluginEvents.has(key)) continue;
    reportedPluginEvents.add(key);
    await postUpdate(runId, {
      event: {
        round,
        source: "system",
        type: "plugin.denied",
        message: `插件未启用：${denial.path}（${denial.reason}）`,
        meta: { path: denial.path, kind: denial.kind, reason: denial.reason },
      },
    }).catch(() => undefined);
  }
  const enabledKey = `${runId}:enabled`;
  if (enabled.length > 0 && !reportedPluginEvents.has(enabledKey)) {
    reportedPluginEvents.add(enabledKey);
    await postUpdate(runId, {
      event: {
        round,
        source: "system",
        type: "plugin.enabled",
        message: `已按 allowlist 启用 ${enabled.length} 个受控插件：${enabled.join("、")}`,
        meta: { plugins: enabled },
      },
    }).catch(() => undefined);
  }
}

function parsePiLine(line: string) {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
}

export async function runPi(input: {
  cwd: string;
  provider: string;
  model: string;
  prompt: string;
  sessionId?: string;
  readOnly?: boolean;
  /** Reasoning effort for Pi (planner uses a cheaper level, COST-006). */
  thinking?: "low" | "medium" | "high";
  /** Explicit state location for nested sub-agent worktrees. */
  statePath?: string;
  apiKey: string;
  /** Worker-only redaction context; never forwarded to Pi or its environment. */
  diagnosticCredentials?: readonly string[];
  apiKeyEnvironmentName: string;
  signal: AbortSignal;
  onActivity: (message: string) => Promise<void>;
  /** COST/GAP-02: the calling role gates which allowlisted plugins are enabled. */
  role?: RunRoleUsage["role"];
  /** Requirement refinement is deliberately plugin-free even when global plugins exist. */
  allowPlugins?: boolean;
  /** Interactive helpers use a much smaller deadline than a development run. */
  timeoutMs?: number;
  /** Empty string disables every Pi tool for pure structured generation. */
  tools?: string;
  admission?: {
    validateFirst: () => void;
    reserveAdditional: (usage: UsageTotals) => void;
    account: (entry: { calls: number; unknownCalls: number; usage: UsageTotals }) => void;
  };
}) {
  assertPiCliInput(input.prompt);
  const args = [
    "--mode", "json",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--provider", input.provider,
    "--model", input.model,
    "--thinking", input.thinking === "low" || input.thinking === "medium" ? input.thinking : "high",
    "--tools", input.tools ?? (input.readOnly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls"),
  ];
  // P1 (fail-closed): never fall through to an in-process Pi call when the
  // container sandbox is unavailable.
  assertSandboxReady();
  // GAP-02: re-enable only allowlisted resources. The `--no-*` flags above
  // disable discovery (including project `.pi/extensions`); explicit paths still
  // load, so the allowlist is the single source of truth.
  const selected = input.allowPlugins === false
    ? { enabled: [], denials: [] }
    : selectPlugins(pluginPolicy, input.role ?? "developer");
  // AT-PI-007 / AT-SEC-014: re-verify pinned content immediately before every Pi
  // invocation. A mismatch (or a missing pin when required) denies that plugin;
  // it is never passed to Pi and the denial is reported as a `plugin.denied` event.
  const verified = await verifyPluginPins(selected.enabled, { requirePin: requirePluginPin });
  const enabled = verified.enabled;
  const denials = [...selected.denials, ...verified.denials];
  const mounts = sandboxMode === "container" ? pluginMounts(enabled, pluginContainerBase) : [];
  const containerPathByHost = new Map(mounts.map((mount) => [mount.hostPath, mount.containerPath]));
  args.push(...pluginArguments(enabled, (hostPath) => containerPathByHost.get(hostPath) ?? hostPath));
  const enabledLabels = enabled.map((entry) => `${entry.kind}:${entry.path}`);
  if (input.sessionId) args.push("--session-id", input.sessionId);
  else args.push("--no-session");
  args.push("--", input.prompt);
  let finalText = "";
  let lastAssistantError: string | undefined;
  const tracker = new UsageTracker();
  let activityQueue = Promise.resolve();
  // SEC-003/010: only the current role's credential reaches the agent process;
  // the worker's own tokens and the other role's key are stripped.
  const credentialEnvironmentNames = apiKeyEnvNames(input.provider);
  const roleEnvironment = roleCredentialVariables(input.provider, input.apiKey);
  const childEnvironment = { ...scrubEnvironment(process.env, credentialEnvironmentNames), ...roleEnvironment };
  if (sandboxMode !== "container") {
    // Never write retry overrides, sessions or auth into the operator's home.
    childEnvironment.PI_CODING_AGENT_DIR = await prepareProcessPiState({
      worktree: input.cwd,
      statePath: input.statePath,
      provider: input.provider,
      apiKeyEnvironmentName: input.apiKeyEnvironmentName,
      modelsFile: process.env.PI_SANDBOX_MODELS_FILE
        || (process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "models.json") : "/app/pi-models.json"),
    });
  }
  const runTimeoutMs = input.timeoutMs ?? Number(process.env.PI_RUN_TIMEOUT_SECONDS || 1800) * 1000;
  const stateDirectory = sandboxStateDirectory(input.cwd, input.statePath);
  const admissionAbort = new AbortController();
  if (input.admission) await prepareSandboxStateDirectory(stateDirectory);
  const admission = input.admission ? await createPiAdmission({
    stateDirectory,
    validateFirst: input.admission.validateFirst,
    reserveAdditional: input.admission.reserveAdditional,
    onFault: () => admissionAbort.abort(),
  }) : undefined;
  const signal = admission ? AbortSignal.any([input.signal, admissionAbort.signal]) : input.signal;
  const sandboxArgv = admission
    ? ["node", path.join("/home/node/.pi", path.relative(stateDirectory, admission.runtime)), ...args]
    : ["pi", ...args];
  const onStdoutLine = (line: string) => {
      const event = parsePiLine(line);
      if (!event) return;
      tracker.track(event);
      if (event.type === "message_end" || event.type === "pigo_compaction_request_end") {
        const message = event.message as { role?: string } | undefined;
        if (message?.role === "assistant") {
          const error = assistantErrorFromEvent(event);
          // Summary success cannot clear a primary response's error. Only a
          // completed primary response can replace that result; summary errors
          // must still fail the invocation when Pi terminates with exit zero.
          if (event.type === "message_end" || error) lastAssistantError = error;
        }
      }
      finalText = assistantTextFromEvent(event) || finalText;
      const toolName = toolNameFromEvent(event);
      if (toolName) {
        const activity = diagnosticMessage(`Pi 正在调用 ${toolName}`, [input.apiKey, ...(input.diagnosticCredentials ?? [])]);
        activityQueue = activityQueue.then(() => input.onActivity(activity)).catch(() => undefined);
      }
  };
  let result: CommandResult | undefined;
  let executionError: unknown;
  try {
    result = sandboxMode === "container"
    ? await runInSandbox({
        argv: sandboxArgv,
        worktree: input.cwd,
        // GAP-03: the reviewer reads its own snapshot, which has no git metadata
        // to share, and the mount is read-only.
        repository: input.readOnly ? undefined : await repositoryForWorktree(input.cwd),
        readOnly: input.readOnly,
        env: sandboxEnvironment({
          ...roleEnvironment,
          ...(input.readOnly ? { PIGO_SANDBOX_READONLY: "1" } : {}),
        }),
        network: agentNetwork,
        timeoutMs: runTimeoutMs,
        signal,
        onStdoutLine,
        label: "pi-agent",
        ...(mounts.length > 0 ? { pluginMounts: mounts } : {}),
        ...(input.statePath ? { statePath: input.statePath } : {}),
      })
    : await command(admission ? process.execPath : "pi", admission ? [admission.runtime, ...args] : args, {
        cwd: input.cwd,
        env: childEnvironment,
        signal,
        timeoutMs: runTimeoutMs,
        onStdoutLine,
      });
  } catch (error) { executionError = error; }
  const settled = await admission?.finish();
  const deniedFirstRequest = settled?.admitted === 0 && settled.error instanceof BudgetExceededError;
  const calls = deniedFirstRequest ? 0 : Math.max(1, settled?.admitted ?? tracker.reportedCalls);
  input.admission?.account({ calls, unknownCalls: Math.max(0, calls - tracker.reportedCalls), usage: { ...tracker.totals } });
  await activityQueue;
  if (settled?.error) throw settled.error;
  if (executionError) throw executionError;
  if (!result) throw new PiAdmissionProtocolError();
  // GAP-05: carry the captured output so a failed call's evidence is not lost.
  if (result.code !== 0) {
    throw new PiRunError(result.stderr.trim() || `Pi exited with ${result.code}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (lastAssistantError) throw new Error(lastAssistantError);
  return { text: finalText.trim(), usage: tracker.totals, modelCalls: calls, plugins: { enabled: enabledLabels, denials } };
}

/**
 * REL-005 / AT-REL-006: wraps one Pi invocation with bounded backoff so a burst
 * of 429/5xx errors retries a few times before the run is parked for a human.
 *
 * Sprint 2: also resolves the Pi *session* plan (id, resume, fresh) and emits a
 * `session.metrics` event, aggregating the invocation into the run's additive
 * `sessions` summary. The run's token totals still come from the existing
 * `addUsage`/`budget.record` path, so sessions never double count them.
 */
export async function runPiWithRetry(
  input: Parameters<typeof runPi>[0],
  context: { runId: string; round: number; label: string; role: PiSessionRole; sessionKey?: string; retry?: boolean; budget?: RunBudgetContext; sessions?: SessionAccumulator; usage?: UsageTotals },
) {
  // Local validation is outside retry/session/budget accounting.
  assertPiCliInput(input.prompt);
  const budget = context.budget;
  const plan = planPiSession({ role: context.role, run: context.runId, round: context.round, retry: context.retry, key: context.sessionKey, reuse: sessionReuse });
  // Sprint 2: the CLI session manager wraps the existing invocation (same
  // session id, same retry/budget behaviour) and reports per-session metrics.
  const call = await cliSessionManager.execute({
    plan,
    signal: input.signal,
    onActivity: message => input.onActivity(diagnosticMessage(message, [input.apiKey, ...(input.diagnosticCredentials ?? [])])),
    invoke: async (sessionId) => {
      let modelCalls = 0;
      const safeProviderMessage = (message: string) => redactWorkerDiagnostic(message, [input.apiKey, ...(input.diagnosticCredentials ?? [])]);
      // NEW-08/AUD-10: every provider attempt (including failed retries) is
      // reserved and accounted; the hard model-call limit stops the retry loop.
      const outcome = await runProviderOperation(async () => {
        let accounting = { calls: 1, unknownCalls: 1, usage: emptyUsage() };
        let successful = false;
        try {
          const result = await runPi({ ...input, sessionId, role: context.role,
            ...(budget ? { admission: {
              validateFirst: () => budget.validateReserved(),
              reserveAdditional: (usage: UsageTotals) => budget.reserve(context.role, usage),
              account: (entry: typeof accounting) => { accounting = entry; },
            } } : {}),
          });
          successful = true;
          if (!budget) accounting.calls = result.modelCalls;
          return result;
        } finally {
          modelCalls += accounting.calls;
          try {
            if (budget) {
              if (accounting.calls > 0) await budget.record(context.role, input, accounting.usage, accounting);
              else budget.release();
            }
          } finally {
            // A later error must not discard earlier successful tool turns.
            // Successful callers still add their final result exactly once.
            if (!successful && context.usage) addUsage(context.usage, accounting.usage);
          }
        }
      }, {
        signal: input.signal,
        budget: budget
          ? { reserve: () => budget.reserve(context.role), recordUnknown: () => undefined }
          : undefined,
        shouldRetry: ({ elapsedMs }) => shouldRetryProviderAttempt({
          role: context.role,
          elapsedMs,
          reviewerMaxElapsedMs: reviewerRetryMaxElapsed,
        }),
        onAttemptFailure: async ({ attempt, elapsedMs, kind, message, willRetry }) => {
          const safeMessage = safeProviderMessage(message);
          const lateReviewerFailure = context.role === "reviewer"
            && Number.isFinite(reviewerRetryMaxElapsed)
            && elapsedMs > reviewerRetryMaxElapsed;
          await postUpdate(context.runId, {
            event: {
              round: context.round,
              source: "system",
              type: "provider.attempt_failed",
              message: lateReviewerFailure
                ? `${context.label} 第 ${attempt} 次调用运行 ${(elapsedMs / 1000).toFixed(1)}s 后失败；为避免从零重复长审核，已停止自动重试：${safeMessage.slice(0, 160)}`
                : `${context.label} 第 ${attempt} 次调用在 ${(elapsedMs / 1000).toFixed(1)}s 后失败（${kind}）${willRetry ? "，准备重试" : "，不再重试"}`,
              meta: {
                attempt,
                durationMs: elapsedMs,
                kind,
                willRetry,
                role: context.role,
                provider: input.provider,
                model: input.model,
                thinking: input.thinking ?? "high",
                promptBytes: Buffer.byteLength(input.prompt),
                lateReviewerFailure,
                ...(Number.isFinite(reviewerRetryMaxElapsed) ? { reviewerRetryMaxElapsedMs: reviewerRetryMaxElapsed } : {}),
              },
            },
          }).catch(() => undefined);
        },
        onRetry: async ({ attempt, delayMs, kind, message, elapsedMs }) => {
          const safeMessage = safeProviderMessage(message);
          await postUpdate(context.runId, {
            event: {
              round: context.round,
              source: "system",
              type: "provider.retry",
              message: `${context.label} 调用遇到${kind}错误，约 ${Math.max(1, Math.round(delayMs / 1000))} 秒后重试（第 ${attempt} 次）：${safeMessage.slice(0, 200)}`,
              meta: { attempt, delayMs, durationMs: elapsedMs, kind, role: context.role, provider: input.provider, model: input.model },
            },
          }).catch(() => undefined);
        },
      });
      return { result: outcome, usage: outcome.usage, modelCalls };
    },
    onMetrics: async (metrics) => {
      // Instrumentation only: the run's token totals still come from the
      // addUsage/budget.record path, so sessions never double count them. A
      // failed metrics write never fails the run.
      const summaries = context.sessions?.merge(metrics, new Date().toISOString());
      await postUpdate(context.runId, {
        ...(summaries ? { patch: { sessions: summaries } } : {}),
        event: {
          round: context.round,
          source: "system",
          type: "session.metrics",
          message: `会话 ${metrics.sessionId}（${plan.role} · 第 ${plan.round} 轮 · ${plan.resume ? "复用" : "新建"}）：${metrics.modelCalls} 次调用，${(metrics.durationMs / 1000).toFixed(1)}s`,
          meta: {
            ...metrics,
            provider: input.provider,
            model: input.model,
            thinking: input.thinking ?? "high",
            promptBytes: Buffer.byteLength(input.prompt),
          },
        },
      }).catch(() => undefined);
    },
  });
  const result = call.result;
  // GAP-02: surface allowlist decisions as audit events (never silent).
  await reportPluginPolicy(context.runId, context.round, result.plugins.enabled, result.plugins.denials);
  return result;
}
