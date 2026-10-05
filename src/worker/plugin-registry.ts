import { readFileSync } from "node:fs";
import {
  parsePluginPolicy,
  type PluginAllowEntry,
  type PluginKind,
  type PluginPolicy,
} from "./plugin-policy.js";

/**
 * Sprint 2: a SHA-256 pinned plugin registry that can be wired into the standard
 * Compose deployment via `PI_PLUGIN_REGISTRY`.
 *
 * The flat `PI_PLUGIN_ALLOWLIST` string is fine for a couple of entries but does
 * not scale to a reviewed, versioned set of extensions/skills/prompts. The
 * registry file makes the pinned identity the primary artifact:
 *
 * ```json
 * {
 *   "version": 1,
 *   "plugins": [
 *     { "name": "review-ext", "kind": "extension", "path": "/opt/pigo/review.ts",
 *       "sha256": "<64 hex>", "version": "1.2.0", "roles": ["developer"] }
 *   ]
 * }
 * ```
 *
 * Entries are converted into the existing `PluginAllowEntry` shape (with a
 * `PluginPin`) and merged with the flat allowlist, so all downstream behaviour
 * (role gating, tamper re-verification via `verifyPluginPins`, container mounts)
 * is unchanged. Registry entries win over the flat allowlist on a path conflict;
 * duplicate paths are deduped (last registry entry wins).
 */

/** Registry file kind; `prompt` maps to the internal `prompt-template` kind. */
export type PluginRegistryKind = "extension" | "skill" | "prompt";

export interface PluginRegistryEntry {
  name: string;
  kind: PluginRegistryKind;
  path: string;
  /** Lowercase/upper hex sha256 of the plugin file or skill bundle (required). */
  sha256: string;
  version?: string;
  roles?: string[];
}

export interface PluginRegistry {
  version: 1;
  plugins: PluginRegistryEntry[];
}

/** Thrown for a missing, unreadable or malformed registry file. */
export class PluginRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

const registryKinds: readonly PluginRegistryKind[] = ["extension", "skill", "prompt"];

const internalKindByRegistryKind: Record<PluginRegistryKind, PluginKind> = {
  extension: "extension",
  skill: "skill",
  // The registry uses the public name; plugin-policy uses the Pi CLI name.
  prompt: "prompt-template",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginRegistryError(`plugin registry: plugins[${index}].${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseEntry(raw: unknown, index: number): PluginRegistryEntry {
  if (!isRecord(raw)) throw new PluginRegistryError(`plugin registry: plugins[${index}] must be an object`);
  const name = requireString(raw.name, "name", index);
  const kind = requireString(raw.kind, "kind", index);
  if (!(registryKinds as readonly string[]).includes(kind)) {
    throw new PluginRegistryError(
      `plugin registry: plugins[${index}].kind must be one of ${registryKinds.join("|")} (got "${kind.slice(0, 40)}")`,
    );
  }
  const pluginPath = requireString(raw.path, "path", index);
  if (!pluginPath.startsWith("/")) {
    throw new PluginRegistryError(`plugin registry: plugins[${index}].path must be an absolute path (got "${pluginPath.slice(0, 80)}")`);
  }
  const sha256 = requireString(raw.sha256, "sha256", index);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new PluginRegistryError(`plugin registry: plugins[${index}].sha256 must be a 64-character hex digest (got "${sha256.slice(0, 16)}")`);
  }
  const entry: PluginRegistryEntry = {
    name,
    kind: kind as PluginRegistryKind,
    path: pluginPath,
    sha256: sha256.toLowerCase(),
  };
  if (raw.version !== undefined) {
    entry.version = requireString(raw.version, "version", index).slice(0, 120);
  }
  if (raw.roles !== undefined) {
    if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
      throw new PluginRegistryError(`plugin registry: plugins[${index}].roles must be a non-empty array of strings`);
    }
    entry.roles = raw.roles.map((role, roleIndex) => {
      if (typeof role !== "string" || !role.trim()) {
        throw new PluginRegistryError(`plugin registry: plugins[${index}].roles[${roleIndex}] must be a non-empty string`);
      }
      return role.trim();
    });
  }
  return entry;
}

/** Parses and validates a registry document. Throws `PluginRegistryError`. */
export function parsePluginRegistry(text: string): PluginRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PluginRegistryError(`plugin registry is not valid JSON: ${(error as Error).message.slice(0, 200)}`);
  }
  if (!isRecord(raw)) throw new PluginRegistryError("plugin registry root must be a JSON object");
  if (raw.version !== 1) {
    throw new PluginRegistryError(`plugin registry version must be 1 (got ${JSON.stringify(raw.version)?.slice(0, 40) ?? "undefined"})`);
  }
  if (!Array.isArray(raw.plugins)) throw new PluginRegistryError("plugin registry must contain a plugins array");
  const plugins = raw.plugins.map((entry, index) => parseEntry(entry, index));
  return { version: 1, plugins };
}

/**
 * Loads the registry from disk. A missing or unreadable file is a hard error:
 * silently disabling a deployment's pinned plugins would be a security
 * regression, so the worker refuses to start instead.
 */
export function loadPluginRegistry(file: string): PluginRegistry {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new PluginRegistryError(`PI_PLUGIN_REGISTRY file could not be read (${code}): ${file}`);
  }
  try {
    return parsePluginRegistry(text);
  } catch (error) {
    if (error instanceof PluginRegistryError) throw new PluginRegistryError(`${error.message} (${file})`);
    throw error;
  }
}

/** Converts registry entries into the existing allowlist shape, keeping pins. */
export function registryAllowEntries(registry: PluginRegistry): PluginAllowEntry[] {
  return registry.plugins.map((entry) => ({
    kind: internalKindByRegistryKind[entry.kind],
    path: entry.path,
    ...(entry.roles ? { roles: entry.roles } : {}),
    pin: { sha256: entry.sha256, ...(entry.version ? { version: entry.version } : {}) },
  }));
}

/**
 * Merges registry entries into a flat allowlist policy. Duplicate paths are
 * deduped (the registry entry replaces the flat one), so a path is never passed
 * to Pi twice. Requests and denials from the flat policy are preserved verbatim.
 */
export function mergePluginPolicy(policy: PluginPolicy, registryEntries: PluginAllowEntry[]): PluginPolicy {
  const entries = [...policy.entries];
  for (const entry of registryEntries) {
    const index = entries.findIndex((current) => current.path === entry.path);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
  }
  return { entries, requests: policy.requests, denials: policy.denials };
}

export interface BuildPluginPolicyInput {
  allowlist?: string;
  requests?: string;
  /** Path to a registry JSON file; unset/empty keeps the flat-allowlist behaviour. */
  registry?: string;
}

/**
 * Builds the worker's effective plugin policy. Throws `PluginRegistryError` when
 * `registry` is set but the file is missing/invalid, so a misconfigured
 * deployment fails loudly instead of running with plugins silently disabled.
 */
export function buildPluginPolicy(input: BuildPluginPolicyInput): PluginPolicy {
  const policy = parsePluginPolicy({ allowlist: input.allowlist, requests: input.requests });
  const registryPath = input.registry?.trim();
  if (!registryPath) return policy;
  const registry = loadPluginRegistry(registryPath);
  return mergePluginPolicy(policy, registryAllowEntries(registry));
}
