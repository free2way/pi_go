/**
 * Prevent deployment-specific identity and network coordinates from becoming
 * part of the distributable application. Secret material is handled by the
 * separate secret scanner; this policy covers non-secret environment data that
 * still must be injected at deploy time.
 *
 * Findings deliberately contain only path, line and rule. The matched value is
 * never echoed into CI logs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentPolicy, pathPolicy, inspectExportHistory } from "../src/shared/repository-export-policy.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export function isScannablePath(path) {
  return Boolean(path);
}

/** Uses exactly the same content rules as the push boundary. */
export function scanText(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const rule of contentPolicy(line)) findings.push({ line: index + 1, rule });
  }
  return findings;
}

export function scanRepository(cwd = process.cwd()) {
  const gitPaths = (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const tracked = new Set(gitPaths(["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = new Set(gitPaths(["ls-files", "-z", "--others", "--exclude-standard"]));
  const files = [...new Set([...tracked, ...untracked])].filter(isScannablePath).sort();
  const findings = [];
  let scanned = 0;
  for (const path of files) {
    const forbidden = pathPolicy(path);
    if (forbidden) findings.push({ path, line: 1, rule: forbidden });
    const absolutePath = resolve(cwd, path);
    if (!existsSync(absolutePath)) continue;
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
      findings.push({ path, line: 1, rule: "unscannable" });
      continue;
    }
    const text = readFileSync(absolutePath, "utf8");
    if (text.includes("\0")) { findings.push({ path, line: 1, rule: "unscannable" }); continue; }
    scanned += 1;
    if (untracked.has(path)) {
      for (const finding of scanText(text)) findings.push({ path, ...finding });
      continue;
    }
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--unified=0", "--no-color", "HEAD", "--", path], {
      cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    });
    if (/^(?:Binary files |GIT binary patch)/mu.test(diff)) {
      findings.push({ path, line: 1, rule: "unscannable" });
      continue;
    }
    let lineNumber = 0;
    for (const line of diff.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      if (hunk) { lineNumber = Number(hunk[1]); continue; }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        for (const finding of scanText(line.slice(1))) findings.push({ path, line: lineNumber, rule: finding.rule });
        lineNumber += 1;
      } else if (line.startsWith(" ")) lineNumber += 1;
    }
  }
  return { files: scanned, findings };
}

export function formatFinding(finding) {
  return `${finding.path}:${finding.line} ${finding.rule}: <redacted>`;
}

async function main() {
  const result = scanRepository();
  const git = async (args) => {
    try {
      return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch { return { code: 1, stdout: "", stderr: "Git scan failed" }; }
  };
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  let base = process.env.PIGO_EXPORT_BASE?.trim() || "";
  if (!base) {
    for (const candidate of ["@{upstream}", "origin/main"]) {
      const resolved = await git(["merge-base", "HEAD", candidate]);
      if (resolved.code === 0 && resolved.stdout.trim()) { base = resolved.stdout.trim(); break; }
    }
  }
  const historical = await inspectExportHistory({ git, head, base: base || undefined });
  for (const finding of historical) result.findings.push({ path: finding.path, line: 1, rule: finding.category });
  if (result.findings.length > 0) {
    console.error(`[repository-policy] FAIL: ${result.findings.length} deployment-specific value(s) found`);
    for (const finding of result.findings) console.error(formatFinding(finding));
    process.exitCode = 1;
    return;
  }
  console.log(`[repository-policy] PASS: ${result.files} distributable text file(s) checked`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("[repository-policy] FAIL: complete export history could not be scanned"); process.exitCode = 1; });
}
