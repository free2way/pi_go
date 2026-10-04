import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectProjectPlugins,
  parsePluginPolicy,
  pluginArguments,
  pluginMounts,
  selectPlugins,
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
