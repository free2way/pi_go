import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectExportHistory, pathPolicy } from "../src/shared/repository-export-policy.mjs";

import { formatFinding, isScannablePath, scanRepository, scanText } from "./repository-policy-scan.mjs";

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pigo-policy-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", ["test", "example.invalid"].join("@")]);
  return { cwd, run };
}

test("scanText detects private deployment coordinates without returning the value", () => {
  const privateAddress = ["192", "168", "40", "12"].join(".");
  assert.deepEqual(scanText(`HOST=http://${privateAddress}:8080`), [{ line: 1, rule: "internal_network" }]);
});

test("scanText permits reserved IPs but never exempts account-shaped content", () => {
  assert.deepEqual(scanText("http://203.0.113.20"), []);
  assert.deepEqual(scanText(["admin", "example.com"].join("@")), [{ line: 1, rule: "account_data" }]);
});

test("scanText detects non-example email domains", () => {
  const identity = ["operator", "company.dev"].join("@");
  assert.deepEqual(scanText(identity), [{ line: 1, rule: "account_data" }]);
});

test("SCM coordinates in source receive the same conservative policy as workspace exports", () => {
  assert.deepEqual(scanText(["git", "github.com:example/repo.git"].join("@")), [{ line: 1, rule: "account_data" }]);
});

test("formatFinding always redacts the matched content", () => {
  const finding = { path: "src/config.ts", line: 7, rule: "private-ipv4" };
  assert.equal(formatFinding(finding), "src/config.ts:7 private-ipv4: <redacted>");
});

test("isScannablePath includes internal documents and tests without directory bypasses", () => {
  assert.equal(isScannablePath("src/server/index.ts"), true);
  assert.equal(isScannablePath(".github/workflows/pr-gate.yml"), true);
  assert.equal(isScannablePath("deploy/docker/Dockerfile.web"), true);
  assert.equal(isScannablePath("docs/internal.md"), true);
  assert.equal(isScannablePath("tests/e2e/acceptance.spec.ts"), true);
});

test("CI scanner rejects inline AI instructions without echoing their text", () => {
  const text = ["You", "are", "a reviewer"].join(" ");
  assert.deepEqual(scanText(text), [{ line: 1, rule: "ai_prompt" }]);
});

test("repository scan ignores unchanged baseline lines but rejects newly introduced sensitive content", (t) => {
  const r = repository(t);
  writeFileSync(join(r.cwd, "config.txt"), `${["legacy", "example.invalid"].join("@")}\nsafe=1\n`);
  r.run(["add", "config.txt"]);
  r.run(["commit", "-m", "baseline"]);
  writeFileSync(join(r.cwd, "config.txt"), `${["legacy", "example.invalid"].join("@")}\nsafe=2\n`);
  assert.deepEqual(scanRepository(r.cwd).findings, []);
  writeFileSync(join(r.cwd, "config.txt"), `${["legacy", "example.invalid"].join("@")}\nsafe=2\nACCESS_TOKEN=${"a".repeat(30)}\n`);
  assert.deepEqual(scanRepository(r.cwd).findings, [{ path: "config.txt", line: 3, rule: "secret" }]);
});

const artifactCases = [
  ["backup.sql", "backup_artifact"],
  ["database.dump", "backup_artifact"],
  ["snapshot.bak", "backup_artifact"],
  ["db-backup.sql.gz", "backup_artifact"],
  ["backups/archive.txt", "backup_artifact"],
  ["deploy.log", "deployment_log"],
  ["logs/output.txt", "deployment_log"],
  ["test-results/output.json", "runtime_artifact"],
  [".codex-artifacts/output.txt", "runtime_artifact"],
  ["playwright-report/index.html", "runtime_artifact"],
  ["dist/server/index.js", "runtime_artifact"],
  ["coverage/output.json", "runtime_artifact"],
];

for (const [file, category] of artifactCases) {
  test(`history and actual CI command reject ${file} even after deletion`, async (t) => {
    const r = repository(t);
    writeFileSync(join(r.cwd, "baseline.txt"), "DUMMY baseline\n");
    r.run(["add", "."]); r.run(["commit", "-m", "baseline"]);
    const base = r.run(["rev-parse", "HEAD"]).trim();
    mkdirSync(dirname(join(r.cwd, file)), { recursive: true });
    writeFileSync(join(r.cwd, file), "DUMMY synthetic payload\n");
    r.run(["add", "--", file]); r.run(["commit", "-m", "fixture"]);
    r.run(["rm", "--", file]); r.run(["commit", "-m", "remove fixture"]);
    const head = r.run(["rev-parse", "HEAD"]).trim();
    const findings = await inspectExportHistory({ head, base, git: async (args) => ({ code: 0, stdout: r.run(args), stderr: "" }) });
    assert.deepEqual(findings, [{ category, path: file }]);
    const script = fileURLToPath(new URL("./repository-policy-scan.mjs", import.meta.url));
    let rejected;
    try { execFileSync(process.execPath, [script], { cwd: r.cwd, env: { ...process.env, PIGO_EXPORT_BASE: base }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { rejected = error; }
    assert.equal(rejected?.status, 1);
    assert.match(rejected.stderr, new RegExp(category));
    assert.doesNotMatch(rejected.stderr, /synthetic payload/);
  });
}

test("artifact rules preserve SQL migrations and ordinary source files", () => {
  for (const file of ["db/migrations/001.sql", "src/domain.sql", "src/backup.ts", "src/logger.ts", "src/artifact.ts", "scripts/backup-retention.mjs", "src/server/admin-backups.test.ts"]) {
    assert.equal(pathPolicy(file), undefined, file);
  }
});
