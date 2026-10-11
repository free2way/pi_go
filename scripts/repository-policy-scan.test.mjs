import test from "node:test";
import assert from "node:assert/strict";

import { formatFinding, isScannablePath, scanText } from "./repository-policy-scan.mjs";

test("scanText detects private deployment coordinates without returning the value", () => {
  const privateAddress = ["192", "168", "40", "12"].join(".");
  assert.deepEqual(scanText(`HOST=http://${privateAddress}:8080`), [{ line: 1, rule: "private-ipv4" }]);
});

test("scanText allows documentation-reserved addresses and example identities", () => {
  assert.deepEqual(scanText("http://203.0.113.20 admin@example.com worker@localhost agent@pigo.local user@db.example.com"), []);
});

test("scanText detects non-example email domains", () => {
  const identity = ["operator", "company.dev"].join("@");
  assert.deepEqual(scanText(identity), [{ line: 1, rule: "personal-email" }]);
});

test("scanText does not confuse SSH clone coordinates with an email identity", () => {
  assert.deepEqual(scanText("git@github.com:example/repo.git ssh://git@git.example.com/example/repo.git"), []);
});

test("formatFinding always redacts the matched content", () => {
  const finding = { path: "src/config.ts", line: 7, rule: "private-ipv4" };
  assert.equal(formatFinding(finding), "src/config.ts:7 private-ipv4: <redacted>");
});

test("isScannablePath limits the policy to distributable code and config", () => {
  assert.equal(isScannablePath("src/server/index.ts"), true);
  assert.equal(isScannablePath(".github/workflows/pr-gate.yml"), true);
  assert.equal(isScannablePath("deploy/docker/Dockerfile.web"), true);
  assert.equal(isScannablePath("docs/internal.md"), false);
  assert.equal(isScannablePath("tests/e2e/acceptance.spec.ts"), false);
});
