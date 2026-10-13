#!/usr/bin/env node
/**
 * AUD-12 / AT-OPS-001: offline structure check for deploy/docker/compose.yaml.
 * Verifies the worker service mounts exactly what the sandbox needs, keeps the
 * Docker socket group in group_add, and never mixes the two (the bug reported as
 * AUD-12). Run with `npm run validate:compose`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkComposeCoverage } from "../../scripts/compose-config-coverage.mjs";

const file = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "compose.yaml");
const text = readFileSync(file, "utf8");
const lines = text.split("\n");

function serviceBlock(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`service ${name} not found`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z]/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

function listItems(block, section) {
  const start = block.findIndex((line) => line.trim() === `${section}:`);
  if (start === -1) return [];
  const items = [];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (/^    [a-zA-Z_]/.test(line)) break;
    const match = line.match(/^      -\s+(.+)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

const worker = serviceBlock("worker");
const volumes = listItems(worker, "volumes");
const groupAdd = listItems(worker, "group_add");
const problems = [];

for (const expected of ["pi-models.json", "pigo-worker-state", "/var/run/docker.sock"]) {
  if (!volumes.some((entry) => entry.includes(expected))) problems.push(`worker volumes missing ${expected}`);
}
if (groupAdd.some((entry) => entry.includes(":") && entry.includes("/"))) {
  problems.push("group_add contains mount entries (AUD-12 regression)");
}
if (groupAdd.length !== 1) problems.push(`group_add must hold exactly the docker gid, found ${JSON.stringify(groupAdd)}`);

const web = serviceBlock("web");
if (!listItems(web, "volumes").every((entry) => !entry.includes("docker.sock"))) {
  problems.push("web must not mount the docker socket");
}

// OCI promotion must be able to replace every locally-built image with the
// exact digest references produced by CI. Defaults keep local development
// convenient, while staging/production supply the overrides via --env-file.
const immutableImageBindings = [
  ["runtime", "PI_RUNTIME_IMAGE"],
  ["web", "PI_WEB_IMAGE"],
  ["worker", "PI_WORKER_IMAGE"],
];
for (const [service, variable] of immutableImageBindings) {
  const imageLine = serviceBlock(service).find((line) => line.trim().startsWith("image:"));
  if (!imageLine?.includes(`\${${variable}:-`)) {
    problems.push(`${service} image must support the ${variable} immutable OCI override`);
  }
}
const sandboxImageLine = worker.find((line) => line.trim().startsWith("PI_SANDBOX_IMAGE:"));
if (!sandboxImageLine?.includes("${PI_SANDBOX_IMAGE:-")) {
  problems.push("worker must forward the PI_SANDBOX_IMAGE immutable OCI override");
}

// v0.22 (B3): every critical PI_* variable must reach the service that reads it,
// and the deployment log must be mounted read-only for the deployment panel.
for (const problem of checkComposeCoverage(text).problems) problems.push(problem);

if (problems.length > 0) {
  console.error("compose validation failed:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("compose structure OK (immutable OCI overrides, worker volumes + group_add, web isolation, config coverage)");
