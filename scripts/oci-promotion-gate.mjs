#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./oci-manifest.mjs";
import { renderDeploymentEnv, validateDeploymentManifest } from "./oci-deployment-env.mjs";

const AUTH_MODES = new Set(["development", "cloudflare", "clerk"]);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function validatePromotionBundle({ manifestText, deploymentEnvText, expectedCommit }) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  const manifestSha256 = sha256(manifestText);
  const validated = validateDeploymentManifest(manifest, expectedCommit);
  const expectedEnv = renderDeploymentEnv(manifest, { expectedCommit, manifestSha256 });
  if (deploymentEnvText !== expectedEnv) {
    throw new Error("deployment environment does not exactly match the immutable manifest");
  }
  return { manifest, manifestSha256, commit: validated.commit, images: validated.images, deploymentEnvText };
}

export function authorizeProduction(bundle, stagingEvidence) {
  if (!stagingEvidence || stagingEvidence.schemaVersion !== 1 || stagingEvidence.environment !== "staging" || stagingEvidence.status !== "succeeded") {
    throw new Error("production requires successful staging evidence");
  }
  if (stagingEvidence.commit !== bundle.commit || stagingEvidence.manifestSha256 !== bundle.manifestSha256) {
    throw new Error("staging evidence does not match the production manifest");
  }
  for (const [component, image] of Object.entries(bundle.images)) {
    if (stagingEvidence.images?.[component] !== image.reference) {
      throw new Error(`staging ${component} digest does not match the production manifest`);
    }
  }
  return bundle.deploymentEnvText;
}

async function checkedJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (response.status >= 300 && response.status < 400) throw new Error("health probe was intercepted by an upstream login redirect");
  if (!response.ok) throw new Error(`health probe returned HTTP ${response.status}`);
  return response.json();
}

export async function recordPromotionEvidence({
  environment,
  bundle,
  healthUrl,
  expectedAuthMode,
  stagingEvidence,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (environment !== "staging" && environment !== "production") throw new Error("environment must be staging or production");
  if (!AUTH_MODES.has(expectedAuthMode)) throw new Error("expected auth mode is invalid");
  if (environment === "production" && expectedAuthMode === "development") throw new Error("production cannot use development authentication");
  if (environment === "production") authorizeProduction(bundle, stagingEvidence);

  let health;
  try {
    health = new URL(required(healthUrl, "health URL"));
  } catch {
    throw new Error("health URL is invalid");
  }
  if (health.username || health.password || health.protocol !== "https:") throw new Error("health URL must be credential-free HTTPS");
  const result = await checkedJson(health.href, fetchImpl);
  if (result?.status !== "ok") throw new Error("deployment health status is not ok");
  if (result?.authMode !== expectedAuthMode) throw new Error("deployment auth mode does not match the promotion request");
  if (expectedAuthMode === "clerk") {
    const authConfig = await checkedJson(new URL("/api/auth/config", health.origin).href, fetchImpl);
    if (authConfig?.mode !== "clerk" || typeof authConfig?.clerk?.publishableKey !== "string" || !authConfig.clerk.publishableKey) {
      throw new Error("Clerk public bootstrap configuration is not ready");
    }
  }

  return {
    schemaVersion: 1,
    environment,
    status: "succeeded",
    commit: bundle.commit,
    manifestSha256: bundle.manifestSha256,
    images: Object.fromEntries(Object.entries(bundle.images).map(([component, image]) => [component, image.reference])),
    health: { status: "ok", authMode: expectedAuthMode, checkedAt: now().toISOString() },
    recordedAt: now().toISOString(),
  };
}

function readBundle(options) {
  const manifestText = readFileSync(resolve(required(options.manifest, "manifest")), "utf8");
  const deploymentEnvText = readFileSync(resolve(required(options["deployment-env"], "deployment-env")), "utf8");
  return validatePromotionBundle({ manifestText, deploymentEnvText, expectedCommit: options["expected-commit"] });
}

function writeExclusive(pathValue, text) {
  const output = resolve(required(pathValue, "output"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text, { flag: "wx", mode: 0o600 });
  return output;
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (command !== "record" && command !== "authorize") throw new Error("command must be record or authorize");
  const options = parseArgs(rawArgs);
  const bundle = readBundle(options);
  const stagingEvidence = options["staging-evidence"]
    ? JSON.parse(readFileSync(resolve(options["staging-evidence"]), "utf8"))
    : undefined;

  if (command === "authorize") {
    const output = writeExclusive(options.output, authorizeProduction(bundle, stagingEvidence));
    console.log(`[oci-promotion] production authorized for ${bundle.commit}; wrote ${output}`);
    return;
  }
  const evidence = await recordPromotionEvidence({
    environment: required(options.environment, "environment"),
    bundle,
    healthUrl: options["health-url"],
    expectedAuthMode: required(options["expected-auth-mode"], "expected-auth-mode"),
    stagingEvidence,
  });
  const output = writeExclusive(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[oci-promotion] recorded verified ${evidence.environment} evidence for ${bundle.commit} at ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[oci-promotion] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
