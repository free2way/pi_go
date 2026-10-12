#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OCI_COMPONENTS, parseArgs } from "./oci-manifest.mjs";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;

export const DEPLOYMENT_IMAGE_ENV = Object.freeze({
  runtime: "PI_RUNTIME_IMAGE",
  web: "PI_WEB_IMAGE",
  worker: "PI_WORKER_IMAGE",
  sandbox: "PI_SANDBOX_IMAGE",
  executor: "PIGO_EXECUTOR_IMAGE",
});

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

/**
 * Validate the supply-chain manifest before it can influence Compose. This is
 * deliberately stricter than Docker's parser: promotion accepts digest-pinned
 * lowercase repositories only, never tags, shell syntax, or partial SHAs.
 */
export function validateDeploymentManifest(manifest, expectedCommit = undefined) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  const commit = requiredString(manifest.commit, "manifest commit");
  if (!COMMIT_PATTERN.test(commit)) throw new Error("manifest commit must be a full lowercase 40-character Git SHA");
  if (expectedCommit !== undefined && commit !== requiredString(expectedCommit, "expected commit")) {
    throw new Error(`manifest commit ${commit} does not match the expected commit`);
  }

  const images = {};
  for (const component of OCI_COMPONENTS) {
    const image = manifest.images?.[component];
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error(`manifest image ${component} is required`);
    }
    const repository = requiredString(image.repository, `${component} repository`);
    const digest = requiredString(image.digest, `${component} digest`);
    const reference = requiredString(image.reference, `${component} reference`);
    if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`${component} repository is not a safe OCI repository`);
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`${component} digest is not a sha256 digest`);
    if (image.tag !== commit) throw new Error(`${component} evidence tag must equal the manifest commit`);
    if (reference !== `${repository}@${digest}`) {
      throw new Error(`${component} reference must exactly match repository@digest`);
    }
    images[component] = Object.freeze({ repository, digest, reference });
  }
  return Object.freeze({ commit, images: Object.freeze(images) });
}

export function renderDeploymentEnv(manifest, { expectedCommit, manifestSha256 } = {}) {
  const validated = validateDeploymentManifest(manifest, expectedCommit);
  const digest = requiredString(manifestSha256, "manifest SHA-256");
  if (!DIGEST_PATTERN.test(`sha256:${digest.replace(/^sha256:/u, "")}`)) {
    throw new Error("manifest SHA-256 is invalid");
  }
  const normalizedManifestDigest = digest.replace(/^sha256:/u, "");
  const lines = [
    `PIGO_RELEASE_COMMIT=${validated.commit}`,
    `PIGO_RELEASE_MANIFEST_SHA256=${normalizedManifestDigest}`,
    ...OCI_COMPONENTS.map((component) => `${DEPLOYMENT_IMAGE_ENV[component]}=${validated.images[component].reference}`),
  ];
  return `${lines.join("\n")}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(requiredString(options.manifest, "manifest"));
  const outputPath = resolve(requiredString(options.output, "output"));
  const manifestText = readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  const rendered = renderDeploymentEnv(manifest, {
    expectedCommit: options["expected-commit"],
    manifestSha256: sha256(manifestText),
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, { flag: "wx", mode: 0o600 });
  console.log(`[oci-deployment-env] wrote ${OCI_COMPONENTS.length} digest-pinned image references to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[oci-deployment-env] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
