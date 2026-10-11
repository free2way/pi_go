#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OCI_COMPONENTS = Object.freeze(["runtime", "web", "worker", "sandbox", "executor"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function metadataDigest(metadata, component) {
  const digest = metadata?.["containerimage.digest"];
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`${component} metadata does not contain a valid containerimage.digest`);
  }
  return digest;
}

export function buildOciManifest({ commit, repositoryPrefix, runUrl, generatedAt, metadataByComponent }) {
  const normalizedCommit = requiredString(commit, "commit");
  if (!COMMIT_PATTERN.test(normalizedCommit)) throw new Error("commit must be a full lowercase 40-character Git SHA");
  const prefix = requiredString(repositoryPrefix, "repository prefix").replace(/\/+$/u, "");
  const timestamp = requiredString(generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(timestamp))) throw new Error("generatedAt must be an ISO-8601 timestamp");

  const images = {};
  for (const component of OCI_COMPONENTS) {
    const digest = metadataDigest(metadataByComponent?.[component], component);
    const repository = `${prefix}-${component}`;
    images[component] = {
      repository,
      tag: normalizedCommit,
      digest,
      reference: `${repository}@${digest}`,
    };
  }

  return {
    schemaVersion: 1,
    commit: normalizedCommit,
    generatedAt: timestamp,
    ...(runUrl ? { runUrl: String(runUrl) } : {}),
    images,
  };
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metadataDir = resolve(requiredString(options["metadata-dir"], "metadata-dir"));
  const metadataByComponent = Object.fromEntries(
    OCI_COMPONENTS.map((component) => {
      const path = resolve(metadataDir, `${component}.json`);
      return [component, JSON.parse(readFileSync(path, "utf8"))];
    }),
  );
  const manifest = buildOciManifest({
    commit: options.commit,
    repositoryPrefix: options["repository-prefix"],
    runUrl: options["run-url"],
    generatedAt: options["generated-at"] ?? new Date().toISOString(),
    metadataByComponent,
  });
  const outputPath = resolve(requiredString(options.output, "output"));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  if (options["github-output"]) {
    const outputLines = OCI_COMPONENTS.flatMap((component) => [
      `${component}_digest=${manifest.images[component].digest}`,
      `${component}_repository=${manifest.images[component].repository}`,
    ]);
    appendFileSync(resolve(options["github-output"]), `${outputLines.join("\n")}\n`);
  }
  console.log(`[oci-manifest] wrote ${OCI_COMPONENTS.length} immutable image references to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
