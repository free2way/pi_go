import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { managedPiSettings, PiRetryPolicyError, preparePiRetryPolicy } from "./pi-retry-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-pi-retry-")); roots.push(root);
  const agent = path.join(root, "agent"); await mkdir(agent); return { root, agent, file: path.join(agent, "settings.json") };
}

describe("Worker-owned Pi retry policy", () => {
  it("disables both agent and provider retries while preserving unrelated settings", () => {
    const current = { npmCommand: ["custom"], theme: "dark", retry: { enabled: true, maxRetries: 6, baseDelayMs: 99, provider: { maxRetries: 5, timeoutMs: 321 } } };
    expect(managedPiSettings(current)).toEqual({ ...current, retry: { ...current.retry, enabled: false, provider: { maxRetries: 0, timeoutMs: 321 } } });
    expect(current.retry.enabled).toBe(true); expect(current.retry.provider.maxRetries).toBe(5);
  });
  it.each([null, [], "DUMMY_PRIVATE", { retry: false }, { retry: [] }, { retry: { provider: "DUMMY_PRIVATE" } }])("refuses invalid settings without leaking them: %j", (value) => {
    expect(() => managedPiSettings(value)).toThrow(PiRetryPolicyError);
    try { managedPiSettings(value); } catch (error) { expect(String(error)).not.toContain("DUMMY_PRIVATE"); }
  });
  it("seeds private new settings and leaves model/auth/session content alone", async () => {
    const f = await fixture(); await writeFile(path.join(f.agent, "auth.json"), "DUMMY_AUTH"); await writeFile(path.join(f.agent, "models.json"), "DUMMY_MODELS");
    await preparePiRetryPolicy(f.agent);
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ npmCommand: ["pnpm"], retry: { enabled: false, provider: { maxRetries: 0 } } });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(f.agent, "auth.json"), "utf8")).toBe("DUMMY_AUTH");
    expect(await readFile(path.join(f.agent, "models.json"), "utf8")).toBe("DUMMY_MODELS");
  });
  it("repairs resumed state and preserves custom package-manager/session settings", async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify({ npmCommand: ["custom"], defaultThinkingLevel: "low", retry: { enabled: true, provider: { maxRetries: 3, timeoutMs: 50 } } }));
    await preparePiRetryPolicy(f.agent); const text = await readFile(f.file, "utf8"); const settings = JSON.parse(text);
    expect(settings.npmCommand).toEqual(["custom"]); expect(settings.defaultThinkingLevel).toBe("low"); expect(settings.retry).toEqual({ enabled: false, provider: { maxRetries: 0, timeoutMs: 50 } });
    await preparePiRetryPolicy(f.agent); expect(await readFile(f.file, "utf8")).toBe(text);
  });
  it.each(["{ DUMMY_PRIVATE", "[]", "null", "x".repeat(128 * 1024 + 1)])("fails closed on corrupt or oversized state without replacing it", async (raw) => {
    const f = await fixture(); await writeFile(f.file, raw); await expect(preparePiRetryPolicy(f.agent)).rejects.toThrow(PiRetryPolicyError);
    expect(await readFile(f.file, "utf8")).toBe(raw); expect((await readdir(f.agent)).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
  it("does not follow a settings symlink into another file", async () => {
    const f = await fixture(); const outside = path.join(f.root, "outside.json"); await writeFile(outside, '{"keep":"DUMMY_PRIVATE"}'); await symlink(outside, f.file);
    await expect(preparePiRetryPolicy(f.agent)).rejects.toThrow(PiRetryPolicyError); expect(await readFile(outside, "utf8")).toBe('{"keep":"DUMMY_PRIVATE"}');
  });
  it("does not follow an agent-directory symlink", async () => {
    const f = await fixture(); const alias = path.join(f.root, "alias"); await symlink(f.agent, alias);
    await expect(preparePiRetryPolicy(alias)).rejects.toThrow(PiRetryPolicyError); expect(await readdir(f.agent)).toEqual([]);
  });
  it("supports concurrent initialization without partial JSON or temporary residue", async () => {
    const f = await fixture(); await Promise.all(Array.from({ length: 12 }, () => preparePiRetryPolicy(f.agent)));
    expect(JSON.parse(await readFile(f.file, "utf8")).retry).toEqual({ enabled: false, provider: { maxRetries: 0 } }); expect(await readdir(f.agent)).toEqual(["settings.json"]);
  });
});
