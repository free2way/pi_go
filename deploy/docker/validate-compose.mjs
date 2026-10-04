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

const file = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "compose.yaml");
const lines = readFileSync(file, "utf8").split("\n");

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

if (problems.length > 0) {
  console.error("compose validation failed:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("compose structure OK (worker volumes + group_add, web isolation)");
