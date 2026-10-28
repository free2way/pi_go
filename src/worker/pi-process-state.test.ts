import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareProcessPiState } from "./pi-process-state.js";
import { PiRetryPolicyError } from "./pi-retry-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-pi-process-")); roots.push(root);
  const operator = path.join(root, "operator"); await mkdir(operator); const modelsFile = path.join(operator, "models.json");
  const oldKey = ["DUMMY", "OLD"].join("_"), otherKey = ["DUMMY", "OTHER", "ROLE"].join("_");
  const models = { providers: { deepseek: { baseUrl: "http://fixture.invalid/v1", api: "openai-completions", apiKey: oldKey, models: [{ id: "fixture" }] }, other: { apiKey: otherKey } } };
  await writeFile(modelsFile, JSON.stringify(models)); await writeFile(path.join(operator, "auth.json"), "DUMMY_AUTH");
  const worktree = path.join(root, "run"); await mkdir(worktree);
  return { root, operator, modelsFile, worktree, input: { worktree, provider: "deepseek", apiKeyEnvironmentName: "DEEPSEEK_API_KEY", modelsFile } };
}

describe("private process-mode Pi state", () => {
  it("copies only selected provider definitions and uses the current role environment credential", async () => {
    const f = await fixture(); const original = await readFile(f.modelsFile, "utf8"); const agent = await prepareProcessPiState(f.input);
    expect(agent.startsWith(`${f.worktree}${path.sep}`)).toBe(false); expect(agent.startsWith(f.operator)).toBe(false);
    const text = await readFile(path.join(agent, "models.json"), "utf8"); const value = JSON.parse(text);
    expect(Object.keys(value.providers)).toEqual(["deepseek"]); expect(value.providers.deepseek.apiKey).toBe("${DEEPSEEK_API_KEY}");
    expect(text).not.toContain("DUMMY_OLD"); expect(text).not.toContain("DUMMY_OTHER_ROLE"); expect(await readFile(f.modelsFile, "utf8")).toBe(original);
    expect(await readFile(path.join(f.operator, "auth.json"), "utf8")).toBe("DUMMY_AUTH"); await expect(stat(path.join(agent, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(agent, "models.json"))).mode & 0o777).toBe(0o600);
  });
  it("keeps a resumed session while reapplying retry policy", async () => {
    const f = await fixture(); const agent = await prepareProcessPiState(f.input); await mkdir(path.join(agent, "sessions")); await writeFile(path.join(agent, "sessions", "session.json"), "DUMMY_SESSION");
    await writeFile(path.join(agent, "settings.json"), '{"theme":"custom","retry":{"enabled":true}}');
    expect(await prepareProcessPiState(f.input)).toBe(agent); expect(await readFile(path.join(agent, "sessions", "session.json"), "utf8")).toBe("DUMMY_SESSION");
    expect(JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"))).toEqual({ theme: "custom", retry: { enabled: false, provider: { maxRetries: 0 } } });
  });
  it("supports built-in providers without a custom models file", async () => {
    const f = await fixture(); const agent = await prepareProcessPiState({ ...f.input, modelsFile: path.join(f.root, "missing.json") });
    expect(JSON.parse(await readFile(path.join(agent, "models.json"), "utf8"))).toEqual({ providers: {} });
  });
  it("does not import another configured provider when the selected one is built-in", async () => {
    const f = await fixture(); const agent = await prepareProcessPiState({ ...f.input, provider: "builtin" });
    expect(JSON.parse(await readFile(path.join(agent, "models.json"), "utf8"))).toEqual({ providers: {} });
  });
  it("refuses using the generated models file as the operator's source", async () => {
    const f = await fixture(); const agent = await prepareProcessPiState(f.input); const source = path.join(agent, "models.json"); const original = await readFile(source, "utf8");
    await expect(prepareProcessPiState({ ...f.input, modelsFile: source })).rejects.toThrow(PiRetryPolicyError);
    expect(await readFile(source, "utf8")).toBe(original);
  });
  it.each(["{ DUMMY_PRIVATE", "[]", '{"providers":3}', '{"providers":{"deepseek":[]}}', "x".repeat(2 * 1024 * 1024 + 1)])("refuses malformed/oversized configured models with a safe error", async (raw) => {
    const f = await fixture(); await writeFile(f.modelsFile, raw); let error: unknown;
    try { await prepareProcessPiState(f.input); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PiRetryPolicyError); expect(String(error)).not.toContain("DUMMY"); expect(String(error)).not.toContain(f.root); expect(await readFile(f.modelsFile, "utf8")).toBe(raw);
  });
  it("refuses state inside a worktree and invalid environment names", async () => {
    const f = await fixture(); await expect(prepareProcessPiState({ ...f.input, statePath: path.join(f.worktree, ".pi") })).rejects.toThrow(PiRetryPolicyError);
    await expect(prepareProcessPiState({ ...f.input, apiKeyEnvironmentName: "BAD=VALUE" })).rejects.toThrow(PiRetryPolicyError);
  });
});
