import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeReleaseCallbackOrigin, ReleaseSettingsStore, releaseSettingsStatus } from "./release-settings.js";

const secret = Buffer.alloc(32, 23).toString("base64");

describe("normalizeReleaseCallbackOrigin", () => {
  it("accepts private HTTP origins but rejects paths and credentials", () => {
    expect(normalizeReleaseCallbackOrigin("http://pigo-staging-web:3100/")).toBe("http://pigo-staging-web:3100");
    expect(normalizeReleaseCallbackOrigin("https://pigo.example.com")).toBe("https://pigo.example.com");
    expect(() => normalizeReleaseCallbackOrigin("ftp://pigo-staging-web")).toThrow(/HTTP or HTTPS/);
    const credentialed = `http://${["user", "pass"].join(":")}@pigo-staging-web`;
    expect(() => normalizeReleaseCallbackOrigin(credentialed)).toThrow(/only scheme and host/);
    expect(() => normalizeReleaseCallbackOrigin("http://pigo-staging-web/api/internal")).toThrow(/only scheme and host/);
  });
});

describe("ReleaseSettingsStore", () => {
  it("encrypts the complete webhook configuration and reloads it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-release-settings-"));
    const file = path.join(directory, "release.json");
    const store = new ReleaseSettingsStore(file, secret);
    await store.init();
    await store.set({ webhookUrl: "https://deploy.example.com/pigo", webhookToken: "release-secret-token", publicOrigin: "https://pigo.example.com/" });

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("release-secret-token");
    expect(raw).not.toContain("deploy.example.com");

    const reloaded = new ReleaseSettingsStore(file, secret);
    await reloaded.init();
    expect(reloaded.get()).toMatchObject({
      webhookUrl: "https://deploy.example.com/pigo",
      webhookToken: "release-secret-token",
      publicOrigin: "https://pigo.example.com",
    });
  });

  it("preserves the existing token when an edit leaves it blank", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pigo-release-settings-"));
    const store = new ReleaseSettingsStore(path.join(directory, "release.json"), secret);
    await store.init();
    await store.set({ webhookUrl: "https://one.example.com/hook", webhookToken: "secret-one-value", publicOrigin: "https://pigo.example.com" });
    await store.set({ webhookUrl: "https://two.example.com/hook", publicOrigin: "https://pigo.example.com" });
    expect(store.get()?.webhookToken).toBe("secret-one-value");
  });

  it("prefers web settings, falls back to env, and exposes presence only", () => {
    const status = releaseSettingsStatus({
      saved: { webhookUrl: "https://web.example.com", webhookToken: "web-secret", publicOrigin: "https://pigo.example.com", updatedAt: "2026-10-08T00:00:00.000Z" },
      environment: { webhookUrl: "https://env.example.com", webhookToken: "env-secret", publicOrigin: "https://env-pigo.example.com" },
    });
    expect(status).toEqual({ source: "web", configured: true, webhookUrl: "https://web.example.com", tokenConfigured: true, publicOrigin: "https://pigo.example.com", updatedAt: "2026-10-08T00:00:00.000Z" });
    expect(JSON.stringify(status)).not.toContain("web-secret");
  });
});
