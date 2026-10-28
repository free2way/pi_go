import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const exec = promisify(execFile);

it.each([0, 21])("actual Worker stops an exit-zero compaction error with %i reported tokens", async tokens => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-compaction-worker-"));
  const token = randomBytes(32).toString("hex"), ownerId = randomBytes(32).toString("hex");
  const updates: Array<{ patch?: Record<string, unknown>; event?: { type: string; meta?: Record<string, unknown> } }> = [];
  const callback = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/update")) updates.push(JSON.parse(body));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ checkpoints: [], jobs: [] }));
  });
  let worker: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    const project = path.join(root, "projects/fixture"), runDir = path.join(root, "runs", ownerId, "run_compaction_failure"), bin = path.join(root, "bin"), marker = path.join(root, "invoked");
    await mkdir(project, { recursive: true }); await mkdir(path.dirname(runDir), { recursive: true }); await mkdir(bin);
    const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await git(project, ["init"]); await git(project, ["config", "user.name", "Fixture"]); await git(project, ["config", "user.email", "fixture"]);
    await writeFile(path.join(project, "app.js"), "export const value = 1;\n"); await git(project, ["add", "."]); await git(project, ["commit", "-m", "fixture"]);
    const baseSha = await git(project, ["rev-parse", "HEAD"]); await exec("git", ["clone", "--no-hardlinks", project, runDir]); await git(runDir, ["checkout", "-b", "codex/compaction-failure"]); await writeFile(path.join(runDir, "app.js"), "export const value = 2;\n");
    const usage = { input: tokens ? 20 : 0, output: tokens ? 1 : 0, totalTokens: tokens };
    await writeFile(path.join(bin, "pi"), `#!${process.execPath}
(async()=>{const fs=require('node:fs'),handlers={};const i=process.argv.indexOf('--extension');const m=await import(require('node:url').pathToFileURL(process.argv[i+1]).href);m.default({on:(n,f)=>{handlers[n]=f;}});await handlers.before_provider_request({}, {abort:()=>{throw Error('fixture denied');}});fs.appendFileSync(${JSON.stringify(marker)},'x');const review=process.argv[process.argv.indexOf('--model')+1]==='fixture-review';if(review){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({verdict:'approved',summary:'fixture',findings:[]})}]}}));}else{console.log(JSON.stringify({type:'pigo_compaction_start'}));console.log(JSON.stringify({type:'pigo_compaction_request_end',message:{role:'assistant',stopReason:'error',errorMessage:'503 compaction fixture',usage:${JSON.stringify(usage)}}}));}})().catch(()=>process.exit(1));\n`, { mode: 0o700 });
    callback.listen(0, "127.0.0.1"); await once(callback, "listening"); const cb = callback.address(); if (!cb || typeof cb === "string") throw Error("callback address");
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const address = reservation.address(); if (!address || typeof address === "string") throw Error("worker address"); await new Promise<void>(resolve => reservation.close(() => resolve())); const url = `http://127.0.0.1:${address.port}`;
    worker = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], { cwd: process.cwd(), env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: root, HOST: "127.0.0.1", PORT: String(address.port), PI_WORKSPACE_ROOT: root, PI_INTERNAL_TOKEN: token, PI_WEB_CALLBACK_URL: `http://127.0.0.1:${cb.port}`, PI_SANDBOX_MODE: "process", PI_PROVIDER_ATTEMPTS: "1", PI_MIN_FREE_DISK_MB: "64" }, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout?.on("data", b => { logs += String(b); }); worker.stderr?.on("data", b => { logs += String(b); });
    await vi.waitFor(async () => { expect(worker?.exitCode, logs).toBeNull(); expect((await fetch(url + "/health")).ok).toBe(true); }, { timeout: 15000, interval: 50 });
    const response = await fetch(url + "/jobs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ resume: { instruction: "Continue the synthetic fixture" }, checks: [], credentials: { developer: token, reviewer: token }, run: { id: "run_compaction_failure", ownerId, locale: "en", mode: "real", repository: "fixture", branch: "codex/compaction-failure", baseSha, state: "needs_human", round: 2, maxRounds: 2, task: "Verify the intended value change", createdAt: new Date().toISOString(), developer: { provider: "openai-proxy", model: "fixture-dev" }, reviewer: { provider: "openai-proxy", model: "fixture-review" }, checks: [], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, budget: { maxModelCalls: 8, maxTokens: 0, maxCostUsd: 0, maxDurationSeconds: 30 } } }) });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => expect((await (await fetch(url + "/health")).json()).activeJobs, logs).toBe(0), { timeout: 15000, interval: 50 });
    const state = Object.assign({}, ...updates.map(r => r.patch ?? {}));
    expect(state.state).toBe("needs_human"); expect(state.modelCalls).toBe(1); expect(state.usageUnknownCalls).toBe(1); expect((state.usage as { totalTokens: number }).totalTokens).toBe(tokens);
    expect(await readFile(marker, "utf8")).toBe("x");
    expect(updates.filter(r => r.event?.type === "provider.attempt_failed")).toHaveLength(1);
    expect(updates.some(r => ["review.started", "review.approved", "provider.retry"].includes(r.event?.type ?? ""))).toBe(false);
  } finally {
    if (worker && worker.exitCode === null) { const ended = once(worker, "exit"); worker.kill("SIGTERM"); await ended; }
    await new Promise<void>(resolve => callback.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
}, 40000);
