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

it.each(["plain", "url", "json"])("actual Worker redacts %s model echoes and activity before callbacks", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-model-output-"));
  const token = randomBytes(32).toString("hex"), ownerId = randomBytes(32).toString("hex"), modelKey = `DUMMY_${randomBytes(16).toString("hex")}+/"`, reviewerKey = `DUMMY_${randomBytes(16).toString("hex")}+/"`;
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
    const project = path.join(root, "projects/fixture"), runDir = path.join(root, "runs", ownerId, "run_model_output"), bin = path.join(root, "bin"), marker = path.join(root, "invoked");
    await mkdir(project, { recursive: true }); await mkdir(path.dirname(runDir), { recursive: true }); await mkdir(bin);
    const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await git(project, ["init"]); await git(project, ["config", "user.name", "Fixture"]); await git(project, ["config", "user.email", "fixture"]);
    await writeFile(path.join(project, "app.js"), "export const value = 1;\n"); await git(project, ["add", "."]); await git(project, ["commit", "-m", "fixture"]);
    const baseSha = await git(project, ["rev-parse", "HEAD"]); await exec("git", ["clone", "--no-hardlinks", project, runDir]); await git(runDir, ["checkout", "-b", "codex/model-output"]); await writeFile(path.join(runDir, "app.js"), "export const value = 2;\n");
    await writeFile(path.join(bin, "pi"), `#!${process.execPath}
(async()=>{const fs=require('node:fs'),handlers={};const i=process.argv.indexOf('--extension');const m=await import(require('node:url').pathToFileURL(process.argv[i+1]).href);m.default({on:(n,f)=>{handlers[n]=f;}});await handlers.before_provider_request({}, {abort:()=>{throw Error('fixture denied');}});fs.appendFileSync(${JSON.stringify(marker)},'x');const keys=${JSON.stringify([modelKey, reviewerKey])};const current=process.argv[process.argv.indexOf('--model')+1]==='fixture-dev'?0:1;if(process.env.OPENAI_API_KEY!==keys[current]||Object.values(process.env).includes(keys[1-current]))throw Error('fixture credential scope');const mode=${JSON.stringify(mode)};const echo=keys.map(key=>mode==='url'?encodeURIComponent(key):mode==='json'?JSON.stringify(key).slice(1,-1):key).join(' & ');console.log(JSON.stringify({type:'tool_execution_start',toolName:'custom_'+'x'.repeat(1950)+echo}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({verdict:'approved',summary:'Fixture '+echo,findings:[],tokenCount:7})}],usage:{input:10,output:2,totalTokens:12}}}));})().catch(()=>process.exit(1));\n`, { mode: 0o700 });
    callback.listen(0, "127.0.0.1"); await once(callback, "listening"); const cb = callback.address(); if (!cb || typeof cb === "string") throw Error("callback address");
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const address = reservation.address(); if (!address || typeof address === "string") throw Error("worker address"); await new Promise<void>(resolve => reservation.close(() => resolve())); const url = `http://127.0.0.1:${address.port}`;
    worker = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], { cwd: process.cwd(), env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: root, HOST: "127.0.0.1", PORT: String(address.port), PI_WORKSPACE_ROOT: root, PI_INTERNAL_TOKEN: token, PI_WEB_CALLBACK_URL: `http://127.0.0.1:${cb.port}`, PI_SANDBOX_MODE: "process", PI_PROVIDER_ATTEMPTS: "1", PI_MIN_FREE_DISK_MB: "64" }, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout?.on("data", b => { logs += String(b); }); worker.stderr?.on("data", b => { logs += String(b); });
    await vi.waitFor(async () => { expect(worker?.exitCode, logs).toBeNull(); expect((await fetch(url + "/health")).ok).toBe(true); }, { timeout: 15000, interval: 50 });
    const response = await fetch(url + "/jobs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ resume: { instruction: "Continue the synthetic fixture" }, checks: [], credentials: { developer: modelKey, reviewer: reviewerKey }, run: { id: "run_model_output", ownerId, locale: "en", mode: "real", repository: "fixture", branch: "codex/model-output", baseSha, state: "needs_human", round: 2, maxRounds: 2, task: "Verify the intended value change", createdAt: new Date().toISOString(), developer: { provider: "openai-proxy", model: "fixture-dev" }, reviewer: { provider: "openai-proxy", model: "fixture-review" }, checks: [], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, budget: { maxModelCalls: 8, maxTokens: 0, maxCostUsd: 0, maxDurationSeconds: 30 } } }) });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => expect((await (await fetch(url + "/health")).json()).activeJobs, logs).toBe(0), { timeout: 15000, interval: 50 });
    const state = Object.assign({}, ...updates.map(r => r.patch ?? {}));
    expect(state.state).toBe("completed"); expect(state.modelCalls).toBe(2);
    expect(await readFile(marker, "utf8")).toBe("xx");
    const raw = JSON.stringify(updates), forms = [modelKey, reviewerKey].flatMap(key => [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]);
    for (const form of forms) { expect(raw).not.toContain(form); expect(raw).not.toContain(JSON.stringify(form).slice(1, -1)); }
    const events = updates.map(x => x.event).filter(Boolean);
    expect(events.some(x => x?.type === "agent.activity")).toBe(true);
    expect(events.some(x => x?.type === "review.approved")).toBe(true);
    expect(raw).not.toContain(modelKey.slice(0, 16)); expect(raw).not.toContain(reviewerKey.slice(0, 16));
    expect(await readFile(path.join(runDir, "app.js"), "utf8")).toBe("export const value = 2;\n");
    expect(raw).toContain("[redacted]");

  } finally {
    if (worker && worker.exitCode === null) { const ended = once(worker, "exit"); worker.kill("SIGTERM"); await ended; }
    await new Promise<void>(resolve => callback.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
}, 40000);
