import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * GAP-02 / AT-PI-005/006/007: Pi Skills, Extensions and prompt templates are
 * default-off. The worker keeps passing `--no-extensions --no-skills
 * --no-prompt-templates` (which also disables discovered and project-local
 * resources) and only re-enables resources named in an explicit, operator
 * supplied allowlist. Anything requested but not allowlisted is reported, never
 * silently dropped.
 *
 * Allowlist / request environment format (comma separated entries):
 *   <kind>:<path>[@role1;role2][#sha256=<hex>[;version=<v>]]
 * where <kind> is extension | skill | prompt-template (a bare path is treated
 * as an extension). Paths are absolute; roles are optional and default to all
 * roles.
 *
 * AT-PI-007 / AT-SEC-014: an entry may pin the plugin's content identity so a
 * changed file is detected. `sha256` is the hex digest of the plugin file, or
 * of the sorted skill bundle (relative path + bytes). The pin is re-verified
 * immediately before every Pi invocation; with `PI_PLUGIN_REQUIRE_PIN=true` a
 * plugin without a sha256 pin is denied instead of loaded.
 */
export type PluginKind = "extension" | "skill" | "prompt-template";

export const pluginKinds: readonly PluginKind[] = ["extension", "skill", "prompt-template"];

export interface PluginPin {
  /** Lowercase hex sha256 of the plugin file or skill bundle. */
  sha256?: string;
  /** Optional human/audit version string; not used for tamper detection. */
  version?: string;
}

export interface PluginAllowEntry {
  kind: PluginKind;
  path: string;
  /** Roles the resource is enabled for; undefined means every role. */
  roles?: string[];
  /** AT-PI-007/AT-SEC-014: pinned content identity, when configured. */
  pin?: PluginPin;
}

export interface PluginDenial {
  path: string;
  kind?: PluginKind;
  reason: string;
}

export interface PluginPolicy {
  entries: PluginAllowEntry[];
  /** Plugin paths the deployment requested but that are not allowlisted. */
  requests: string[];
  denials: PluginDenial[];
}

const flagByKind: Record<PluginKind, string> = {
  extension: "--extension",
  skill: "--skill",
  "prompt-template": "--prompt-template",
};

const shortFlagByKind: Record<PluginKind, string> = {
  extension: "-e",
  skill: "--skill",
  "prompt-template": "--prompt-template",
};

/** CLI flag for an explicit resource, e.g. `--extension /opt/pigo/x.ts`. */
export function pluginFlag(kind: PluginKind): string {
  return flagByKind[kind];
}

/** Short alias, kept for tests and documentation. */
export function pluginShortFlag(kind: PluginKind): string {
  return shortFlagByKind[kind];
}

function parsePin(fragment: string | undefined): { pin?: PluginPin; reason?: string } {
  if (fragment === undefined) return {};
  const pin: PluginPin = {};
  for (const part of fragment.split(/[;&]/).map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) return { reason: `invalid plugin pin fragment "${part.slice(0, 40)}"` };
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === "sha256") {
      if (!/^[a-f0-9]{64}$/i.test(value)) return { reason: `invalid sha256 pin "${value.slice(0, 16)}"` };
      pin.sha256 = value.toLowerCase();
    } else if (key === "version") {
      if (!value) return { reason: "empty plugin version pin" };
      pin.version = value.slice(0, 120);
    } else {
      return { reason: `unknown plugin pin key "${key.slice(0, 40)}"` };
    }
  }
  return Object.keys(pin).length > 0 ? { pin } : { reason: "empty plugin pin" };
}

function parseEntry(raw: string): PluginAllowEntry | PluginDenial {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return { path: raw, reason: "empty allowlist entry" };
  const hashIndex = trimmedRaw.indexOf("#");
  const pinFragment = hashIndex >= 0 ? trimmedRaw.slice(hashIndex + 1) : undefined;
  const trimmed = (hashIndex >= 0 ? trimmedRaw.slice(0, hashIndex) : trimmedRaw).trim();
  const colon = trimmed.indexOf(":");
  let kind: PluginKind = "extension";
  let rest = trimmed;
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    if ((pluginKinds as readonly string[]).includes(prefix)) {
      kind = prefix as PluginKind;
      rest = trimmed.slice(colon + 1);
    } else if (/^[a-zA-Z]+$/.test(prefix) && !path.isAbsolute(trimmed)) {
      return { path: trimmed, reason: `unknown plugin kind "${prefix}"` };
    }
  }
  const at = rest.lastIndexOf("@");
  let pluginPath = rest;
  let roles: string[] | undefined;
  if (at > 0) {
    pluginPath = rest.slice(0, at);
    const parsedRoles = rest.slice(at + 1).split(";").map((role) => role.trim()).filter(Boolean);
    roles = parsedRoles.length > 0 ? parsedRoles : undefined;
  }
  pluginPath = pluginPath.trim();
  if (!pluginPath) return { path: trimmed, kind, reason: "plugin path is empty" };
  if (!path.isAbsolute(pluginPath)) return { path: pluginPath, kind, reason: "plugin path must be absolute" };
  const parsedPin = parsePin(pinFragment);
  if (parsedPin.reason) return { path: pluginPath, kind, reason: parsedPin.reason };
  return { kind, path: pluginPath, ...(roles ? { roles } : {}), ...(parsedPin.pin ? { pin: parsedPin.pin } : {}) };
}

function splitList(raw: string | undefined): string[] {
  return (raw || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function parsePluginPolicy(input: { allowlist?: string; requests?: string } = {}): PluginPolicy {
  const entries: PluginAllowEntry[] = [];
  const denials: PluginDenial[] = [];
  for (const raw of splitList(input.allowlist)) {
    const parsed = parseEntry(raw);
    if ("reason" in parsed) {
      denials.push(parsed);
      continue;
    }
    if (entries.some((entry) => entry.kind === parsed.kind && entry.path === parsed.path)) {
      denials.push({ kind: parsed.kind, path: parsed.path, reason: "duplicate allowlist entry" });
      continue;
    }
    entries.push(parsed);
  }
  const requests = splitList(input.requests);
  return { entries, requests, denials };
}

/**
 * Splits the allowlist for one role and reports requested-but-not-allowed
 * plugins. A request is satisfied only by an allowlist entry with the same
 * path (and kind, when the request specifies one).
 */
export function selectPlugins(policy: PluginPolicy, role: string): { enabled: PluginAllowEntry[]; denials: PluginDenial[] } {
  const denials = [...policy.denials];
  const enabled: PluginAllowEntry[] = [];
  for (const entry of policy.entries) {
    if (entry.roles && !entry.roles.includes(role)) {
      denials.push({ kind: entry.kind, path: entry.path, reason: `not enabled for role "${role}"` });
      continue;
    }
    enabled.push(entry);
  }
  for (const request of policy.requests) {
    const parsed = parseEntry(request);
    if ("reason" in parsed) {
      denials.push({ path: request, reason: `invalid plugin request: ${parsed.reason}` });
      continue;
    }
    const allowed = policy.entries.some((entry) => entry.path === parsed.path && (!entry.roles || entry.roles.includes(role)));
    if (!allowed) denials.push({ kind: parsed.kind, path: parsed.path, reason: "requested plugin is not in the allowlist" });
  }
  return { enabled, denials };
}

/** Sorted relative file paths of a directory (skill bundle) for stable hashing. */
async function listBundleFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listBundleFiles(path.join(root, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * AT-PI-007: content identity of a plugin. A single file hashes to the sha256 of
 * its bytes (matching `sha256sum`); a directory (skill bundle) hashes the sorted
 * relative paths and each file's bytes so renames/additions/edits all change it.
 */
export async function hashPluginPath(target: string): Promise<string> {
  const info = await stat(target);
  const hash = createHash("sha256");
  if (info.isDirectory()) {
    for (const relative of await listBundleFiles(target)) {
      hash.update(`path:${relative}\u0000`);
      hash.update(await readFile(path.join(target, relative)));
      hash.update("\u0000");
    }
  } else {
    hash.update(await readFile(target));
  }
  return hash.digest("hex");
}

export interface VerifyPluginPinsOptions {
  /** Deny any plugin without a sha256 pin (PI_PLUGIN_REQUIRE_PIN=true). */
  requirePin?: boolean;
  /** Injectable hasher for tests; defaults to hashPluginPath. */
  hash?: (absPath: string) => Promise<string>;
}

/**
 * AT-PI-007 / AT-SEC-014: re-verifies every enabled plugin's pinned content
 * hash immediately before a Pi invocation. A mismatch, an unreadable plugin or
 * (when `requirePin`) a missing sha256 pin removes the entry from `enabled` and
 * returns a denial, so tampered code is never passed to Pi. The caller reports
 * the denials as `plugin.denied` audit events.
 */
export async function verifyPluginPins(
  enabled: PluginAllowEntry[],
  options: VerifyPluginPinsOptions = {},
): Promise<{ enabled: PluginAllowEntry[]; denials: PluginDenial[] }> {
  const hash = options.hash ?? hashPluginPath;
  const allowed: PluginAllowEntry[] = [];
  const denials: PluginDenial[] = [];
  for (const entry of enabled) {
    if (!entry.pin?.sha256) {
      if (options.requirePin) {
        denials.push({
          kind: entry.kind,
          path: entry.path,
          reason: "plugin pinning is required (PI_PLUGIN_REQUIRE_PIN=true) but the allowlist entry has no sha256 pin",
        });
        continue;
      }
      allowed.push(entry);
      continue;
    }
    try {
      const actual = await hash(entry.path);
      if (actual !== entry.pin.sha256) {
        denials.push({
          kind: entry.kind,
          path: entry.path,
          reason: `plugin content hash mismatch (tamper detected): expected sha256=${entry.pin.sha256} actual sha256=${actual}`,
        });
        continue;
      }
      allowed.push(entry);
    } catch (error) {
      denials.push({
        kind: entry.kind,
        path: entry.path,
        reason: `plugin content could not be verified: ${(error as Error).message.slice(0, 200)}`,
      });
    }
  }
  return { enabled: allowed, denials };
}

/** Explicit CLI arguments that re-enable only the allowed resources. */
export function pluginArguments(enabled: PluginAllowEntry[], pathFor: (hostPath: string) => string): string[] {
  const args: string[] = [];
  for (const entry of enabled) args.push(pluginFlag(entry.kind), pathFor(entry.path));
  return args;
}

/** Read-only container mounts for allowlisted resources (container mode). */
export function pluginMounts(
  enabled: PluginAllowEntry[],
  containerBase = "/opt/pigo/plugins",
): Array<{ hostPath: string; containerPath: string }> {
  return enabled.map((entry, index) => ({
    hostPath: entry.path,
    containerPath: path.join(containerBase, `${index}-${path.basename(entry.path)}`),
  }));
}

/**
 * Project-local resources Pi would discover by default. They are never loaded
 * because of the `--no-*` flags; the worker reports them so an unapproved
 * `.pi/extensions` in a repository is visible instead of silently ignored.
 */
export const projectPluginPaths = [
  ".pi/extensions",
  ".pi/skills",
  ".pi/prompt-templates",
  ".agents/skills",
] as const;

/** Returns the project-local plugin directories that actually exist. */
export async function detectProjectPlugins(worktree: string): Promise<string[]> {
  const found: string[] = [];
  for (const relative of projectPluginPaths) {
    try {
      await stat(path.join(worktree, relative));
      found.push(relative);
    } catch {
      // Not present: nothing to report.
    }
  }
  return found;
}
