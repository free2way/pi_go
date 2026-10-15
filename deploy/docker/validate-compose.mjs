#!/usr/bin/env node
/**
 * AUD-12 / AT-OPS-001: offline structure check for deploy/docker/compose.yaml.
 * Verifies the worker reaches Docker only through the authenticated policy
 * gateway, while the raw socket and docker gid remain confined to that gateway.
 * Run with `npm run validate:compose`.
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

for (const expected of ["/home/node/.pi/agent/models.json", "pigo-worker-state"]) {
  if (!volumes.some((entry) => entry.includes(expected))) problems.push(`worker volumes missing ${expected}`);
}
if (volumes.some((entry) => entry.includes("docker.sock"))) problems.push("worker must not mount the Docker socket");
if (groupAdd.length !== 0) problems.push(`worker must not join the docker group, found ${JSON.stringify(groupAdd)}`);
if (!worker.some((line) => line.includes("PI_DOCKER_GATEWAY_URL: http://sandbox-gateway:3210"))) {
  problems.push("worker must use the internal sandbox gateway");
}
if (!worker.some((line) => line.trim() === 'PI_DOCKER_GATEWAY_REQUIRED: "1"')) {
  problems.push("worker must fail closed when the sandbox gateway is absent");
}
if (!listItems(worker, "networks").includes("sandbox-control")) problems.push("worker must join sandbox-control");

const gateway = serviceBlock("sandbox-gateway");
const gatewayVolumes = listItems(gateway, "volumes");
const gatewayGroupAdd = listItems(gateway, "group_add");
if (!gatewayVolumes.some((entry) => entry.includes("${PI_DOCKER_SOCKET:-/var/run/docker.sock}:${PI_DOCKER_SOCKET:-/var/run/docker.sock}"))) {
  problems.push("sandbox-gateway must mount only the configured PI_DOCKER_SOCKET path");
}
if (gatewayGroupAdd.length !== 1) problems.push(`sandbox-gateway group_add must hold exactly the docker gid, found ${JSON.stringify(gatewayGroupAdd)}`);
if (!listItems(gateway, "networks").includes("sandbox-control")) problems.push("sandbox-gateway must join sandbox-control");
if (!gateway.some((line) => line.trim() === "read_only: true")) problems.push("sandbox-gateway root filesystem must be read-only");
if (!gateway.some((line) => line.trim() === "- no-new-privileges:true")) problems.push("sandbox-gateway must enable no-new-privileges");

const web = serviceBlock("web");
if (!listItems(web, "volumes").every((entry) => !entry.includes("docker.sock"))) {
  problems.push("web must not mount the docker socket");
}
const networkBlock = serviceBlock("sandbox-control");
if (!networkBlock.some((line) => line.trim() === "internal: true")) problems.push("sandbox-control network must be internal");

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
console.log("compose structure OK (immutable OCI overrides, sandbox gateway isolation, web isolation, config coverage)");
