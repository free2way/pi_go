import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectScmProvider, inspectWorkspaceRemote, pushWorkspaceBranch, redactRemoteUrl, scmAuthEnvironment, type ScmGitResult } from "./workspace-scm.js";

afterEach(() => vi.unstubAllEnvs());

const ok = (stdout = ""): ScmGitResult => ({ code: 0, stdout, stderr: "" });
const LOCAL = "a".repeat(40), REMOTE = "b".repeat(40);
const credential = { provider: "github" as const, authMode: "https_token" as const, token: "test-token" };

function fixture(options: { behind?: boolean; forbidden?: boolean; remoteMissing?: boolean } = {}) {
  let pushed = false;
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    const scan = args[0] === "--no-replace-objects";
    const command = scan ? args.slice(1) : args;
    if (command[0] === "rev-parse") return ok(command[1] === "--is-shallow-repository" ? "false\n" : LOCAL + "\n");
    if (command[0] === "remote") return ok("https://github.com/org/repo.git\n");
    if (command[0] === "ls-remote") return ok(options.remoteMissing && !pushed ? "" : `${pushed ? LOCAL : REMOTE} refs/heads/main\n`);
    if (command[0] === "fetch" || command[0] === "merge-base") return ok();
    if (command[0] === "rev-list") {
      if (scan && command[1] === "--parents") return ok(`${LOCAL}${options.remoteMissing ? "" : ` ${REMOTE}`}\n`);
      if (scan) return ok(command[1] === "--count" ? "1\n" : LOCAL + "\n");
      return ok(pushed ? "0 0\n" : options.behind ? "1 2\n" : "1 0\n");
    }
    if (command[0] === "diff-tree") return ok(options.forbidden ? "docs/development.md\0" : "");
    if (command[0] === "ls-tree") return ok(options.forbidden && command[3] === LOCAL ? "100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tdocs/development.md\0" : "");
    if (command[0] === "cat-file") return ok("");
    if (command.includes("push")) { pushed = true; return ok(); }
    throw new Error("Unexpected git command");
  };
  return { git, calls, pushed: () => pushed };
}

describe("workspace SCM", () => {
  it.each([
    ["rev-parse", "SCM_LOCAL_HEAD_FAILED"],
    ["ls-remote", "SCM_REMOTE_UNREACHABLE"],
    ["fetch", "SCM_FETCH_FAILED"],
    ["rev-list", "SCM_COMPARE_FAILED"],
  ])("redacts complete %s diagnostics before truncation without changing the error code", async (command, code) => {
    const saved = "DUMMY_SCM_" + 'opaque" value';
    const platform = "DUMMY_PLATFORM_" + "private-value";
    vi.stubEnv("PI_INTERNAL_TOKEN", platform);
    const markers = ["DUMMY_BEARER", "DUMMY_BASIC", "DUMMY_DATABASE", "DUMMY_QUERY"];
    const uri = ["postgresql:", "//fixture:", markers[2], "@db.example.invalid/test"].join("");
    const detail = `controlled SCM failure: Bearer ${markers[0]} Basic ${markers[1]} ${uri} https://repo.example.invalid/?token=${markers[3]} ${saved} ${encodeURIComponent(saved)} ${JSON.stringify(saved).slice(1, -1)} ${platform}`;
    const f = fixture();
    try {
      await inspectWorkspaceRemote({ branch: "main", credential: { ...credential, token: saved }, git: async args => args[0] === command ? { code: 1, stdout: "", stderr: detail + "x".repeat(900) } : f.git(args) });
      expect.fail("SCM must fail");
    } catch (error) {
      expect(error).toMatchObject({ code });
      const message = (error as Error).message;
      expect(message).toContain("controlled SCM failure");
      expect(message).toContain("[redacted");
      expect(message.length).toBeLessThanOrEqual(800);
      for (const value of [...markers, saved, encodeURIComponent(saved), JSON.stringify(saved).slice(1, -1), platform]) expect(message).not.toContain(value);
    }
  });

  it("redacts remote display values without modifying the actual Git origin or auth scope", async () => {
    const marker = "DUMMY_REMOTE_" + "private-value";
    const remote = `https://repo.example.invalid/repo.git?token=${marker}`;
    expect(redactRemoteUrl(remote)).not.toContain(marker);
    const scpRemote = ["git", "@", "repo.example.invalid:repo.git?token=", marker].join("");
    expect(redactRemoteUrl(scpRemote)).not.toContain(marker);
    expect(redactRemoteUrl(`https://repo.example.invalid/${marker}/repo.git`, [marker])).not.toContain(marker);
    const f = fixture();
    const seen: string[][] = [];
    const result = await inspectWorkspaceRemote({ branch: "main", git: async (args) => {
      seen.push(args);
      return args[0] === "remote" ? ok(remote) : f.git(args);
    } });
    expect(result.remote).toContain("[redacted]");
    expect(result.remote).not.toContain(marker);
    expect(seen.find(args => args[0] === "fetch")).toEqual(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/pigo/remotes/origin/main"]);
    expect(scmAuthEnvironment(remote, credential).GIT_CONFIG_KEY_0).toBe("http.https://repo.example.invalid/repo.git.extraHeader");
  });

  it("detects GitHub, GitLab, and generic Git", () => {
    expect(detectScmProvider("git@github.com:org/repo.git")).toBe("github");
    expect(detectScmProvider("https://gitlab.internal.example/org/repo.git")).toBe("gitlab");
    expect(detectScmProvider("ssh://git@git.example.com/org/repo.git")).toBe("generic");
  });

  it("injects credentials through environment config instead of URL or argv", () => {
    const env = scmAuthEnvironment("https://github.com/org/repo.git", credential);
    expect(env.GIT_CONFIG_KEY_0).toContain("https://github.com/org/repo.git");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:test-token");
  });

  it("reports an ahead branch and verifies a required commit", async () => {
    const { git } = fixture();
    await expect(inspectWorkspaceRemote({ branch: "main", requiredCommit: LOCAL, git })).resolves.toMatchObject({
      relation: "ahead", requiredCommitPresent: true, provider: "github",
    });
  });

  it("refuses non-fast-forward pushes", async () => {
    const { git, pushed } = fixture({ behind: true });
    await expect(pushWorkspaceBranch({ branch: "main", git, credential })).rejects.toMatchObject({ code: "SCM_REMOTE_DIVERGED" });
    expect(pushed()).toBe(false);
  });

  it("requires credentials before scanning or pushing HTTPS", async () => {
    const { git, calls } = fixture();
    await expect(pushWorkspaceBranch({ branch: "main", git })).rejects.toMatchObject({ code: "SCM_CREDENTIAL_REQUIRED" });
    expect(calls.some(args => args[0] === "--no-replace-objects" || args.includes("push"))).toBe(false);
  });

  it("blocks forbidden history and never invokes push", async () => {
    const { git, pushed } = fixture({ forbidden: true });
    await expect(pushWorkspaceBranch({ branch: "main", git, credential })).rejects.toMatchObject({ code: "SCM_EXPORT_POLICY_BLOCKED" });
    expect(pushed()).toBe(false);
  });

  it("pushes only the scanned SHA and disables implicit tag pushes", async () => {
    const { git, calls } = fixture();
    await expect(pushWorkspaceBranch({ branch: "main", git, credential })).resolves.toMatchObject({ pushed: true });
    expect(calls.find(args => args.includes("push"))).toEqual(["-c", "push.followTags=false", "push", "--porcelain", "origin", `${LOCAL}:refs/heads/main`]);
  });

  it("scans the entire history for a new remote branch", async () => {
    const { git, calls } = fixture({ remoteMissing: true });
    await pushWorkspaceBranch({ branch: "main", git, credential });
    expect(calls).toContainEqual(["--no-replace-objects", "rev-list", "--count", LOCAL]);
  });

  it("fails closed on unreadable history without disclosing Git output", async () => {
    const f = fixture();
    const git = async (args: string[]) => args[0] === "--no-replace-objects"
      ? { code: 1, stdout: "", stderr: "sensitive diagnostic" } : f.git(args);
    try {
      await pushWorkspaceBranch({ branch: "main", git, credential });
      expect.fail("push must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "SCM_EXPORT_POLICY_FAILED" });
      expect(String(error)).not.toContain("sensitive diagnostic");
    }
    expect(f.pushed()).toBe(false);
  });
});


describe("known SCM credential in exported source", () => {
  it.each(["plain", "url", "json", "deleted-history", "filename"].flatMap(variant => ["scm", "model"].map(source => ({ variant, source }))))("blocks the supplied opaque credential before push: $source $variant", async ({ variant, source }) => {
    const cwd = mkdtempSync(join(tmpdir(), "pigo-known-export-"));
    const run = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    try {
      run(["init", "-b", "main"]);run(["config", "user.name", "Fixture"]);run(["config", "user.email", ["fixture", "example.invalid"].join("@")]);
      run(["commit", "--allow-empty", "-m", "base"]);
      const base = run(["rev-parse", "HEAD"]).trim();
      run(["update-ref", "refs/pigo/remotes/origin/main", base]);
      const token = "DUMMY_" + 'opaque/+" current-value';
      const encoded = variant === "url" ? encodeURIComponent(token) : variant === "json" ? JSON.stringify(token).slice(1, -1) : token;
      writeFileSync(join(cwd, variant === "filename" ? encodeURIComponent(token) + ".txt" : "source.txt"), variant === "filename" ? "ordinary source" : "ordinary opaque value " + encoded);
      run(["add", "."]);run(["commit", "-m", "source"]);
      if (variant === "deleted-history") { run(["rm", "source.txt"]);run(["commit", "-m", "delete source"]); }
      let pushes = 0;
      const git = async (args: string[]) => {
        if (args[0] === "remote") return ok("https://repo.example.invalid/repository.git");
        if (args[0] === "ls-remote") return ok(`${pushes ? run(["rev-parse", "HEAD"]).trim() : base} refs/heads/main`);
        if (args[0] === "fetch") return ok();
        if (args.includes("push")) { pushes++;run(["update-ref", "refs/pigo/remotes/origin/main", "HEAD"]);return ok(); }
        try { return ok(run(args)); } catch { return { code: 1, stdout: "", stderr: "fixture read failed" }; }
      };
      try {
        await pushWorkspaceBranch({ branch: "main", git, credential: { provider: "generic", authMode: "https_token", token: source === "scm" ? token : "DUMMY_scm_auth" }, exportCredentials: source === "model" ? [token] : [] });
        expect.fail("Known credential must not be pushed");
      } catch (error) {
        expect(error).toMatchObject({ code: "SCM_EXPORT_POLICY_BLOCKED" });
        for (const value of [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)]) expect(String(error)).not.toContain(value);
      }
      expect(pushes).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
