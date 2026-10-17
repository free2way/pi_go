import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("published runtime stages use the fixed Alpine base and refresh installed packages", () => {
  const runtime = read("deploy/docker/Dockerfile");
  const web = read("deploy/docker/Dockerfile.web");
  const executor = read("deploy/executor/Dockerfile");

  assert.match(runtime, /^FROM node:22\.23\.3-alpine3\.24$/mu);
  assert.match(web, /^FROM node:22\.23\.3-alpine3\.24 AS runtime$/mu);
  assert.match(executor, /^FROM node:22\.23\.3-alpine3\.24$/mu);
  for (const dockerfile of [runtime, web, executor]) {
    assert.match(dockerfile, /apk upgrade --no-cache/u);
    assert.doesNotMatch(dockerfile, /bookworm/u);
  }
});

test("Pi is current, uses pinned pnpm, and final images do not retain npm", () => {
  const runtime = read("deploy/docker/Dockerfile");
  const web = read("deploy/docker/Dockerfile.web");
  const executor = read("deploy/executor/Dockerfile");

  assert.match(runtime, /^ARG PI_VERSION=1\.3\.0$/mu);
  assert.match(runtime, /^ARG PNPM_VERSION=12\.14\.0$/mu);
  assert.match(runtime, /"pnpm@\$\{PNPM_VERSION\}"/u);
  assert.match(runtime, /\{"npmCommand":\["pnpm"\]\}/u);
  for (const dockerfile of [runtime, web, executor]) {
    assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/u);
  }
});

test("OCI vulnerability scanning remains fail closed for unfixed findings", () => {
  const workflow = read(".github/workflows/oci-supply-chain.yml");
  assert.equal((workflow.match(/severity-cutoff: high/gu) ?? []).length, 5);
  assert.equal((workflow.match(/only-fixed: false/gu) ?? []).length, 5);
  assert.match(workflow, /name: Enforce vulnerability gate/u);
  assert.match(workflow, /steps\.scan_runtime\.outcome != 'success'/u);
});
