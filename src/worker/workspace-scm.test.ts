import { describe, expect, it } from "vitest";
import { detectScmProvider, inspectWorkspacePushPolicy, inspectWorkspaceRemote, pushWorkspaceBranch, scmAuthEnvironment, type ScmGitResult } from "./workspace-scm.js";

const ok = (stdout = ""): ScmGitResult => ({ code: 0, stdout, stderr: "" });

describe("workspace SCM", () => {
  it("detects GitHub, GitLab including self-hosted names, and generic Git", () => {
    expect(detectScmProvider("git@github.com:org/repo.git")).toBe("github");
    expect(detectScmProvider("https://gitlab.com/org/repo.git")).toBe("gitlab");
    expect(detectScmProvider("https://gitlab.internal.example/org/repo.git")).toBe("gitlab");
    expect(detectScmProvider("ssh://git@git.example.com/org/repo.git")).toBe("generic");
  });

  it("passes HTTPS credentials through environment config instead of URL or argv", () => {
    const env = scmAuthEnvironment("https://github.com/org/repo.git", { provider: "github", authMode: "https_token", token: "secret" });
    expect(env.GIT_CONFIG_KEY_0).toContain("https://github.com/org/repo.git");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("secret");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:secret");
  });

  it("reports an ahead branch and verifies a required commit", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("local\n");
      if (args[0] === "remote") return ok("https://github.com/org/repo.git\n");
      if (args[0] === "ls-remote") return ok("remote refs/heads/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("1\t0\n");
      if (args[0] === "merge-base") return ok();
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    await expect(inspectWorkspaceRemote({ branch: "main", requiredCommit: "merged", git, now: () => "now" })).resolves.toMatchObject({
      relation: "ahead", ahead: 1, behind: 0, requiredCommitPresent: true, provider: "github", checkedAt: "now",
    });
    expect(calls.some((args) => args[0] === "fetch")).toBe(true);
  });

  it("refuses non-fast-forward pushes", async () => {
    const git = async (args: string[]) => {
      if (args[0] === "rev-parse") return ok("local\n");
      if (args[0] === "remote") return ok("https://git.example/repo.git\n");
      if (args[0] === "ls-remote") return ok("remote refs/heads/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("1 2\n");
      return ok();
    };
    await expect(pushWorkspaceBranch({ branch: "main", git })).rejects.toMatchObject({ code: "SCM_REMOTE_DIVERGED" });
  });

  it("rejects an HTTPS push without a saved token before scanning or invoking push", async () => {
    let scanned = false;
    let pushed = false;
    const git = async (args: string[]) => {
      if (args[0] === "rev-parse") return ok("local\n");
      if (args[0] === "remote") return ok("https://github.com/org/repo.git\n");
      if (args[0] === "ls-remote") return ok("remote refs/heads/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("1 0\n");
      if (args[0] === "diff" || args[0] === "grep") scanned = true;
      if (args[0] === "push") pushed = true;
      return ok();
    };
    await expect(pushWorkspaceBranch({ branch: "main", git })).rejects.toMatchObject({
      code: "SCM_CREDENTIAL_REQUIRED",
    });
    expect(scanned).toBe(false);
    expect(pushed).toBe(false);
  });

  it("blocks development and acceptance documentation before push", async () => {
    const git = async (args: string[]) => {
      if (args[0] === "diff") return ok("docs/acceptance.md\0src/app.ts\0");
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      return ok();
    };
    await expect(inspectWorkspacePushPolicy({
      before: {
        provider: "github", remote: "https://github.com/org/repo.git", branch: "main", localHead: "local",
        remoteHead: "remote", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now",
      },
      git,
    })).resolves.toEqual([{ category: "documentation", path: "docs/acceptance.md" }]);
  });

  it("blocks internal network information without returning matched content", async () => {
    const git = async (args: string[]) => {
      if (args[0] === "diff") return ok("src/config.ts\0");
      if (args[0] === "grep" && args.some((value) => value.includes("192\\.168"))) return ok("HEAD:src/config.ts\0");
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      return ok();
    };
    const result = await inspectWorkspacePushPolicy({
      before: {
        provider: "generic", remote: "ssh://git@example/repo.git", branch: "main", localHead: "local",
        remoteHead: "remote", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now",
      },
      git,
    });
    expect(result).toEqual([{ category: "internal_network", path: "src/config.ts" }]);
    expect(JSON.stringify(result)).not.toContain("203.0.113.42");
  });

  it("blocks AI prompt material by path or content", async () => {
    const git = async (args: string[]) => {
      if (args[0] === "diff") return ok("src/prompts/reviewer.ts\0src/agent.ts\0");
      if (args[0] === "grep" && args.some((value) => value.includes("system" + " prompt"))) return ok("HEAD:src/agent.ts\0");
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      return ok();
    };
    await expect(inspectWorkspacePushPolicy({
      before: {
        provider: "gitlab", remote: "https://gitlab.example/repo.git", branch: "main", localHead: "local",
        remoteHead: "remote", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now",
      },
      git,
    })).resolves.toEqual([
      { category: "ai_prompt", path: "src/prompts/reviewer.ts" },
      { category: "ai_prompt", path: "src/agent.ts" },
    ]);
  });

  it("blocks operational account data without exposing its value", async () => {
    const git = async (args: string[]) => {
      if (args[0] === "diff") return ok("deploy/release.sh\0");
      if (args[0] === "grep" && args.some((value) => value.includes("ssh|deploy"))) return ok("HEAD:deploy/release.sh\0");
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      return ok();
    };
    const result = await inspectWorkspacePushPolicy({
      before: {
        provider: "generic", remote: "ssh://git@example/repo.git", branch: "main", localHead: "local",
        remoteHead: "remote", relation: "ahead", ahead: 1, behind: 0, checkedAt: "now",
      },
      git,
    });
    expect(result).toEqual([{ category: "account_data", path: "deploy/release.sh" }]);
    expect(JSON.stringify(result)).not.toContain("production-user");
  });

  it("refuses the push when export policy findings exist", async () => {
    let pushed = false;
    const git = async (args: string[]) => {
      if (args[0] === "rev-parse") return ok("local\n");
      if (args[0] === "remote") return ok("https://github.com/org/repo.git\n");
      if (args[0] === "ls-remote") return ok("remote refs/heads/main\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok("1 0\n");
      if (args[0] === "diff") return ok("docs/development.md\0");
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "push") pushed = true;
      return ok();
    };
    await expect(pushWorkspaceBranch({
      branch: "main",
      git,
      credential: { provider: "github", authMode: "https_token", token: "test-token" },
    })).rejects.toMatchObject({ code: "SCM_EXPORT_POLICY_BLOCKED" });
    expect(pushed).toBe(false);
  });

  it("pushes an ahead branch and verifies synchronization", async () => {
    let pushed = false;
    const git = async (args: string[]) => {
      if (args[0] === "rev-parse") return ok(pushed && args[1] !== "HEAD" ? "local\n" : "local\n");
      if (args[0] === "remote") return ok("https://github.com/org/repo.git\n");
      if (args[0] === "ls-remote") return ok(`${pushed ? "local" : "remote"} refs/heads/main\n`);
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-list") return ok(pushed ? "0 0\n" : "1 0\n");
      if (args[0] === "diff") return ok();
      if (args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "push") { pushed = true; return ok("ok\n"); }
      return ok();
    };
    await expect(pushWorkspaceBranch({
      branch: "main",
      git,
      credential: { provider: "github", authMode: "https_token", token: "test-token" },
    })).resolves.toMatchObject({ pushed: true, after: { relation: "synchronized" } });
  });
});
