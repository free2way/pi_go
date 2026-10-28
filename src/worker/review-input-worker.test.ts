import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const exec = promisify(execFile);

it.each(["diff-budget", "transport"])("actual Worker enforces %s before spending a provider attempt", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-review-budget-"));
  const token = randomBytes(32).toString("hex");
  const ownerId = randomBytes(32).toString("hex");
  const updates: Array<{ deliveryId?: string; patch?: Record<string, unknown>; event?: { type: string; message: string; meta?: Record<string, unknown> } }> = [];
  const cases = mode === "diff-budget" ? ["zh", "en"] : ["dense_zh", "dense_en", "nul_zh", "nul_en", "oversize_developer"];
  const callback = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.url?.endsWith("/update")) updates.push(JSON.parse(body));
    response.end(JSON.stringify({ checkpoints: [], jobs: [] }));
  });
  let worker: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    const project = path.join(root, "projects", "fixture");
    await mkdir(project, { recursive: true });
    const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await git(project, ["init"]);
    await git(project, ["config", "user.name", "Test Fixture"]);
    await git(project, ["config", "user.email", "fixture"]);
    await writeFile(path.join(project, "app.js"), "export const value = 1;\n");
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "fixture base"]);
    const baseSha = await git(project, ["rev-parse", "HEAD"]);
    const runs = path.join(root, "runs", ownerId);
    await mkdir(runs, { recursive: true });
    for (const name of cases) {
      if (name === "oversize_developer") continue;
      const runDir = path.join(runs, `run_budget_${name}`);
      await exec("git", ["clone", "--no-hardlinks", project, runDir]);
      await git(runDir, ["checkout", "-b", `codex/budget-${name}`]);
      await writeFile(path.join(runDir, "app.js"), "export const value = 2;\n");
      if (name.startsWith("dense")) {
        for (let i = 0; i < 5; i++) await writeFile(path.join(runDir, `dense${i}.ts`), `export const item${i}="${"x".repeat(33_000)}";\n`);
      }
    }

    // Only a synthetic CLI is on PATH: even a regression cannot call a real model.
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const marker = path.join(root, "pi-invoked");
    const verdict = JSON.stringify({ verdict: "approved", summary: "Synthetic protocol fixture", findings: [] });
    const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: verdict }], stopReason: "stop" } });
    await writeFile(path.join(bin, "pi"), `#!${process.execPath}
(async()=>{
  const handlers={}, i=process.argv.indexOf('--extension');
  if(i>=0){const module=await import(require('node:url').pathToFileURL(process.argv[i+1]).href);module.default({on:(name,handler)=>{handlers[name]=handler;}});await handlers.before_provider_request({}, {abort:()=>{throw Error('fixture refused');}});}
  require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');
  const event=${event};handlers.message_end?.(event);console.log(JSON.stringify(event));
})().catch(()=>process.exit(1));\n`, { mode: 0o700 });
    callback.listen(0, "127.0.0.1");
    await once(callback, "listening");
    const callbackAddress = callback.address();
    if (!callbackAddress || typeof callbackAddress === "string") throw new Error("No callback port");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No worker port");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const workerUrl = `http://127.0.0.1:${address.port}`;
    worker = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], {
      cwd: process.cwd(),
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOST: "127.0.0.1", PORT: String(address.port),
        PI_WORKSPACE_ROOT: root, PI_INTERNAL_TOKEN: token,
        PI_WEB_CALLBACK_URL: `http://127.0.0.1:${callbackAddress.port}`,
        PI_SANDBOX_MODE: "process", ...(mode === "diff-budget" ? { PI_REVIEW_TOTAL_DIFF_BYTES: "10" } : {}),
        PI_PROVIDER_ATTEMPTS: "1", PI_MIN_FREE_DISK_MB: "64",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.on("data", (chunk) => { logs += String(chunk); });
    worker.stderr?.on("data", (chunk) => { logs += String(chunk); });
    await vi.waitFor(async () => {
      expect(worker?.exitCode, logs).toBeNull();
      expect((await fetch(`${workerUrl}/health`)).ok).toBe(true);
    }, { timeout: 15_000, interval: 50 });

    for (const name of cases) {
      const locale = name.endsWith("en") ? "en" : "zh";
      const fresh = name === "oversize_developer";
      const response = await fetch(`${workerUrl}/jobs`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          retryReview: !fresh, checks: [], credentials: { developer: token, reviewer: token },
          run: {
            id: `run_budget_${name}`, ownerId, locale, mode: "real", repository: "fixture",
            branch: `codex/budget-${name}`, baseSha, state: "needs_human", round: 1, maxRounds: 3,
            task: fresh ? "需".repeat(50_000) : name.startsWith("dense") ? "需".repeat(10_000) : name.startsWith("nul") ? "Synthetic input\0invalid" : "Verify synthetic value change", createdAt: new Date().toISOString(),
            developer: { provider: "openai", model: "fixture" }, reviewer: { provider: "openai", model: "fixture" },
            checks: [], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
          },
        }),
      });
      expect(response.status).toBe(202);
      await vi.waitFor(async () => {
        const health = await (await fetch(`${workerUrl}/health`)).json();
        expect(health.activeJobs, logs).toBe(0);
      }, { timeout: 15_000, interval: 50 });
    }
    if (mode === "diff-budget") {
      const stops = updates.filter((update) => update.event?.type === "review.input_budget_exceeded");
      expect(stops).toHaveLength(2);
      expect(stops.map((stop) => stop.patch?.state)).toEqual(["needs_human", "needs_human"]);
      expect(stops.map((stop) => stop.event?.meta?.locale)).toEqual(["zh", "en"]);
      expect(stops[0].event?.message).toContain("已停止模型调用");
      expect(stops[1].event?.message).toContain("model invocation stopped");
      expect(updates.some((update) => ["review.input_prepared", "review.approved", "session.metrics", "review.retry"].includes(update.event?.type ?? ""))).toBe(false);
      expect(await readFile(marker).then(() => true, () => false)).toBe(false);
    } else {
      for (const name of cases) {
        const rows = updates.filter((update) => update.deliveryId?.startsWith(`run_budget_${name}:`));
        if (name.startsWith("dense")) {
          const prepared = rows.find((row) => row.event?.type === "review.input_prepared");
          expect(prepared?.event?.meta?.originalDiffBytes).toBeGreaterThan(160_000);
          expect(prepared?.event?.meta?.promptBytes).toBeLessThanOrEqual(120_000);
          expect(prepared?.event?.meta?.excludedFiles).toBeGreaterThan(0);
          expect(rows.some((row) => row.event?.type === "review.approved" && row.patch?.state === "completed"), JSON.stringify(rows.filter(x => x.event?.type.startsWith("provider.") || x.patch?.state === "needs_human").map(x => ({ type: x.event?.type, message: x.event?.message })))).toBe(true);
          expect(rows.find((row) => row.event?.type === "session.metrics")?.event?.meta?.modelCalls).toBe(1);
        } else {
          const blocked = rows.find((row) => row.event?.type === "pi.input_transport_blocked");
          expect(blocked?.patch?.state).toBe("needs_human");
          expect(blocked?.event?.meta?.reason).toBe(name.startsWith("nul") ? "nul" : "byte-budget");
          expect(blocked?.event?.meta?.locale).toBe(name.endsWith("en") ? "en" : "zh");
          expect(rows.some((row) => ["session.metrics", "review.input_prepared", "review.approved"].includes(row.event?.type ?? ""))).toBe(false);
          if (name === "oversize_developer") expect(blocked?.patch?.modelCalls ?? 0).toBe(0);
        }
      }
      // Assistant envelopes JSON-escape NUL rather than passing it to execve.
      // Escaping long history can still exceed the complete argument budget.
      for (const locale of ["zh", "en", "en"]) {
          const route = "/assistant/ask";
          const response = await fetch(`${workerUrl}${route}`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Synthetic question", history: Array.from({ length: 8 }, () => ({ role: "user", content: "\0".repeat(4_000) })), locale, provider: "openai", model: "fixture", apiKey: token }),
          });
          expect(response.status).toBe(422);
          const body = await response.json();
          expect(body.code).toBe("PI_INPUT_TRANSPORT_BLOCKED");
          expect(body.error).toContain(locale === "en" ? "model invocation stopped" : "已停止模型调用");
          expect(body.error).not.toContain(token);
      }
      expect(await readFile(marker, "utf8")).toBe("xx");
      expect(updates.some((update) => update.event?.type.startsWith("provider.") || update.event?.type === "review.retry")).toBe(false);
    }
    expect(await readdir(runs)).toEqual(expect.arrayContaining(cases.map((name) => `run_budget_${name}`)));
    expect((await readdir(runs)).filter((name) => name.includes("review"))).toEqual([]);
    expect(await git(project, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(await git(project, ["status", "--porcelain"])).toBe("");
  } finally {
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
    }
    await new Promise<void>((resolve) => callback.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
