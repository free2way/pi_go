import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPiAdmission, PiAdmissionProtocolError } from "./pi-admission.js";
import { emptyUsage, type UsageTotals } from "./pi-events.js";
import { BudgetExceededError, createRunBudget } from "./run-budget.js";
import { baseDemoRun } from "../server/demo-runner.js";

const roots: string[] = [];
const managers: Array<Awaited<ReturnType<typeof createPiAdmission>>> = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.finish()));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
async function fixture(reserveAdditional: (usage: UsageTotals) => void = vi.fn()) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "pigo-admission-")); roots.push(stateDirectory);
  const onFault = vi.fn(); const manager = await createPiAdmission({ stateDirectory, reserveAdditional, onFault }); managers.push(manager);
  await publish(manager, "ready.json", { protocol: 1 });
  return { manager, onFault, reserveAdditional, stateDirectory };
}
async function publish(m: Awaited<ReturnType<typeof createPiAdmission>>, name: string, value: unknown) {
  // Match the real extension's atomic publish; direct truncation can expose an
  // empty valid-message fixture to the strict reader on a busy CI runner.
  const file = path.join(m.directory, name), temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}
async function request(m: Awaited<ReturnType<typeof createPiAdmission>>, sequence: number) {
  await publish(m, "request.json", { protocol: 1, sequence, usage: emptyUsage() });
  return vi.waitFor(async () => JSON.parse(await readFile(path.join(m.directory, `reply-${sequence}.json`), "utf8")), { timeout: 5000, interval: 10 });
}
describe("Worker-owned Pi request admission", () => {
  it("uses the prepaid first call, reserves every next call once, and rejects a repeated denial", async () => {
    const exhausted = new BudgetExceededError("model cap reached"); let n = 0;
    const f = await fixture(vi.fn(() => { if (++n === 2) throw exhausted; }));
    expect((await request(f.manager, 1)).allow).toBe(true);
    expect((await request(f.manager, 2)).allow).toBe(true);
    expect((await request(f.manager, 3)).allow).toBe(false);
    expect(f.manager.admitted).toBe(2); expect(f.manager.error).toBe(exhausted); expect(f.reserveAdditional).toHaveBeenCalledTimes(2);
  });
  it("does not reserve a duplicate request twice", async () => {
    const f = await fixture(); await request(f.manager, 1); await request(f.manager, 2);
    await publish(f.manager, "request.json", { protocol: 1, sequence: 2, usage: emptyUsage() });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.reserveAdditional).toHaveBeenCalledTimes(1); expect(f.manager.admitted).toBe(2);
  });
  it("two concurrent invocations share exactly five Run slots", async () => {
    const run = baseDemoRun({ title: "shared cap", task: "Synthetic shared request admission test", repository: "fixture" }, "fixture"); run.modelCalls = 0;
    const budget = createRunBudget({ run, startedAt: Date.now(), limits: { maxTokens: 0, maxCostUsd: 0, maxModelCalls: 5, maxDurationSeconds: 0 } });
    budget.reserve("sub-agent"); budget.reserve("sub-agent");
    const a = await fixture(() => budget.reserve("sub-agent")), b = await fixture(() => budget.reserve("sub-agent"));
    expect((await Promise.all([request(a.manager, 1), request(b.manager, 1)])).every(x => x.allow)).toBe(true);
    expect((await Promise.all([request(a.manager, 2), request(b.manager, 2)])).every(x => x.allow)).toBe(true);
    const final = await Promise.all([request(a.manager, 3), request(b.manager, 3)]);
    expect(final.filter(x => x.allow)).toHaveLength(1); expect(a.manager.admitted + b.manager.admitted).toBe(5);
    for (const f of [a, b]) await budget.record("sub-agent", { provider: "fixture", model: "fixture" }, emptyUsage(), { calls: f.manager.admitted, unknownCalls: 0 });
    expect(run.modelCalls).toBe(5); expect(() => budget.reserve("developer")).toThrow(BudgetExceededError);
  });
  it.each(["{bad", JSON.stringify({ protocol: 1, sequence: 2, usage: emptyUsage() }), JSON.stringify({ protocol: 1, sequence: 1, usage: { ...emptyUsage(), cost: -1 } }), "x".repeat(4097)])("fails closed on invalid request metadata", async raw => {
    const f = await fixture(); await writeFile(path.join(f.manager.directory, "request.json"), raw);
    await vi.waitFor(() => expect(f.onFault).toHaveBeenCalled()); expect(f.manager.error).toBeInstanceOf(PiAdmissionProtocolError); expect(f.manager.admitted).toBe(0);
  });
  it("refuses symlinked request files", async () => {
    const f = await fixture(); const target = path.join(f.stateDirectory, "outside.json"); await writeFile(target, JSON.stringify({ protocol: 1, sequence: 1, usage: emptyUsage() }));
    await symlink(target, path.join(f.manager.directory, "request.json"));
    await vi.waitFor(() => expect(f.onFault).toHaveBeenCalled()); expect(f.manager.admitted).toBe(0);
  });
  it("rejects a CLI that never registered the mandatory guard", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pigo-admission-missing-")); roots.push(dir);
    const m = await createPiAdmission({ stateDirectory: dir, reserveAdditional: vi.fn(), onFault: vi.fn() });
    expect((await m.finish()).error).toBeInstanceOf(PiAdmissionProtocolError);
  });
  it("generated runtime awaits the actual Worker grant and aborts the denied continuation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pigo-admission-runtime-")); roots.push(dir);
    const m = await createPiAdmission({ stateDirectory: dir, reserveAdditional: () => { throw new BudgetExceededError("cap1"); }, onFault: vi.fn() }); managers.push(m);
    const script = `import register from ${JSON.stringify(pathToFileURL(m.runtime).href)}; const h={}; let aborted=false; register({on:(n,f)=>{h[n]=f;}}); const ctx={abort:()=>{aborted=true;}}; await h.before_provider_request({},ctx); h.message_end({message:{role:'assistant',usage:{input:10,output:2,totalTokens:12,cost:{total:0}}}}); try{await h.before_provider_request({},ctx);}catch{} console.log(JSON.stringify({aborted}));`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); let output = "";
      child.stdout.on("data", b => { output += String(b); }); child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    expect(result.code).toBe(0); expect(JSON.parse(result.output)).toEqual({ aborted: true }); expect(m.admitted).toBe(1); expect(m.error).toBeInstanceOf(BudgetExceededError);
  });
  it("mandatory launcher loads its own guard through a synthetic CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pigo-admission-launch-")); roots.push(dir);
    const m = await createPiAdmission({ stateDirectory: dir, reserveAdditional: vi.fn(), onFault: vi.fn() }); managers.push(m);
    await writeFile(path.join(dir, "pi"), `#!${process.execPath}\n(async()=>{const h={};const i=process.argv.indexOf('--extension');const mod=await import(require('node:url').pathToFileURL(process.argv[i+1]).href);mod.default({on:(n,f)=>{h[n]=f;}});await h.before_provider_request({}, {abort:()=>{}});console.log('fixture complete');})().catch(e=>{console.error(e.message);process.exit(1);});\n`, { mode: 0o700 });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [m.runtime, "--mode", "json"], { env: { PATH: dir, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
      child.stdout.on("data", b => { stdout += String(b); }); child.stderr.on("data", b => { stderr += String(b); }); child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, stdout: "fixture complete\n" }); expect(m.admitted).toBe(1);
  });
});
