import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const exec = promisify(execFile);

it("actual Worker redacts failed full-diff uploads without losing the durable patch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-artifact-diagnostic-"));
  const token = randomBytes(32).toString("hex");
  const ownerId = randomBytes(32).toString("hex");
  const runDir = path.join(root, "runs", ownerId, "run_artifact_diagnostic");
  const bearer = ["DUMMY", "artifact-bearer"].join("_");
  const query = ["DUMMY", "artifact-query"].join("_");
  const updates: Array<{ patch?: Record<string, unknown>; event?: { type: string; message: string; meta?: Record<string, unknown> } }> = [];
  const uploaded: Array<{ artifactId: string; content: string }> = [];
  const callback = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.url?.endsWith("/artifacts")) {
      uploaded.push(JSON.parse(body));
      const artifactPath = path.join(`${runDir}.state`, "artifacts", `${uploaded[0].artifactId}.patch`);
      response.writeHead(503).end(JSON.stringify({ error: `ENOSPC ${token} Bearer ${bearer} https://fixture.invalid/?api_key=${query} ${artifactPath}` }));
      return;
    }
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
    await mkdir(path.dirname(runDir), { recursive: true });
    await exec("git", ["clone", "--no-hardlinks", project, runDir]);
    await git(runDir, ["checkout", "-b", "codex/artifact-diagnostic"]);
    await writeFile(path.join(runDir, "app.js"), "export const value = 2;\n");
    // Real default 3 MiB callback budget: the lockfile is excluded only from
    // model input, never rewritten in the full durable/uploaded source patch.
    await writeFile(path.join(runDir, "package-lock.json"), JSON.stringify({ fixture: "x".repeat(3_180_000) }) + "\n");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const marker = path.join(root, "pi-invoked");
    const verdict = JSON.stringify({ verdict: "approved", summary: "Synthetic protocol fixture", findings: [] });
    const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: verdict }], stopReason: "stop" } });
    await writeFile(path.join(bin, "pi"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');console.log(${JSON.stringify(event)});\n`, { mode: 0o700 });
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
        PI_SANDBOX_MODE: "process", PI_PROVIDER_ATTEMPTS: "1", PI_MIN_FREE_DISK_MB: "64",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.on("data", (chunk) => { logs += String(chunk); });
    worker.stderr?.on("data", (chunk) => { logs += String(chunk); });
    await vi.waitFor(async () => {
      expect(worker?.exitCode, logs).toBeNull();
      expect((await fetch(`${workerUrl}/health`)).ok).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    const response = await fetch(`${workerUrl}/jobs`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        retryReview: true, checks: [], credentials: { developer: token, reviewer: token },
        run: {
          id: "run_artifact_diagnostic", ownerId, locale: "en", mode: "real", repository: "fixture",
          branch: "codex/artifact-diagnostic", baseSha, state: "reviewing", round: 1, maxRounds: 3,
          task: "Review the synthetic value change", createdAt: new Date().toISOString(),
          developer: { provider: "openai", model: "fixture" }, reviewer: { provider: "openai", model: "fixture" },
          checks: [], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
        },
      }),
    });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await (await fetch(`${workerUrl}/health`)).json()).activeJobs, logs).toBe(0);
    }, { timeout: 20_000, interval: 50 });
    expect(uploaded).toHaveLength(1);
    expect(Buffer.byteLength(uploaded[0].content)).toBeGreaterThan(3 * 1024 * 1024);
    const failures = updates.filter((update) => update.event?.type === "diff.upload_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].event?.message).toContain("ENOSPC");
    expect(failures[0].event?.meta?.artifactId).toBe(uploaded[0].artifactId);
    const artifact = await readFile(path.join(`${runDir}.state`, "artifacts", `${uploaded[0].artifactId}.patch`), "utf8");
    expect(artifact).toBe(uploaded[0].content);
    expect(failures[0].event?.meta?.sha256).toBe(createHash("sha256").update(artifact).digest("hex"));
    expect(updates.some((update) => update.patch?.state === "completed")).toBe(true);
    expect(updates.find((update) => update.patch?.state === "completed")?.patch?.diff).toContain("# [PiGO] inline diff truncated; full artifact");
    expect(await readFile(marker, "utf8")).toBe("x");
    expect(await git(project, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(await git(project, ["status", "--porcelain"])).toBe("");
    expect((await readdir(path.dirname(runDir))).filter((name) => name.includes("review"))).toEqual([]);
    const visible = JSON.stringify({ updates, logs });
    // Boolean assertions avoid dumping a 3 MiB source patch or a credential
    // even when this regression is deliberately run against an affected build.
    expect([token, bearer, query, root].map((value) => visible.includes(value))).toEqual([false, false, false, false]);
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
