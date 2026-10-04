import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { scrubEnvironment } from "./pi-env.js";

/**
 * NEW-01 / AUD-01 / AT-SEC-007,010: platform Git operations must never let
 * untrusted repository content execute inside the Worker. `core.hooksPath=null`
 * and `credential.helper=` are not enough: a hostile repository can ship a
 * `.git/config` plus `.gitattributes` that turns `git add`, `git diff`, merges
 * or fsmonitor into an arbitrary command running with the Worker's privileges
 * and environment.
 *
 * Defense in depth, applied to every platform Git command:
 *  1. static flags disable hooks, credential helpers, fsmonitor and the
 *     `file://` transport;
 *  2. the child runs with a hardened, scrubbed environment: no Worker secrets,
 *     no global/system Git config (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
 *     point at /dev/null, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`);
 *  3. because no environment variable can make Git ignore *repository-local*
 *     config, every execution-relevant key found in the repo/worktree config
 *     (including `include`d files) is overridden on the command line with a
 *     harmless value (`-c filter.<x>.clean=` etc.), which always wins over the
 *     local file.
 */

/** Static flags that do not depend on the repository being operated on. */
export const hardenedGitFlags = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.file.allow=never",
  "-c", "gc.auto=0",
  "-c", "advice.detachedHead=false",
];

/**
 * Maps one repository-local config key to the harmless value that neutralizes
 * it, or `undefined` when the key is not execution-relevant and must be left
 * alone. Deliberately keyed by family (not a single known key): arbitrary
 * filter/diff/merge driver names are covered because the value function is
 * applied to every enumerated key.
 */
export function safeGitConfigValue(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (/^filter\..+\.(clean|smudge|process)$/.test(lower)) return "";
  if (/^filter\..+\.required$/.test(lower)) return "false";
  if (/^diff\..+\.textconv$/.test(lower)) return "cat";
  if (/^diff\..+\.command$/.test(lower)) return "true";
  if (/^merge\..+\.driver$/.test(lower)) return "true";
  if (/^difftool\..+\.cmd$/.test(lower)) return "true";
  if (/^mergetool\..+\.cmd$/.test(lower)) return "true";
  if (/^gpg\.(.*\.)?program$/.test(lower)) return "false";
  if (/^submodule\..+\.update$/.test(lower)) return "none";
  if (lower === "sequence.editor") return "true";
  switch (lower) {
    case "core.hookspath": return "/dev/null";
    case "core.fsmonitor": return "false";
    case "core.pager": return "cat";
    case "core.editor": return "true";
    case "core.sshcommand": return "false";
    case "core.gitproxy": return "false";
    case "core.askpass":
    case "core.askpasscommand": return "false";
    case "core.attributesfile": return "/dev/null";
    default: break;
  }
  if (/^credential(\..+)?\.helper$/.test(lower)) return "";
  if (/^alias\./.test(lower)) return "";
  return undefined;
}

/** Hardened environment shared by every platform Git command. */
export function hardenedGitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const emptyConfig = process.env.PI_GIT_EMPTY_CONFIG || "/dev/null";
  return {
    ...scrubEnvironment(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_PAGER: "cat",
    ...extra,
  };
}

/** Resolves the repository/worktree Git directory for `cwd`, if any. */
export async function resolveGitDir(cwd: string): Promise<string | undefined> {
  const dotGit = path.join(cwd, ".git");
  const info = await stat(dotGit).catch(() => undefined);
  if (info?.isDirectory()) return dotGit;
  if (info?.isFile()) {
    const text = await readFile(dotGit, "utf8").catch(() => "");
    const match = text.match(/^gitdir:\s*(.+)$/m);
    if (match) return path.resolve(cwd, match[1].trim());
  }
  // Subdirectory cwd: ask Git for the absolute git dir. This neither executes
  // repository filters nor needs the config we are trying to sanitize.
  return new Promise((resolve) => {
    const child = spawn("git", [...hardenedGitFlags, "rev-parse", "--absolute-git-dir"], {
      cwd,
      env: hardenedGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() || undefined : undefined));
  });
}

const maxConfigKeys = 20_000;
const configKeyCache = new Map<string, { mtimeMs: number; size: number; keys: string[] }>();

/** Enumerates the keys of one config file, following `include` directives. */
function readConfigKeys(configPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("git", [
      ...hardenedGitFlags,
      "config", "--file", configPath, "--list", "--includes", "--name-only", "-z",
    ], { env: hardenedGitEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-1_000_000); });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      resolve(stdout.split("\0").filter(Boolean).slice(0, maxConfigKeys));
    });
  });
}

async function configKeysCached(configPath: string): Promise<string[]> {
  const info = await stat(configPath).catch(() => undefined);
  if (!info?.isFile()) return [];
  const cached = configKeyCache.get(configPath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.keys;
  const keys = await readConfigKeys(configPath);
  configKeyCache.set(configPath, { mtimeMs: info.mtimeMs, size: info.size, keys });
  return keys;
}

/**
 * Command-line overrides that neutralize every execution-relevant key in the
 * repository's local config (and `config.worktree` for worktree-scoped repos).
 * `-c` values take precedence over the local file, so a hostile `.git/config`
 * can never re-enable a filter/diff/merge driver for the duration of the call.
 */
export async function hardenedGitConfigArgs(cwd: string): Promise<string[]> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return [];
  const sources = [path.join(gitDir, "config"), path.join(gitDir, "config.worktree")];
  const keys = new Set<string>();
  for (const source of sources) {
    for (const key of await configKeysCached(source)) keys.add(key);
  }
  const args: string[] = [];
  for (const key of keys) {
    const value = safeGitConfigValue(key);
    if (value !== undefined) args.push("-c", `${key}=${value}`);
  }
  return args;
}
