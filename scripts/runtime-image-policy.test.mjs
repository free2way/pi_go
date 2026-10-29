import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("published runtime stages use the fixed Alpine base and refresh installed packages", () => {
  const runtime = read("deploy/docker/Dockerfile");
  const web = read("deploy/docker/Dockerfile.web");
  const executor = read("deploy/executor/Dockerfile");

  assert.match(runtime, /^FROM node:22\.23\.4-alpine3\.24$/mu);
  assert.match(web, /^FROM node:22\.23\.4-alpine3\.24 AS runtime$/mu);
  assert.match(executor, /^FROM node:22\.23\.4-alpine3\.24$/mu);
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
  assert.match(runtime, /^ARG PNPM_VERSION=12\.15\.0$/mu);
  assert.match(runtime, /"pnpm@\$\{PNPM_VERSION\}"/u);
  assert.match(runtime, /\{"npmCommand":\["pnpm"\]\}/u);
  for (const dockerfile of [runtime, web, executor]) {
    assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/u);
  }
});

test("runtime replaces affected Pi HTTP code and pins patched schema validation", () => {
  const runtime = read("deploy/docker/Dockerfile");
  assert.match(runtime, /^ARG UNDICI_VERSION=8\.12\.2$/mu);
  assert.match(runtime, /"undici@\$\{UNDICI_VERSION\}"/u);
  assert.match(runtime, /cp -a \/usr\/local\/lib\/node_modules\/undici \/usr\/local\/lib\/node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/undici/u);
  assert.match(runtime, /m\.disableNetConnect\(\)/u);
  assert.match(runtime, /&& pi --version/u);
  assert.match(runtime, /&& pnpm --version/u);
  assert.equal(JSON.parse(read("package.json")).dependencies.zod, "4.6.6");
  assert.equal(JSON.parse(read("package-lock.json")).packages["node_modules/zod"].version, "4.6.6");
});

test("OCI vulnerability scanning remains fail closed for unfixed findings", () => {
  const workflow = read(".github/workflows/oci-supply-chain.yml");
  assert.equal((workflow.match(/severity-cutoff: high/gu) ?? []).length, 10);
  assert.equal((workflow.match(/only-fixed: false/gu) ?? []).length, 10);
  assert.match(workflow, /name: Enforce candidate vulnerability gate/u);
  assert.match(workflow, /steps\.validate_scan_runtime\.outcome != 'success'/u);
  assert.match(workflow, /name: oci-validation-vulnerability-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /name: Enforce vulnerability gate/u);
  assert.match(workflow, /steps\.scan_runtime\.outcome != 'success'/u);
});

test("curl and libcurl use the fixed package version in every git-capable runtime", () => {
  const runtime = read("deploy/docker/Dockerfile");
  const executor = read("deploy/executor/Dockerfile");
  for (const dockerfile of [runtime, executor]) {
    assert.match(dockerfile, /^ARG CURL_VERSION=8\.23\.0-r0$/mu);
    assert.match(dockerfile, /@curlfix https:\/\/dl-cdn\.alpinelinux\.org\/alpine\/edge\/main/u);
    assert.match(dockerfile, /"curl@curlfix=\$\{CURL_VERSION\}"/u);
    assert.match(dockerfile, /"libcurl@curlfix=\$\{CURL_VERSION\}"/u);
  }
});
