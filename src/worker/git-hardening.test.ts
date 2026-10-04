import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenedGitConfigArgs, hardenedGitEnvironment, safeGitConfigValue } from "./git-hardening.js";
import { defaultGitExec } from "./review-snapshot.js";
import { gitAvailable } from "./git-test-helpers.js";

const temporaryDirs: string[] = [];

async function initRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "pigo-git-hardening-test-"));
  temporaryDirs.push(dir);
  await defaultGitExec(dir, ["init", "-q", "-b", "main"]);
  await defaultGitExec(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("safeGitConfigValue (NEW-01)", () => {
  it("neutralizes every execution-relevant family, not one known key", () => {
    expect(safeGitConfigValue("filter.anything.clean")).toBe("");
    expect(safeGitConfigValue("filter.anything.process")).toBe("");
    expect(safeGitConfigValue("filter.anything.required")).toBe("false");
    expect(safeGitConfigValue("diff.driver.textconv")).toBe("cat");
    expect(safeGitConfigValue("diff.driver.command")).toBe("true");
    expect(safeGitConfigValue("merge.driver.driver")).toBe("true");
    expect(safeGitConfigValue("credential.helper")).toBe("");
    expect(safeGitConfigValue("credential.https://host.helper")).toBe("");
    expect(safeGitConfigValue("core.fsmonitor")).toBe("false");
    expect(safeGitConfigValue("core.hooksPath")).toBe("/dev/null");
    expect(safeGitConfigValue("alias.deploy")).toBe("");
    expect(safeGitConfigValue("gpg.program")).toBe("false");
  });

  it("leaves harmless preferences alone", () => {
    expect(safeGitConfigValue("core.repositoryformatversion")).toBeUndefined();
    expect(safeGitConfigValue("diff.algorithm")).toBeUndefined();
    expect(safeGitConfigValue("user.name")).toBeUndefined();
  });
});

describe("hardenedGitEnvironment (NEW-01)", () => {
  it("removes Worker secrets and points global/system config at an empty file", () => {
    const previousToken = process.env.PI_INTERNAL_TOKEN;
    const previousMarker = process.env.DUMMY_WORKER_SECRET_NOT_A_REAL_KEY;
    process.env.PI_INTERNAL_TOKEN = "internal-token";
    process.env.DUMMY_WORKER_SECRET_NOT_A_REAL_KEY = "leaked";
    try {
      const env = hardenedGitEnvironment();
      expect(env.PI_INTERNAL_TOKEN).toBeUndefined();
      expect(env.DUMMY_WORKER_SECRET_NOT_A_REAL_KEY).toBeUndefined();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(env.GIT_ATTR_NOSYSTEM).toBe("1");
    } finally {
      if (previousToken === undefined) delete process.env.PI_INTERNAL_TOKEN;
      else process.env.PI_INTERNAL_TOKEN = previousToken;
      if (previousMarker === undefined) delete process.env.DUMMY_WORKER_SECRET_NOT_A_REAL_KEY;
      else process.env.DUMMY_WORKER_SECRET_NOT_A_REAL_KEY = previousMarker;
    }
  });
});

describe.skipIf(!gitAvailable)("hardenedGitConfigArgs (NEW-01)", () => {
  it("enumerates repository-local config including included files", async () => {
    const repo = await initRepo();
    const includePath = path.join(repo, "inc.cfg");
    await writeFile(includePath, `[filter "fromInclude"]\n\tclean = sh -c "echo nope"\n`);
    await appendFile(path.join(repo, ".git", "config"), `[include]\n\tpath = ${includePath}\n`);

    const args = await hardenedGitConfigArgs(repo);

    expect(args).toContain("filter.fromInclude.clean=");
  });

  it("does not execute a repository-local textconv or merge driver during git diff", async () => {
    const repo = await initRepo();
    const marker = path.join(repo, "driver-executed.txt");
    await appendFile(
      path.join(repo, ".git", "config"),
      `[diff "evil"]\n\ttextconv = sh -c "touch '${marker}'; cat"\n[merge "evil"]\n\tdriver = sh -c "touch '${marker}'"\n`,
    );
    await writeFile(path.join(repo, ".gitattributes"), "*.txt diff=evil merge=evil\n");
    await writeFile(path.join(repo, "a.txt"), "one\n");
    await defaultGitExec(repo, ["add", "-A"]);
    await writeFile(path.join(repo, "a.txt"), "two\n");

    await defaultGitExec(repo, ["diff", "--no-ext-diff", "--no-textconv", "--", "."]);

    expect(await stat(marker).then(() => true).catch(() => false)).toBe(false);
  });
});
