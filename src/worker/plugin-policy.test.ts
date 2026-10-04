import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectProjectPlugins,
  hashPluginPath,
  parsePluginPolicy,
  pluginArguments,
  pluginMounts,
  selectPlugins,
  verifyPluginPins,
} from "./plugin-policy.js";

describe("parsePluginPolicy (GAP-02 / AT-PI-005)", () => {
  it("is empty by default: no plugins when unconfigured", () => {
    const policy = parsePluginPolicy();
    expect(policy.entries).toEqual([]);
    expect(policy.denials).toEqual([]);
    expect(selectPlugins(policy, "developer").enabled).toEqual([]);
  });

  it("parses kind-prefixed entries with optional roles", () => {
    const policy = parsePluginPolicy({
      allowlist: "extension:/opt/pigo/review.ts@developer;sub-agent,skill:/opt/pigo/skills/pdf,prompt-template:/opt/pigo/p.md",
    });
    expect(policy.denials).toEqual([]);
    expect(policy.entries).toEqual([
      { kind: "extension", path: "/opt/pigo/review.ts", roles: ["developer", "sub-agent"] },
      { kind: "skill", path: "/opt/pigo/skills/pdf" },
      { kind: "prompt-template", path: "/opt/pigo/p.md" },
    ]);
  });

  it("treats a bare absolute path as an extension", () => {
    const policy = parsePluginPolicy({ allowlist: "/opt/pigo/review.ts" });
    expect(policy.entries).toEqual([{ kind: "extension", path: "/opt/pigo/review.ts" }]);
  });

  it("rejects relative paths and unknown kinds with a clear denial", () => {
    const policy = parsePluginPolicy({ allowlist: "extension:relative/x.ts,bogus:/opt/pigo/x.ts" });
    expect(policy.entries).toEqual([]);
    expect(policy.denials.map((item) => item.reason)).toEqual([
      "plugin path must be absolute",
      'unknown plugin kind "bogus"',
    ]);
  });
});

describe("selectPlugins role gating and requests", () => {
  it("only enables allowlisted resources for the current role", () => {
    const policy = parsePluginPolicy({ allowlist: "extension:/opt/pigo/a.ts@reviewer,skill:/opt/pigo/b" });
    const developer = selectPlugins(policy, "developer");
    expect(developer.enabled.map((entry) => entry.path)).toEqual(["/opt/pigo/b"]);
    expect(developer.denials).toEqual([{ kind: "extension", path: "/opt/pigo/a.ts", reason: 'not enabled for role "developer"' }]);

    const reviewer = selectPlugins(policy, "reviewer");
    expect(reviewer.enabled.map((entry) => entry.path).sort()).toEqual(["/opt/pigo/a.ts", "/opt/pigo/b"]);
  });

  it("reports a requested-but-not-allowed plugin instead of dropping it (AT-PI-005)", () => {
    const policy = parsePluginPolicy({
      allowlist: "extension:/opt/pigo/allowed.ts",
      requests: "extension:/opt/pigo/secret.ts",
    });
    const denials = selectPlugins(policy, "developer").denials;
    expect(denials).toEqual([
      { kind: "extension", path: "/opt/pigo/secret.ts", reason: "requested plugin is not in the allowlist" },
    ]);
  });
});

describe("pluginArguments and pluginMounts", () => {
  it("emits the explicit Pi flags with container path remapping", () => {
    const policy = parsePluginPolicy({ allowlist: "extension:/opt/pigo/a.ts,skill:/opt/pigo/skills/b" });
    const { enabled } = selectPlugins(policy, "developer");
    const mounts = pluginMounts(enabled);
    expect(mounts).toEqual([
      { hostPath: "/opt/pigo/a.ts", containerPath: "/opt/pigo/plugins/0-a.ts" },
      { hostPath: "/opt/pigo/skills/b", containerPath: "/opt/pigo/plugins/1-b" },
    ]);
    const pathFor = new Map(mounts.map((mount) => [mount.hostPath, mount.containerPath]));
    expect(pluginArguments(enabled, (hostPath) => pathFor.get(hostPath) ?? hostPath)).toEqual([
      "--extension", "/opt/pigo/plugins/0-a.ts",
      "--skill", "/opt/pigo/plugins/1-b",
    ]);
  });

  it("passes host paths through in process mode", () => {
    const policy = parsePluginPolicy({ allowlist: "extension:/opt/pigo/a.ts" });
    const { enabled } = selectPlugins(policy, "developer");
    expect(pluginArguments(enabled, (hostPath) => hostPath)).toEqual(["--extension", "/opt/pigo/a.ts"]);
  });
});

describe("plugin content pinning (AT-PI-007 / AT-SEC-014)", () => {
  const sha256File = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

  it("parses a sha256 pin with an optional version without touching the path or roles", () => {
    const digest = "a".repeat(64);
    const policy = parsePluginPolicy({ allowlist: `extension:/opt/pigo/review.ts@developer#sha256=${digest};version=1.2.3` });
    expect(policy.denials).toEqual([]);
    expect(policy.entries).toEqual([
      { kind: "extension", path: "/opt/pigo/review.ts", roles: ["developer"], pin: { sha256: digest, version: "1.2.3" } },
    ]);
  });

  it("rejects a malformed sha256 pin with a clear denial", () => {
    const policy = parsePluginPolicy({ allowlist: "extension:/opt/pigo/a.ts#sha256=nothex" });
    expect(policy.entries).toEqual([]);
    expect(policy.denials[0].reason).toContain("invalid sha256 pin");
  });

  it("loads a plugin whose content matches the pinned hash", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "pigo-pin-")), "plugin.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    const sha = await sha256File(file);
    const entry = { kind: "extension" as const, path: file, pin: { sha256: sha } };
    const verified = await verifyPluginPins([entry]);
    expect(verified.enabled).toEqual([entry]);
    expect(verified.denials).toEqual([]);
  });

  it("denies a plugin whose content does not match the pin", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "pigo-pin-")), "plugin.ts");
    await writeFile(file, "malicious", "utf8");
    const verified = await verifyPluginPins([{ kind: "extension", path: file, pin: { sha256: "b".repeat(64) } }]);
    expect(verified.enabled).toEqual([]);
    expect(verified.denials).toHaveLength(1);
    expect(verified.denials[0].reason).toContain("tamper detected");
  });

  it("denies a plugin tampered with after the pin was established (run-time re-verification)", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "pigo-pin-")), "plugin.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    const entry = { kind: "extension" as const, path: file, pin: { sha256: await sha256File(file) } };
    expect((await verifyPluginPins([entry])).enabled).toHaveLength(1);
    await writeFile(file, "export const x = 2;\n", "utf8");
    const reverified = await verifyPluginPins([entry]);
    expect(reverified.enabled).toEqual([]);
    expect(reverified.denials[0].reason).toContain("hash mismatch");
  });

  it("denies an unpinned plugin when pinning is required", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "pigo-pin-")), "plugin.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    const verified = await verifyPluginPins([{ kind: "extension", path: file }], { requirePin: true });
    expect(verified.enabled).toEqual([]);
    expect(verified.denials[0].reason).toContain("PI_PLUGIN_REQUIRE_PIN");
  });

  it("still loads a plain allowlist path when no pin is configured and pinning is not required", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "pigo-pin-")), "plugin.ts");
    await writeFile(file, "export const x = 1;\n", "utf8");
    const verified = await verifyPluginPins([{ kind: "extension", path: file }]);
    expect(verified.enabled.map((entry) => entry.path)).toEqual([file]);
    expect(verified.denials).toEqual([]);
  });

  it("hashes a whole skill bundle so an added/changed file is detected", async () => {
    const bundle = await mkdtemp(path.join(tmpdir(), "pigo-bundle-"));
    await writeFile(path.join(bundle, "SKILL.md"), "v1", "utf8");
    const first = await hashPluginPath(bundle);
    await writeFile(path.join(bundle, "SKILL.md"), "v2", "utf8");
    const second = await hashPluginPath(bundle);
    expect(second).not.toBe(first);
  });

  it("denies a pinned plugin whose file cannot be read", async () => {
    const verified = await verifyPluginPins([{ kind: "extension", path: "/opt/pigo/missing.ts", pin: { sha256: "c".repeat(64) } }]);
    expect(verified.enabled).toEqual([]);
    expect(verified.denials[0].reason).toContain("could not be verified");
  });
});

describe("detectProjectPlugins (AT-PI-006)", () => {
  it("lists repository plugin directories that exist but are not loaded", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "pigo-plugins-"));
    await mkdir(path.join(worktree, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(worktree, ".agents", "skills"), { recursive: true });
    const found = await detectProjectPlugins(worktree);
    expect(found).toEqual([".pi/extensions", ".agents/skills"]);
  });

  it("returns nothing for a clean repository", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "pigo-plugins-"));
    expect(await detectProjectPlugins(worktree)).toEqual([]);
  });
});
