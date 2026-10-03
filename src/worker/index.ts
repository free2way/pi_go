import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { CheckResult, DevelopmentPlan, Finding, ProjectInfo, Run, RunEvent, RunState, SubAgentTask } from "../shared/types.js";
import { executionWaves, fallbackPlan, parseDevelopmentPlan } from "./orchestrator.js";
import { UsageTracker, addUsage, assistantTextFromEvent, emptyUsage, toRunUsage, toolNameFromEvent, type UsageTotals } from "./pi-events.js";
import { parseReview, type ReviewResult } from "./review-protocol.js";

const port = Number(process.env.PORT || 3200);
const host = process.env.HOST || "localhost";
const workspaceRoot = path.resolve(process.env.PI_WORKSPACE_ROOT || "/workspace");
const projectsRoot = path.join(workspaceRoot, "projects");
const runsRoot = path.join(workspaceRoot, "runs");
const callbackBase = process.env.PI_WEB_CALLBACK_URL || "http://web:3100";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
const maxOutput = 48_000;
const configuredMaxSubagents = Number(process.env.PI_MAX_SUBAGENTS || 3);
const maxSubagents = Number.isInteger(configuredMaxSubagents) ? Math.min(4, Math.max(1, configuredMaxSubagents)) : 3;
const configuredMaxActiveJobs = Number(process.env.PI_MAX_ACTIVE_JOBS || 1);
const maxActiveJobs = Number.isInteger(configuredMaxActiveJobs) ? Math.min(4, Math.max(1, configuredMaxActiveJobs)) : 1;
const active = new Map<string, AbortController>();
let worktreeMutationQueue: Promise<void> = Promise.resolve();

function serializeWorktreeMutation<T>(operation: () => Promise<T>) {
  const result = worktreeMutationQueue.then(operation, operation);
  worktreeMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

type JobInput = {
  run: Run;
  checks: string[];
  credentials: {
    developer: string;
    reviewer: string;
  };
};

function redactJobSecrets(message: string, credentials: JobInput["credentials"]) {
  return [credentials.developer, credentials.reviewer].reduce(
    (safe, secret) => secret ? safe.replaceAll(secret, "[redacted]") : safe,
    message,
  );
}

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

function authorized(request: IncomingMessage) {
  if (!internalToken) return false;
  const header = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${internalToken}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

const maxCallbackBytes = 3 * 1024 * 1024;

function encodeCallbackBody(input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}) {
  let body = JSON.stringify(input);
  if (Buffer.byteLength(body) <= maxCallbackBytes) return body;
  const patch = input.patch as Record<string, unknown> | undefined;
  if (patch && typeof patch.diff === "string") patch.diff = patch.diff.slice(0, 400_000);
  body = JSON.stringify(input);
  if (Buffer.byteLength(body) > maxCallbackBytes && Array.isArray(patch?.checks)) {
    for (const check of patch.checks as Array<Record<string, unknown>>) {
      if (typeof check.output === "string") check.output = check.output.slice(-4_000);
    }
    body = JSON.stringify(input);
  }
  if (Buffer.byteLength(body) > maxCallbackBytes) throw new Error("Callback payload exceeds the 3 MiB safety limit");
  return body;
}

async function postUpdate(runId: string, input: {
  patch?: Partial<Run>;
  event?: Omit<RunEvent, "seq" | "runId" | "at">;
}) {
  const response = await fetch(`${callbackBase}/api/internal/runs/${runId}/update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalToken}`,
      "Content-Type": "application/json",
    },
    body: encodeCallbackBody(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Callback failed: ${response.status}`);
}

async function update(run: Run, state: RunState, source: RunEvent["source"], type: string, message: string, patch: Partial<Run> = {}) {
  Object.assign(run, patch, { state });
  await postUpdate(run.id, {
    patch: { state, ...patch },
    event: { round: run.round, source, type, message },
  });
}

type CommandResult = { code: number; stdout: string; stderr: string };

function command(commandName: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 1_800_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-maxOutput);
      options.onStdoutLine?.(line);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-maxOutput); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.name === "AbortError") resolve({ code: 130, stdout, stderr: "aborted" });
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await command("git", args, { cwd, signal, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function resolveProject(relative: string) {
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid project path");
  }
  const root = await realpath(projectsRoot);
  const candidate = await realpath(path.join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("Project is outside allowed root");
  if ((await git(candidate, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("Project is not a Git repository");
  return candidate;
}

async function listProjects(): Promise<ProjectInfo[]> {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(projectsRoot, entry.name);
    try {
      await stat(path.join(directory, ".git"));
      projects.push({
        id: entry.name,
        name: entry.name,
        relativePath: entry.name,
        branch: await git(directory, ["branch", "--show-current"]),
        dirty: Boolean(await git(directory, ["status", "--porcelain"])),
      });
    } catch {
      // Ignore non-Git directories.
    }
  }
  return projects;
}

function parsePiLine(line: string) {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
}

async function runPi(input: {
  cwd: string;
  provider: string;
  model: string;
  prompt: string;
  sessionId?: string;
  readOnly?: boolean;
  apiKey: string;
  apiKeyEnvironmentName: "DEEPSEEK_API_KEY" | "OPENAI_API_KEY";
  signal: AbortSignal;
  onActivity: (message: string) => Promise<void>;
}) {
  const args = [
    "--mode", "json",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider", input.provider,
    "--model", input.model,
    "--thinking", "high",
    "--tools", input.readOnly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls",
  ];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  else args.push("--no-session");
  args.push("--", input.prompt);
  let finalText = "";
  const tracker = new UsageTracker();
  let activityQueue = Promise.resolve();
  const childEnvironment = { ...process.env };
  delete childEnvironment.DEEPSEEK_API_KEY;
  delete childEnvironment.OPENAI_API_KEY;
  childEnvironment[input.apiKeyEnvironmentName] = input.apiKey;
  const result = await command("pi", args, {
    cwd: input.cwd,
    env: childEnvironment,
    signal: input.signal,
    timeoutMs: Number(process.env.PI_RUN_TIMEOUT_SECONDS || 1800) * 1000,
    onStdoutLine: (line) => {
      const event = parsePiLine(line);
      if (!event) return;
      tracker.track(event);
      finalText = assistantTextFromEvent(event) || finalText;
      const toolName = toolNameFromEvent(event);
      if (toolName) {
        activityQueue = activityQueue.then(() => input.onActivity(`Pi 正在调用 ${toolName}`)).catch(() => undefined);
      }
    },
  });
  await activityQueue;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Pi exited with ${result.code}`);
  return { text: finalText.trim(), usage: tracker.totals };
}

async function collectDiff(worktree: string, signal: AbortSignal, baseRef?: string) {
  await git(worktree, ["add", "-N", "."], signal);
  const args = baseRef ? ["diff", "--no-ext-diff", baseRef, "--", "."] : ["diff", "--no-ext-diff", "--", "."];
  return (await git(worktree, args, signal)).slice(0, 120_000);
}

async function planDevelopment(run: Run, worktree: string, credentials: JobInput["credentials"], signal: AbortSignal, usage: UsageTotals) {
  const prompt = [
    "You are the lead engineering planner. Inspect the current repository read-only and size the requested implementation.",
    `Task: ${run.task}`,
    `You may create at most ${maxSubagents} implementation tasks. Prefer one task for small cohesive changes.`,
    "Use multiple tasks only when work can be separated by component or file ownership.",
    "Tasks in the same dependency wave must not edit overlapping files. Add dependsOn for ordering when one task needs another.",
    "Return JSON only with this exact shape:",
    '{"complexity":"small|medium|large","rationale":"...","tasks":[{"id":"kebab-id","title":"...","description":"...","files":["relative/path"],"dependsOn":[]}]}',
  ].join("\n\n");
  try {
    const result = await runPi({
      cwd: worktree,
      provider: run.developer.provider,
      model: run.developer.model,
      prompt,
      readOnly: true,
      apiKey: credentials.developer,
      apiKeyEnvironmentName: "DEEPSEEK_API_KEY",
      signal,
      onActivity: (message) => postUpdate(run.id, { event: { round: run.round, source: "developer", type: "planner.activity", message: `主 Agent：${message}` } }),
    });
    addUsage(usage, result.usage);
    return parseDevelopmentPlan(redactJobSecrets(result.text, credentials), maxSubagents);
  } catch (error) {
    const safeMessage = redactJobSecrets((error as Error).message, credentials);
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
  usage: UsageTotals;
}) {
  const result = await runPi({
    cwd: input.worktree,
    provider: input.run.developer.provider,
    model: input.run.developer.model,
    prompt: input.prompt,
    sessionId: `${input.run.id.replaceAll("_", "-")}-${input.sessionSuffix}`,
    apiKey: input.credentials.developer,
    apiKeyEnvironmentName: "DEEPSEEK_API_KEY",
    signal: input.signal,
    onActivity: (message) => postUpdate(input.run.id, {
      event: {
        round: input.run.round,
        source: "developer",
        type: "agent.activity",
        message: input.activityPrefix ? `${input.activityPrefix}：${message}` : message,
      },
    }),
  });
  addUsage(input.usage, result.usage);
  return result.text;
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
}): Promise<SubAgentResult> {
  const startedAt = Date.now();
  const branch = `${input.mainBranch}/sub-${input.task.id}`;
  const worktree = path.join(runsRoot, input.run.ownerId, `${input.run.id}-subagents`, input.task.id);
  input.task.status = "running";
  input.task.branch = branch;
  await mkdir(path.dirname(worktree), { recursive: true });
  await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.started", message: `Sub Agent「${input.task.title}」开始执行` } });
  try {
    await serializeWorktreeMutation(() => git(input.project, ["worktree", "add", "-b", branch, worktree, input.mainBranch], input.signal));
    const prompt = [
      "You are a focused implementation sub-agent. Work only in the current Git worktree.",
      `Overall task: ${input.run.task}`,
      `Your assigned task: ${input.task.title}\n${input.task.description}`,
      input.task.files.length ? `Primary file ownership: ${input.task.files.join(", ")}` : "Inspect and limit changes to the smallest coherent scope.",
      "Implement only your assigned part and its focused tests. Do not push, deploy, read credentials, or modify unrelated areas.",
      "Other sub-agents may work in parallel. Avoid broad formatting and generated dependency updates unless explicitly required.",
    ].join("\n\n");
    const summary = await runDeveloperAgent({
      run: input.run,
      worktree,
      credentials: input.credentials,
      signal: input.signal,
      prompt,
      sessionSuffix: `sub-${input.task.id}`,
      activityPrefix: `Sub Agent「${input.task.title}」`,
      usage: input.usage,
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
    await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.completed", message: `Sub Agent「${input.task.title}」完成` } });
    return { task: input.task, branch, worktree, commit };
  } catch (error) {
    const safeMessage = redactJobSecrets((error as Error).message, input.credentials);
    input.task.status = "failed";
    input.task.summary = safeMessage.slice(0, 1_000);
    input.task.durationMs = Date.now() - startedAt;
    await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.failed", message: `Sub Agent「${input.task.title}」失败，将由集成 Agent 接管` } });
    return { task: input.task, branch, worktree, error: safeMessage };
  }
}

async function removeSubAgentWorktree(project: string, worktree: string) {
  await serializeWorktreeMutation(() => git(project, ["worktree", "remove", "--force", worktree])).catch(() => undefined);
}

async function orchestrateSubAgents(input: {
  run: Run;
  project: string;
  worktree: string;
  plan: DevelopmentPlan;
  credentials: JobInput["credentials"];
  signal: AbortSignal;
  usage: UsageTotals;
}) {
  const integrationNotes: string[] = [];
  for (const wave of executionWaves(input.plan.tasks)) {
    const runnable = wave.filter((task) => task.dependsOn.every((id) => input.plan.tasks.find((item) => item.id === id)?.status === "merged"));
    for (const task of wave.filter((item) => !runnable.includes(item))) {
      task.status = "failed";
      task.summary = "A dependency failed to merge";
      integrationNotes.push(`${task.title}: skipped because a dependency failed`);
    }
    if (runnable.length === 0) continue;
    for (const task of runnable) task.status = "running";
    await postUpdate(input.run.id, { patch: { plan: input.plan }, event: { round: input.run.round, source: "system", type: "subagents.wave_started", message: `并行启动 ${runnable.length} 个 Sub Agent` } });
    const results = await Promise.all(runnable.map((task) => runSubAgent({
      run: input.run,
      project: input.project,
      mainBranch: input.run.branch,
      task,
      credentials: input.credentials,
      signal: input.signal,
      usage: input.usage,
    })));
    for (const result of results) {
      try {
        if (result.error) {
          integrationNotes.push(`${result.task.title}: ${result.error}`);
          continue;
        }
        if (result.commit) {
          const merged = await command("git", ["cherry-pick", result.commit], { cwd: input.worktree, signal: input.signal, timeoutMs: 120_000 });
          if (merged.code !== 0) {
            await command("git", ["cherry-pick", "--abort"], { cwd: input.worktree, timeoutMs: 120_000 }).catch(() => undefined);
            result.task.status = "failed";
            result.task.summary = `Merge conflict from ${result.branch}`;
            integrationNotes.push(`${result.task.title}: merge ${result.branch} manually`);
            continue;
          }
        }
        result.task.status = "merged";
        await postUpdate(input.run.id, { event: { round: input.run.round, source: "developer", type: "subagent.merged", message: `Sub Agent「${result.task.title}」已合并` } });
      } finally {
        await removeSubAgentWorktree(input.project, result.worktree);
      }
    }
    await postUpdate(input.run.id, { patch: { plan: input.plan }, event: { round: input.run.round, source: "system", type: "subagents.wave_completed", message: "本批 Sub Agent 执行完成，主 Agent 正在整合" } });
  }
  return integrationNotes;
}

async function runChecks(run: Run, worktree: string, commands: string[], signal: AbortSignal) {
  const results: CheckResult[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const checkCommand = commands[index];
    const started = Date.now();
    const current: CheckResult = { id: `check-${index + 1}`, name: `Check ${index + 1}`, command: checkCommand, status: "running" };
    await update(run, "checking", "checks", "check.started", `执行检查：${checkCommand}`, { checks: [...results, current] });
    const result = await command("/bin/sh", ["-lc", checkCommand], { cwd: worktree, signal, timeoutMs: 600_000 });
    results.push({
      ...current,
      status: result.code === 0 ? "passed" : "failed",
      durationMs: Date.now() - started,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-12_000),
    });
    await postUpdate(run.id, { patch: { checks: [...results] }, event: { round: run.round, source: "checks", type: result.code === 0 ? "check.passed" : "check.failed", message: `${checkCommand} ${result.code === 0 ? "通过" : "失败"}` } });
    if (result.code !== 0) return { passed: false, results };
  }
  return { passed: true, results };
}

async function executeJob(input: JobInput, controller: AbortController) {
  const run = input.run;
  const started = Date.now();
  const usage: UsageTotals = emptyUsage();
  try {
    const project = await resolveProject(run.repository);
    const dirty = await git(project, ["status", "--porcelain"], controller.signal);
    if (dirty) throw new Error("Source repository has uncommitted changes; clean it before starting a real run");
    const baseCommit = await git(project, ["rev-parse", "HEAD"], controller.signal);
    if (!/^[a-f0-9]{64}$/.test(run.ownerId)) throw new Error("Invalid run owner");
    const worktree = path.join(runsRoot, run.ownerId, run.id);
    await mkdir(path.dirname(worktree), { recursive: true });
    await update(run, "preparing", "system", "workspace.preparing", "正在创建隔离 Git worktree", { worktree: path.relative(workspaceRoot, worktree) });
    await git(project, ["worktree", "add", "-b", run.branch, worktree, "HEAD"], controller.signal);
    await update(run, "developing", "developer", "agent.started", `${run.developer.model} 主 Agent 开始评估工作量`, { summary: "主 Agent 正在分析任务并决定是否拆分 Sub Agent" });

    let feedback = "";
    let findings: Finding[] = [];
    let plan: DevelopmentPlan | undefined;
    for (let round = 1; round <= run.maxRounds; round += 1) {
      run.round = round;
      await postUpdate(run.id, { patch: { round }, event: { round, source: "system", type: "round.started", message: `开始第 ${round} 轮开发` } });
      if (round === 1) {
        plan = await planDevelopment(run, worktree, input.credentials, controller.signal, usage);
        run.plan = plan;
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
        if (plan.tasks.length > 1) {
          const integrationNotes = await orchestrateSubAgents({ run, project, worktree, plan, credentials: input.credentials, signal: controller.signal, usage });
          const integrationPrompt = [
            "You are the lead integration agent. Work only in the current Git worktree.",
            `Original task: ${run.task}`,
            `Sub-agent plan and final states:\n${JSON.stringify(plan, null, 2)}`,
            integrationNotes.length ? `Items requiring your direct attention:\n${integrationNotes.join("\n")}` : "All completed sub-agent commits were merged successfully.",
            "Inspect the combined code, resolve integration gaps, complete any skipped work, and add or update end-to-end tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not undo correct sub-agent work.",
          ].join("\n\n");
          await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: integrationPrompt, sessionSuffix: "integrator", activityPrefix: "集成 Agent", usage });
        } else {
          const task = plan.tasks[0];
          task.status = "running";
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.started", message: "单 Agent 开始实现" } });
          const developerPrompt = [
            "You are the developer agent. Work only in the current Git worktree.",
            `Task: ${run.task}`,
            "Inspect the repository, implement the task completely, and add or update tests.",
            "Do not push, deploy, delete the repository, or read credentials. Do not claim checks passed unless you ran them.",
          ].join("\n\n");
          const summary = await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: developerPrompt, sessionSuffix: "developer", usage });
          task.status = "merged";
          task.summary = redactJobSecrets(summary, input.credentials).slice(0, 1_000);
          await postUpdate(run.id, { patch: { plan }, event: { round, source: "developer", type: "developer.completed", message: "单 Agent 实现完成" } });
        }
      } else {
        const repairPrompt = [
          "You are the repair developer agent. Work only in the current Git worktree.",
          `Original task: ${run.task}`,
          `Required fixes from checks or review:\n${feedback}`,
          "Inspect the existing combined implementation, make the required fixes, and update tests.",
          "Do not push, deploy, delete the repository, or read credentials.",
        ].join("\n\n");
        await runDeveloperAgent({ run, worktree, credentials: input.credentials, signal: controller.signal, prompt: repairPrompt, sessionSuffix: `repair-${round}`, activityPrefix: "修复 Agent", usage });
      }
      const diff = await collectDiff(worktree, controller.signal, baseCommit);
      await update(run, "checking", "checks", "checks.started", "Developer 完成，开始确定性检查", { diff, summary: "正在运行项目检查", usage: toRunUsage(usage) });
      const checked = await runChecks(run, worktree, input.checks, controller.signal);
      if (!checked.passed) {
        feedback = `The deterministic checks failed. Fix these failures:\n${checked.results.filter((item) => item.status === "failed").map((item) => `${item.command}\n${item.output}`).join("\n\n")}`;
        await update(run, "developing", "checks", "checks.returned", "检查失败，已退回 Developer 修复", { summary: "检查失败，等待修复" });
        continue;
      }

      const latestDiff = await collectDiff(worktree, controller.signal, baseCommit);
      await update(run, "reviewing", "reviewer", "review.started", `${run.reviewer.model} 开始独立只读审核`, { diff: latestDiff, summary: "Reviewer Agent 正在审核" });
      const reviewPrompt = [
        "You are an independent read-only code reviewer. Do not modify files.",
        `Original task: ${run.task}`,
        "Review the current repository and the diff below for correctness, missing requirements, security, regressions, and test quality.",
        "Return JSON only with this exact shape:",
        '{"verdict":"approved|changes_requested","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low","file":null,"line":null,"title":"...","evidence":"...","requiredChange":"..."}]}',
        "Use changes_requested only for actionable defects. approved must not contain critical/high/medium findings.",
        `Diff:\n${latestDiff.slice(0, 90_000)}`,
      ].join("\n\n");
      const firstReview = await runPi({
        cwd: worktree,
        provider: run.reviewer.provider,
        model: run.reviewer.model,
        prompt: reviewPrompt,
        readOnly: true,
        apiKey: input.credentials.reviewer,
        apiKeyEnvironmentName: "OPENAI_API_KEY",
        signal: controller.signal,
        onActivity: (message) => postUpdate(run.id, { event: { round, source: "reviewer", type: "agent.activity", message } }),
      });
      addUsage(usage, firstReview.usage);
      let review: ReviewResult;
      try {
        review = parseReview(redactJobSecrets(firstReview.text, input.credentials), round);
      } catch (protocolError) {
        const reason = redactJobSecrets((protocolError as Error).message, input.credentials).slice(0, 200);
        await postUpdate(run.id, { event: { round, source: "reviewer", type: "review.retry", message: `审核输出无法解析（${reason}），已要求 Reviewer 重新输出` } });
        const retryReview = await runPi({
          cwd: worktree,
          provider: run.reviewer.provider,
          model: run.reviewer.model,
          prompt: `${reviewPrompt}\n\n上一次回复被拒绝：不是合法的协议 JSON。只输出 JSON 对象本身，不要 markdown 代码块，不要任何解释。`,
          readOnly: true,
          apiKey: input.credentials.reviewer,
          apiKeyEnvironmentName: "OPENAI_API_KEY",
          signal: controller.signal,
          onActivity: (message) => postUpdate(run.id, { event: { round, source: "reviewer", type: "agent.activity", message } }),
        });
        addUsage(usage, retryReview.usage);
        try {
          review = parseReview(redactJobSecrets(retryReview.text, input.credentials), round);
        } catch (retryError) {
          await update(run, "needs_human", "reviewer", "review.invalid_protocol", "Reviewer 两次输出均无法解析为审核协议，转人工处理", {
            usage: toRunUsage(usage),
            durationMs: Date.now() - started,
            summary: `审核输出无法解析：${redactJobSecrets((retryError as Error).message, input.credentials).slice(0, 500)}`,
          });
          return;
        }
      }
      const currentFindings = review.findings.map((item) => ({ ...item, resolved: false }));
      findings = [...findings.map((item) => ({ ...item, resolved: true })), ...currentFindings];
      if (review.verdict === "approved") {
        await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
          findings,
          diff: latestDiff,
          summary: review.summary,
          usage: toRunUsage(usage),
          durationMs: Date.now() - started,
        });
        return;
      }
      feedback = JSON.stringify(review.findings, null, 2);
      await update(run, "developing", "reviewer", "review.changes_requested", `审核发现 ${review.findings.length} 个问题，退回 Developer`, { findings, summary: review.summary, usage: toRunUsage(usage) });
    }
    await update(run, "needs_human", "system", "run.needs_human", "达到最大审核轮次，需要人工处理", { findings, usage: toRunUsage(usage), durationMs: Date.now() - started });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const safeMessage = redactJobSecrets((error as Error).message, input.credentials).slice(0, 2_000);
    await update(run, cancelled ? "cancelled" : "failed", "system", cancelled ? "run.cancelled" : "run.failed", cancelled ? "任务已取消" : `真实运行失败：${safeMessage}`, {
      summary: cancelled ? "已取消" : safeMessage,
      usage: toRunUsage(usage),
      durationMs: Date.now() - started,
    }).catch(() => undefined);
  } finally {
    input.credentials.developer = "";
    input.credentials.reviewer = "";
    active.delete(run.id);
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok", service: "pigo-worker", activeJobs: active.size });
    if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method === "GET" && url.pathname === "/projects") return json(response, 200, await listProjects());
    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJson(request) as unknown as JobInput;
      if (!body.run?.id || body.run.mode !== "real" || !Array.isArray(body.checks) || !body.credentials?.developer || !body.credentials?.reviewer) return json(response, 400, { error: "Invalid job" });
      if (active.has(body.run.id)) return json(response, 409, { error: "Job already active" });
      if (active.size >= maxActiveJobs) return json(response, 429, { error: "Worker capacity reached; retry after an active job finishes" });
      const controller = new AbortController();
      active.set(body.run.id, controller);
      void executeJob(body, controller);
      return json(response, 202, { accepted: true, runId: body.run.id });
    }
    const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const controller = active.get(cancelMatch[1]);
      if (!controller) return json(response, 404, { error: "Active job not found" });
      controller.abort();
      return json(response, 202, { cancelled: true });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 500, { error: (error as Error).message });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`pigo-worker listening on http://${host}:${port}\n`);
});
