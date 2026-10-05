import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginPolicy, verifyPluginPins } from "./plugin-policy.js";
import {
  PluginRegistryError,
  buildPluginPolicy,
  loadPluginRegistry,
  mergePluginPolicy,
  parsePluginRegistry,
  registryAllowEntries,
} from "./plugin-registry.js";

const digest = (char: string) => char.repeat(64);

const validRegistry = JSON.stringify({
  version: 1,
  plugins: [
    { name: "ext", kind: "extension", path: "/opt/pigo/review.ts", sha256: digest("a"), version: "1.2.0", roles: ["developer", "sub-agent"] },
    { name: "skill", kind: "skill", path: "/opt/pigo/skills/pdf", sha256: digest("b") },
    { name: "prompt", kind: "prompt", path: "/opt/pigo/prompts/review.md", sha256: digest("c") },
  ],
});

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-registry-"));
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return file;
}

describe("parsePluginRegistry", () => {
  it("parses a valid v1 registry", () => {
    const registry = parsePluginRegistry(validRegistry);
    expect(registry.version).toBe(1);
    expect(registry.plugins.map((entry) => entry.name)).toEqual(["ext", "skill", "prompt"]);
    expect(registry.plugins[0]).toMatchObject({ kind: "extension", version: "1.2.0", roles: ["developer", "sub-agent"] });
  });

  it("rejects a non-JSON document with a clear error", () => {
    expect(() => parsePluginRegistry("{ not json")).toThrow(PluginRegistryError);
    expect(() => parsePluginRegistry("{ not json")).toThrow(/not valid JSON/);
  });

  it("rejects an unsupported version", () => {
    expect(() => parsePluginRegistry(JSON.stringify({ version: 2, plugins: [] }))).toThrow(/version must be 1/);
  });

  it("rejects an unknown kind", () => {
    const raw = JSON.stringify({ version: 1, plugins: [{ name: "x", kind: "binary", path: "/opt/x", sha256: digest("a") }] });
    expect(() => parsePluginRegistry(raw)).toThrow(/kind must be one of/);
  });

  it("rejects a relative path", () => {
    const raw = JSON.stringify({ version: 1, plugins: [{ name: "x", kind: "extension", path: "plugins/x.ts", sha256: digest("a") }] });
    expect(() => parsePluginRegistry(raw)).toThrow(/absolute path/);
  });

  it("requires a 64-hex sha256 pin", () => {
    const raw = JSON.stringify({ version: 1, plugins: [{ name: "x", kind: "extension", path: "/opt/x.ts", sha256: "nothex" }] });
    expect(() => parsePluginRegistry(raw)).toThrow(/64-character hex/);
  });

  it("normalises sha256 to lowercase", () => {
    const raw = JSON.stringify({ version: 1, plugins: [{ name: "x", kind: "extension", path: "/opt/x.ts", sha256: "A".repeat(64) }] });
    expect(parsePluginRegistry(raw).plugins[0].sha256).toBe("a".repeat(64));
  });
});

describe("loadPluginRegistry", () => {
  it("fails loudly when the file is missing", () => {
    expect(() => loadPluginRegistry("/opt/pigo/definitely-missing.json")).toThrow(PluginRegistryError);
    expect(() => loadPluginRegistry("/opt/pigo/definitely-missing.json")).toThrow(/could not be read/);
  });

  it("fails loudly when the file is invalid", async () => {
    const file = await tempFile("plugins.json", JSON.stringify({ version: 1 }));
    expect(() => loadPluginRegistry(file)).toThrow(/must contain a plugins array/);
  });

  it("loads a valid file", async () => {
    const file = await tempFile("plugins.json", validRegistry);
    expect(loadPluginRegistry(file).plugins).toHaveLength(3);
  });
});

describe("registryAllowEntries", () => {
  it("maps the public prompt kind to prompt-template and keeps the pin", () => {
    const entries = registryAllowEntries(parsePluginRegistry(validRegistry));
    expect(entries).toEqual([
      { kind: "extension", path: "/opt/pigo/review.ts", roles: ["developer", "sub-agent"], pin: { sha256: digest("a"), version: "1.2.0" } },
      { kind: "skill", path: "/opt/pigo/skills/pdf", pin: { sha256: digest("b") } },
      { kind: "prompt-template", path: "/opt/pigo/prompts/review.md", pin: { sha256: digest("c") } },
    ]);
  });
});

describe("mergePluginPolicy", () => {
  it("lets a registry entry win over a flat allowlist entry for the same path", () => {
    const flat = parsePluginPolicy({ allowlist: "extension:/opt/pigo/review.ts@developer" });
    const registry = registryAllowEntries(parsePluginRegistry(validRegistry)).filter((entry) => entry.path === "/opt/pigo/review.ts");
    const merged = mergePluginPolicy(flat, registry);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].pin?.sha256).toBe(digest("a"));
    expect(merged.entries[0].roles).toEqual(["developer", "sub-agent"]);
  });

  it("dedupes duplicate registry paths (last entry wins)", () => {
    const flat = parsePluginPolicy({});
    const merged = mergePluginPolicy(flat, [
      { kind: "extension", path: "/opt/pigo/x.ts", pin: { sha256: digest("a") } },
      { kind: "skill", path: "/opt/pigo/x.ts", pin: { sha256: digest("b") } },
    ]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].kind).toBe("skill");
    expect(merged.entries[0].pin?.sha256).toBe(digest("b"));
  });

  it("preserves requests and denials from the flat policy", () => {
    const flat = parsePluginPolicy({ allowlist: "extension:/opt/pigo/a.ts,relative/x.ts", requests: "extension:/opt/pigo/missing.ts" });
    const merged = mergePluginPolicy(flat, registryAllowEntries(parsePluginRegistry(validRegistry)));
    expect(merged.requests).toEqual(["extension:/opt/pigo/missing.ts"]); // requests keep their raw form
    expect(merged.denials.map((denial) => denial.reason)).toEqual(["plugin path must be absolute"]);
    expect(merged.entries.map((entry) => entry.path)).toEqual([
      "/opt/pigo/a.ts",
      "/opt/pigo/review.ts",
      "/opt/pigo/skills/pdf",
      "/opt/pigo/prompts/review.md",
    ]);
  });
});

describe("buildPluginPolicy", () => {
  it("keeps today's behaviour when PI_PLUGIN_REGISTRY is unset", () => {
    const policy = buildPluginPolicy({ allowlist: "extension:/opt/pigo/a.ts" });
    expect(policy.entries).toEqual([{ kind: "extension", path: "/opt/pigo/a.ts" }]);
  });

  it("merges a registry file into the effective policy", async () => {
    const file = await tempFile("plugins.json", validRegistry);
    const policy = buildPluginPolicy({ allowlist: "extension:/opt/pigo/allowed.ts", registry: file });
    expect(policy.entries.map((entry) => entry.path)).toEqual([
      "/opt/pigo/allowed.ts",
      "/opt/pigo/review.ts",
      "/opt/pigo/skills/pdf",
      "/opt/pigo/prompts/review.md",
    ]);
    expect(policy.entries.find((entry) => entry.path === "/opt/pigo/review.ts")?.pin?.sha256).toBe(digest("a"));
  });

  it("fails loudly instead of silently disabling plugins when the registry is missing", () => {
    expect(() => buildPluginPolicy({ registry: "/opt/pigo/nope.json" })).toThrow(/could not be read/);
  });
});

describe("registry entries integrate with verifyPluginPins", () => {
  it("loads a plugin whose real content matches the registry digest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pigo-registry-pin-"));
    const plugin = path.join(dir, "review.ts");
    await writeFile(plugin, "export const x = 1;\n", "utf8");
    const sha = createHash("sha256").update(await readFile(plugin)).digest("hex");
    const file = await tempFile("plugins.json", JSON.stringify({
      version: 1,
      plugins: [{ name: "review", kind: "extension", path: plugin, sha256: sha }],
    }));
    const policy = buildPluginPolicy({ registry: file });
    const verified = await verifyPluginPins(policy.entries);
    expect(verified.denials).toEqual([]);
    expect(verified.enabled.map((entry) => entry.path)).toEqual([plugin]);

    // Tampering with the file after the registry was established is denied.
    await writeFile(plugin, "export const x = 2;\n", "utf8");
    const denied = await verifyPluginPins(policy.entries);
    expect(denied.enabled).toEqual([]);
    expect(denied.denials[0].reason).toContain("tamper detected");
  });
});
