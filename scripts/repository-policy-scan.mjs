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
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const ROOT_FILES = new Set([".env.example", "Dockerfile", "package.json"]);
const ALLOWED_EMAIL_DOMAINS = new Set(["example.com", "example.invalid", "localhost"]);

function isReservedIdentity(localPart, domain) {
  if (ALLOWED_EMAIL_DOMAINS.has(domain)) return true;
  if (domain.endsWith(".example.com") || domain.endsWith(".example.invalid")) return true;
  if (/\.(?:example|invalid|local|test)$/u.test(domain)) return true;
  // `git@host:path` and `ssh://git@host/path` are SCM coordinates, not email
  // identities. The host itself remains subject to the private-address rule.
  return localPart === "git";
}

export function isScannablePath(path) {
  if (ROOT_FILES.has(path)) return true;
  if (!/^(?:\.github|deploy|scripts|src)\//u.test(path)) return false;
  if (/^(?:dist|deploy\/docker\/workspace)\//u.test(path)) return false;
  if (basename(path).startsWith("Dockerfile")) return true;
  return TEXT_EXTENSIONS.has(extname(path));
}

function isPrivateIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

/** @returns {Array<{ line: number, rule: string }>} */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/u);
  const ipv4Pattern = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu;
  const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|localhost)\b/giu;

  lines.forEach((lineText, index) => {
    for (const match of lineText.matchAll(ipv4Pattern)) {
      if (isPrivateIpv4(match[0])) findings.push({ line: index + 1, rule: "private-ipv4" });
    }
    for (const match of lineText.matchAll(emailPattern)) {
      const localPart = String(match[0]).split("@", 1)[0].toLowerCase();
      const domain = String(match[1]).toLowerCase();
      if (!isReservedIdentity(localPart, domain)) findings.push({ line: index + 1, rule: "personal-email" });
    }
  });
  return findings;
}

export function scanRepository(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
  });
  const files = [...new Set(output.split("\n").filter(Boolean))].filter(isScannablePath).sort();
  const findings = [];
  let scanned = 0;
  for (const path of files) {
    const absolutePath = resolve(cwd, path);
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) continue;
    const text = readFileSync(absolutePath, "utf8");
    if (text.includes("\0")) continue;
    scanned += 1;
    for (const finding of scanText(text)) findings.push({ path, ...finding });
  }
  return { files: scanned, findings };
}

export function formatFinding(finding) {
  return `${finding.path}:${finding.line} ${finding.rule}: <redacted>`;
}

function main() {
  const result = scanRepository();
  if (result.findings.length > 0) {
    console.error(`[repository-policy] FAIL: ${result.findings.length} deployment-specific value(s) found`);
    for (const finding of result.findings) console.error(formatFinding(finding));
    process.exitCode = 1;
    return;
  }
  console.log(`[repository-policy] PASS: ${result.files} distributable text file(s) checked`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
