import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("executor and release gateway sources remain readable by the non-root runtime user", () => {
  const dockerfile = readFileSync(new URL("../deploy/executor/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY --chown=node:node --chmod=0644 server\.mjs \.\/server\.mjs$/mu);
  assert.match(dockerfile, /^COPY --chown=node:node --chmod=0644 release-gateway\.mjs \.\/release-gateway\.mjs$/mu);
  assert.match(dockerfile, /^USER node$/mu);
});

test("OCI validation requires only the Docker client used by the release gateway", () => {
  const workflow = readFileSync(new URL("../.github/workflows/oci-supply-chain.yml", import.meta.url), "utf8");
  assert.match(workflow, /docker run --rm --entrypoint docker local\/pigo-executor:ci --version/u);
  assert.doesNotMatch(workflow, /local\/pigo-executor:ci compose version/u);
});
