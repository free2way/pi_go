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

it.each(["snapshot", "control", "terminal", "http"])("actual Worker protects %s diagnostic boundaries", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-diagnostic-boundary-"));
  const token = randomBytes(32).toString("hex"), ownerId = randomBytes(32).toString("hex");
  const developer = ["DUMMY", "opaque-developer"].join("_"), reviewer = ["DUMMY", "opaque-reviewer"].join("_");
  const bearer = ["DUMMY", "boundary-bearer"].join("_"), query = ["DUMMY", "boundary-query"].join("_");
  const reason = `ENOSPC ${token} Bearer ${bearer} https://fixture.invalid/?api_key=${query} ${root}`;
  const updates: Array<{ patch?: Record<string, unknown>; event?: { type: string; message: string; meta?: Record<string, unknown> } }> = [];
  const hits: string[] = [];
  const replies: unknown[] = [];
  let worker: ReturnType<typeof spawn> | undefined;
  let logs = "";
  const callback = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("Content-Type", "application/json");
    const route = request.url ?? "";
    if (route.endsWith("/update")) {
      const body = JSON.parse(text);
      if (mode === "terminal" && body.patch?.state === "needs_human") {
        hits.push("terminal");
        response.writeHead(503).end(JSON.stringify({ error: `${"x".repeat(150)} ${reason} ${developer} ${reviewer}` }));
        return;
      }
      updates.push(body);
    } else if (mode === "control" && /\/checkpoints$|\/claim$|\/finish$|\/jobs\/pending\?/.test(route)) {
      hits.push(route.includes("pending?") ? "pending" : route.split("/").pop()!);
      response.writeHead(503).end(JSON.stringify({ error: route.includes("pending?") ? reason : `${reason} ${developer} ${reviewer}` }));
      return;
    } else if (route.endsWith("/finish")) hits.push("finish");
    response.end(JSON.stringify({ checkpoints: [], jobs: [] }));
  });
  try {
    const project = path.join(root, "projects", "fixture"), bin = path.join(root, "bin");
    const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    const realGit = (await exec("which", ["git"])).stdout.trim();
    await mkdir(project, { recursive: true });
    await mkdir(bin);
    await git(project, ["init"]);
    await git(project, ["config", "user.name", "Test Fixture"]);
    await git(project, ["config", "user.email", "fixture"]);
    await writeFile(path.join(project, "app.js"), "export const value = 1;\n");
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "fixture base"]);
    const baseSha = await git(project, ["rev-parse", "HEAD"]);
    const locales = mode === "terminal" ? ["en"] : ["zh", "en"];
    for (const locale of locales) {
      const runDir = path.join(root, "runs", ownerId, `run_boundary_${locale}`);
      await mkdir(path.dirname(runDir), { recursive: true });
      await exec("git", ["clone", "--no-hardlinks", project, runDir]);
      await git(runDir, ["checkout", "-b", `codex/boundary-${locale}`]);
      await writeFile(path.join(runDir, "app.js"), "export const value = 2;\n");
    }
    const marker = path.join(root, "pi-invoked");
    await writeFile(path.join(bin, "pi"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');process.exit(99);\n`, { mode: 0o700 });
    // Intercept only the boundary under test; everything else uses actual Git
    // with the Worker's normal hardening flags. No remote Git is invoked.
    const wrapper = `#!${process.execPath}
const cp=require('node:child_process'),a=process.argv.slice(2);
if(${mode === "snapshot"}&&a.includes('ls-files')&&a.includes('-s')){
  process.stderr.write(${JSON.stringify(reason + " " + developer + " " + reviewer)});process.exit(1);
}
if(${mode === "http"}&&(a.includes('clone')||a.includes('init'))){
  process.stderr.write((a.includes('clone')?'x'.repeat(450)+' ':'')+${JSON.stringify(reason)});process.exit(1);
}
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);
`;
    await writeFile(path.join(bin, "git"), wrapper, { mode: 0o700 });
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
      cwd: process.cwd(), env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOST: "127.0.0.1", PORT: String(address.port),
        PI_WORKSPACE_ROOT: root, PI_INTERNAL_TOKEN: token, PI_WEB_CALLBACK_URL: `http://127.0.0.1:${callbackAddress.port}`,
        PI_SANDBOX_MODE: "process", PI_PROVIDER_ATTEMPTS: "1", PI_MIN_FREE_DISK_MB: "64",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.on("data", (chunk) => { logs += String(chunk); });
    worker.stderr?.on("data", (chunk) => { logs += String(chunk); });
    await vi.waitFor(async () => {
      expect(worker?.exitCode, logs).toBeNull();
      expect((await fetch(`${workerUrl}/health`)).ok).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    if (mode === "http") {
      for (const [route, payload, code] of [
        ["clone", { url: "https://fixture.invalid/repository.git", name: "rejected-clone" }, "CLONE_FAILED"],
        ["create", { name: "rejected-create" }, "WORKSPACE_INVALID"],
      ] as const) {
        const response = await fetch(`${workerUrl}/workspaces/${route}`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        const reply = await response.json();
        replies.push(reply);
        expect(reply.ok).toBe(false);
        expect(reply.code).toBe(code);
        expect(reply.error).toContain("[redacted");
        expect(reply.error).toContain("ENOSPC");
      }
    }
    for (const locale of mode === "http" ? [] : locales) {
      const response = await fetch(`${workerUrl}/jobs`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: `job_boundary_${locale}`, retryReview: true, checks: [], credentials: { developer, reviewer }, run: {
          id: `run_boundary_${locale}`, ownerId, locale, mode: "real", repository: "fixture", branch: `codex/boundary-${locale}`,
          baseSha, state: "reviewing", round: 1, maxRounds: 3, task: mode === "snapshot" ? "Verify snapshot failure" : "Synthetic input\0invalid",
          createdAt: new Date().toISOString(), developer: { provider: "openai", model: "fixture" }, reviewer: { provider: "openai", model: "fixture" },
          checks: [], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
        } }),
      });
      expect(response.status).toBe(202);
      await vi.waitFor(async () => {
        expect((await (await fetch(`${workerUrl}/health`)).json()).activeJobs, logs).toBe(0);
      }, { timeout: 20_000, interval: 50 });
    }
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
    expect(await git(project, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(await git(project, ["status", "--porcelain"])).toBe("");
    expect((await readdir(path.join(root, "runs", ownerId))).filter((name) => name.includes("reviewer"))).toEqual([]);
    if (mode === "snapshot") {
      const failures = updates.filter((u) => u.event?.type === "review.snapshot_failed");
      expect(failures).toHaveLength(2);
      expect(failures.map((u) => u.patch?.state)).toEqual(["needs_human", "needs_human"]);
      expect(failures.map((u) => u.event?.meta?.locale)).toEqual(["zh", "en"]);
      expect(failures.every((u) => u.event?.message.includes("ENOSPC"))).toBe(true);
      expect(updates.some((u) => ["review.approved", "session.metrics"].includes(u.event?.type ?? ""))).toBe(false);
    } else if (mode === "control") {
      for (const label of ["pending", "claim", "checkpoints", "finish"]) expect(hits).toContain(label);
      for (const label of ["reclaim failed", "claim failed", "checkpoints", "finish failed"]) expect(logs).toContain(label);
      expect(updates.filter((u) => u.event?.type === "pi.input_transport_blocked")).toHaveLength(2);
    } else if (mode === "terminal") {
      expect(hits.filter((h) => h === "terminal")).toHaveLength(4);
      expect(hits).not.toContain("finish");
      expect(logs).toContain("terminal update failed (attempt 3)");
      expect(logs).toContain("leaving the job for reclaim");
      expect(updates.some((u) => u.patch?.state === "needs_human")).toBe(false);
    }
    const visible = JSON.stringify({ updates, logs, replies });
    const canaries = [token, token.slice(0, 24), bearer, query, root, developer, reviewer];
    expect(canaries.map((value) => visible.includes(value))).toEqual(canaries.map(() => false));
  } finally {
    if (worker && worker.exitCode === null) { const exited = once(worker, "exit"); worker.kill("SIGTERM"); await exited; }
    await new Promise<void>((resolve) => callback.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
