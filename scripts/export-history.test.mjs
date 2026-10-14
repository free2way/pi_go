import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectExportHistory, pathPolicy, contentPolicy } from "../src/shared/repository-export-policy.mjs";

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pigo-export-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", ["test", "example.invalid"].join("@")]);
  const commit = () => { run(["add", "."]); run(["commit", "--allow-empty", "-m", "fixture"]); return run(["rev-parse", "HEAD"]).trim(); };
  const base = commit();
  const git = async (args) => {
    try { return { code: 0, stdout: run(args), stderr: "" }; }
    catch { return { code: 1, stdout: "", stderr: "fixture command failed" }; }
  };
  return { cwd, run, commit, base, git };
}

test("deleted sensitive data in intermediate commits cannot escape export scanning", async (t) => {
  const r = repository(t);
  writeFileSync(join(r.cwd, "config.txt"), "ghp_" + "a".repeat(36));
  r.commit();
  rmSync(join(r.cwd, "config.txt"));
  const head = r.commit();
  assert.equal(r.run(["diff", "--name-only", `${r.base}..${head}`]), "");
  const findings = await inspectExportHistory({ git: r.git, head, base: r.base });
  assert.deepEqual(findings, [{ category: "secret", path: "config.txt" }]);
  assert.ok(!JSON.stringify(findings).includes("a".repeat(36)));
  assert.deepEqual(await inspectExportHistory({ git: r.git, head }), findings, "empty remote must scan the same historical secret");
});

test("merged side-branch instructions remain blocked after deletion", async (t) => {
  const r = repository(t);
  r.run(["switch", "-c", "feature"]);
  writeFileSync(join(r.cwd, "instructions.txt"), ["You", "are", "a reviewer"].join(" "));
  r.commit();
  r.run(["switch", "main"]);
  r.run(["merge", "--no-ff", "feature", "-m", "fixture merge"]);
  rmSync(join(r.cwd, "instructions.txt"));
  const head = r.commit();
  assert.deepEqual(await inspectExportHistory({ git: r.git, head, base: r.base }), [{ category: "ai_prompt", path: "instructions.txt" }]);
});

test("unchanged baseline files are excluded while copied blobs are rescanned under new paths", async (t) => {
  const r = repository(t);
  writeFileSync(join(r.cwd, "legacy.md"), "approved baseline material");
  const baseline = r.commit();
  writeFileSync(join(r.cwd, "source.txt"), "ordinary source");
  const safeHead = r.commit();
  assert.deepEqual(await inspectExportHistory({ git: r.git, head: safeHead, base: baseline }), []);
  mkdirSync(join(r.cwd, "docs"));
  writeFileSync(join(r.cwd, "docs", "copied.txt"), "ordinary source");
  const copiedHead = r.commit();
  assert.deepEqual(await inspectExportHistory({ git: r.git, head: copiedHead, base: safeHead }), [
    { category: "documentation", path: "docs/copied.txt" },
  ]);
});

test("shared policy covers internal documents, keys, and inline instructions", () => {
  assert.equal(pathPolicy("docs/architecture.md"), "documentation");
  assert.equal(pathPolicy(".env"), "credential_file");
  assert.equal(pathPolicy("agent/prompts.txt"), "ai_prompt");
  assert.ok(contentPolicy(["Act", "as", "a developer"].join(" ")).includes("ai_prompt"));
  assert.ok(contentPolicy(`"${["user", "name"].join("")}": "operator"`).includes("account_data"));
  assert.ok(contentPolicy("ACCESS_TOKEN=" + "a".repeat(30)).includes("secret"));
});

test("shallow history and truncated enumeration fail closed", async () => {
  const head = "a".repeat(40);
  await assert.rejects(() => inspectExportHistory({ head, git: async () => ({ code: 0, stdout: "true\n", stderr: "" }) }), /Complete repository history/);
  await assert.rejects(() => inspectExportHistory({ head, git: async (args) => ({ code: 0,
    stdout: args.includes("--is-shallow-repository") ? "false\n" : args.includes("--count") ? "2\n" : `${head}\n`, stderr: "" }) }), /Incomplete export commit list/);
});

test("truncated blobs and binary content cannot pass as scanned text", async (t) => {
  const r = repository(t);
  writeFileSync(join(r.cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  const head = r.commit();
  assert.deepEqual(await inspectExportHistory({ git: r.git, head, base: r.base }), [{ category: "unscannable", path: "binary.dat" }]);
  const git = async (args) => args.includes("cat-file") ? { code: 0, stdout: "", stderr: "" } : r.git(args);
  await assert.rejects(() => inspectExportHistory({ git, head, base: r.base }), /Incomplete or non-UTF8/);
});
