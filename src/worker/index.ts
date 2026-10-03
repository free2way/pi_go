import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { CheckResult, Finding, ProjectInfo, Run, RunEvent, RunState } from "../shared/types.js";

const port = Number(process.env.PORT || 3200);
const host = process.env.HOST || "localhost";
const workspaceRoot = path.resolve(process.env.PI_WORKSPACE_ROOT || "/workspace");
const projectsRoot = path.join(workspaceRoot, "projects");
const runsRoot = path.join(workspaceRoot, "runs");
const callbackBase = process.env.PI_WEB_CALLBACK_URL || "http://web:3100";
const internalToken = process.env.PI_INTERNAL_TOKEN || "";
const maxOutput = 48_000;
const active = new Map<string, AbortController>();

type JobInput = {
  run: Run;
  checks: string[];
  credentials: {
    developer: string;
    reviewer: string;
  };
};

type ReviewResult = {
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: Array<Omit<Finding, "resolved">>;
};

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
  return Boolean(internalToken) && request.headers.authorization === `Bearer ${internalToken}`;
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
    body: JSON.stringify(input),
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

function extractAssistantText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (message?.role !== "assistant") return undefined;
  return message.content?.filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
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
      finalText = extractAssistantText(event) || finalText;
      if (event.type === "tool_execution_start") {
        const name = String((event.toolCall as { name?: string } | undefined)?.name || "tool");
        activityQueue = activityQueue.then(() => input.onActivity(`Pi 正在调用 ${name}`)).catch(() => undefined);
      }
    },
  });
  await activityQueue;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Pi exited with ${result.code}`);
  return finalText.trim();
}

function parseReview(text: string): ReviewResult {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as ReviewResult;
  if (!parsed || !["approved", "changes_requested"].includes(parsed.verdict) || !Array.isArray(parsed.findings)) {
    throw new Error("Reviewer returned an invalid protocol");
  }
  return parsed;
}

async function collectDiff(worktree: string, signal: AbortSignal) {
  await git(worktree, ["add", "-N", "."], signal);
  return (await git(worktree, ["diff", "--no-ext-diff", "--", "."], signal)).slice(0, 120_000);
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
  try {
    const project = await resolveProject(run.repository);
    const dirty = await git(project, ["status", "--porcelain"], controller.signal);
    if (dirty) throw new Error("Source repository has uncommitted changes; clean it before starting a real run");
    if (!/^[a-f0-9]{64}$/.test(run.ownerId)) throw new Error("Invalid run owner");
    const worktree = path.join(runsRoot, run.ownerId, run.id);
    await mkdir(path.dirname(worktree), { recursive: true });
    await update(run, "preparing", "system", "workspace.preparing", "正在创建隔离 Git worktree", { worktree: path.relative(workspaceRoot, worktree) });
    await git(project, ["worktree", "add", "-b", run.branch, worktree, "HEAD"], controller.signal);
    await update(run, "developing", "developer", "agent.started", `${run.developer.model} 开始真实开发`, { summary: "Developer Agent 正在修改代码" });

    let feedback = "";
    let findings: Finding[] = [];
    for (let round = 1; round <= run.maxRounds; round += 1) {
      run.round = round;
      await postUpdate(run.id, { patch: { round }, event: { round, source: "system", type: "round.started", message: `开始第 ${round} 轮开发` } });
      const developerPrompt = [
        "You are the developer agent. Work only in the current Git worktree.",
        `Task: ${run.task}`,
        "Inspect the repository, implement the task completely, and add or update tests.",
        "Do not push, deploy, delete the repository, or read credentials. Do not claim checks passed unless you ran them.",
        feedback ? `Reviewer feedback from the previous round:\n${feedback}` : "",
      ].filter(Boolean).join("\n\n");
      await runPi({
        cwd: worktree,
        provider: run.developer.provider,
        model: run.developer.model,
        prompt: developerPrompt,
        sessionId: `${run.id.replaceAll("_", "-")}-developer`,
        apiKey: input.credentials.developer,
        apiKeyEnvironmentName: "DEEPSEEK_API_KEY",
        signal: controller.signal,
        onActivity: (message) => postUpdate(run.id, { event: { round, source: "developer", type: "agent.activity", message } }),
      });
      const diff = await collectDiff(worktree, controller.signal);
      await update(run, "checking", "checks", "checks.started", "Developer 完成，开始确定性检查", { diff, summary: "正在运行项目检查" });
      const checked = await runChecks(run, worktree, input.checks, controller.signal);
      if (!checked.passed) {
        feedback = `The deterministic checks failed. Fix these failures:\n${checked.results.filter((item) => item.status === "failed").map((item) => `${item.command}\n${item.output}`).join("\n\n")}`;
        await update(run, "developing", "checks", "checks.returned", "检查失败，已退回 Developer 修复", { summary: "检查失败，等待修复" });
        continue;
      }

      const latestDiff = await collectDiff(worktree, controller.signal);
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
      const reviewText = await runPi({
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
      const review = parseReview(reviewText);
      const currentFindings = review.findings.map((item) => ({ ...item, resolved: false }));
      findings = [...findings.map((item) => ({ ...item, resolved: true })), ...currentFindings];
      if (review.verdict === "approved") {
        await update(run, "completed", "reviewer", "review.approved", "独立审核通过，代码保留在任务 worktree", {
          findings,
          diff: latestDiff,
          summary: review.summary,
          durationMs: Date.now() - started,
        });
        return;
      }
      feedback = JSON.stringify(review.findings, null, 2);
      await update(run, "developing", "reviewer", "review.changes_requested", `审核发现 ${review.findings.length} 个问题，退回 Developer`, { findings, summary: review.summary });
    }
    await update(run, "needs_human", "system", "run.needs_human", "达到最大审核轮次，需要人工处理", { findings, durationMs: Date.now() - started });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const safeMessage = [input.credentials.developer, input.credentials.reviewer].reduce(
      (message, secret) => secret ? message.replaceAll(secret, "[redacted]") : message,
      (error as Error).message,
    );
    await update(run, cancelled ? "cancelled" : "failed", "system", cancelled ? "run.cancelled" : "run.failed", cancelled ? "任务已取消" : `真实运行失败：${safeMessage}`, {
      summary: cancelled ? "已取消" : safeMessage,
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
