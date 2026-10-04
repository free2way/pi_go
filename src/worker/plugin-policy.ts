import { stat } from "node:fs/promises";
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
 *   <kind>:<path>[@role1;role2]
 * where <kind> is extension | skill | prompt-template (a bare path is treated
 * as an extension). Paths are absolute; roles are optional and default to all
 * roles.
 */
export type PluginKind = "extension" | "skill" | "prompt-template";

export const pluginKinds: readonly PluginKind[] = ["extension", "skill", "prompt-template"];

export interface PluginAllowEntry {
  kind: PluginKind;
  path: string;
  /** Roles the resource is enabled for; undefined means every role. */
  roles?: string[];
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

function parseEntry(raw: string): PluginAllowEntry | PluginDenial {
  const trimmed = raw.trim();
  if (!trimmed) return { path: raw, reason: "empty allowlist entry" };
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
  return { kind, path: pluginPath, ...(roles ? { roles } : {}) };
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
