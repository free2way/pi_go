import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScmSettingsStore, defaultScmUsername, scmSettingsStatus } from "./scm-settings.js";

const secret = Buffer.alloc(32, 7).toString("base64");

describe("ScmSettingsStore", () => {
  it("encrypts workspace credentials and never exposes the token in status", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-scm-"));
    const file = path.join(directory, "scm.json");
    const store = new ScmSettingsStore(file, secret);
    await store.init();
    const saved = await store.set("ws_1", { provider: "github", authMode: "https_token", token: "test-token-value" });
    expect(saved.username).toBe("x-access-token");
    expect(scmSettingsStatus(saved)).toMatchObject({ provider: "github", tokenConfigured: true });
    expect(JSON.stringify(scmSettingsStatus(saved))).not.toContain("test-token-value");
    expect(await readFile(file, "utf8")).not.toContain("test-token-value");

    const reloaded = new ScmSettingsStore(file, secret);
    await reloaded.init();
    expect(reloaded.get("ws_1")?.token).toBe("test-token-value");
  });

  it("preserves an existing token during metadata updates and supports server SSH", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-scm-"));
    const store = new ScmSettingsStore(path.join(directory, "scm.json"), secret);
    await store.init();
    await store.set("ws_1", { provider: "gitlab", authMode: "https_token", token: "token-one" });
    expect((await store.set("ws_1", { provider: "gitlab", authMode: "https_token", username: "deploy" })).token).toBe("token-one");
    expect((await store.set("ws_1", { provider: "generic", authMode: "server_ssh" })).token).toBeNull();
  });

  it("uses safe provider defaults", () => {
    expect(defaultScmUsername("github")).toBe("x-access-token");
    expect(defaultScmUsername("gitlab")).toBe("oauth2");
    expect(defaultScmUsername("generic")).toBe("git");
  });
});
