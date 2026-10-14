#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

function attestationPolicy({ repository, signerWorkflow }) {
  const normalizedRepository = required(repository, "attestation repository");
  const normalizedWorkflow = required(signerWorkflow, "attestation signer workflow");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalizedRepository)) {
    throw new Error("attestation repository must be owner/repository");
  }
  if (!normalizedWorkflow.startsWith(`${normalizedRepository}/.github/workflows/`) || !normalizedWorkflow.endsWith(".yml")) {
    throw new Error("attestation signer workflow must belong to the attestation repository");
  }
  return { repository: normalizedRepository, signerWorkflow: normalizedWorkflow };
}

export function validateAttestationEvidence(bundle, evidence, expectedPolicy) {
  const policy = attestationPolicy(expectedPolicy);
  for (const [component, image] of Object.entries(bundle.images)) {
    const item = evidence?.[component];
    if (!item || item.verified !== true || item.reference !== image.reference
      || item.repository !== policy.repository || item.signerWorkflow !== policy.signerWorkflow
      || item.sourceDigest !== bundle.commit) {
      throw new Error(`${component} image is missing trusted build attestation evidence`);
    }
  }
  return evidence;
}

export function verifyGitHubAttestations(bundle, expectedPolicy, execute = (args) => execFileSync("gh", args, {
  encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
})) {
  const policy = attestationPolicy(expectedPolicy);
  const evidence = {};
  for (const [component, image] of Object.entries(bundle.images)) {
    let result;
    try {
      result = JSON.parse(execute([
        "attestation", "verify", `oci://${image.reference}`,
        "--repo", policy.repository,
        "--signer-workflow", policy.signerWorkflow,
        "--source-digest", bundle.commit,
        "--bundle-from-oci",
        "--deny-self-hosted-runners",
        "--format", "json",
      ]));
    } catch {
      throw new Error(`${component} image attestation verification failed`);
    }
    if (!result || (Array.isArray(result) ? result.length === 0 : typeof result !== "object" || Object.keys(result).length === 0)) {
      throw new Error(`${component} image attestation verification returned no trusted result`);
    }
    evidence[component] = {
      verified: true,
      reference: image.reference,
      repository: policy.repository,
      signerWorkflow: policy.signerWorkflow,
      sourceDigest: bundle.commit,
    };
  }
  return validateAttestationEvidence(bundle, evidence, policy);
}

export function authorizeProduction(bundle, stagingEvidence, expectedAttestationPolicy) {
  if (!stagingEvidence || stagingEvidence.schemaVersion !== 3 || stagingEvidence.environment !== "staging" || stagingEvidence.status !== "succeeded") {
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
  validateRuntimeEvidence(bundle, stagingEvidence.runtime);
  validateAttestationEvidence(bundle, stagingEvidence.attestations, expectedAttestationPolicy);
  return bundle.deploymentEnvText;
}

const RUNNING_COMPONENTS = ["runtime", "web", "worker", "executor"];

export function validateRuntimeEvidence(bundle, evidence) {
  for (const [component, image] of Object.entries(bundle.images)) {
    const item = evidence?.[component];
    if (!item || item.reference !== image.reference || item.commit !== bundle.commit
      || !/^sha256:[a-f0-9]{64}$/u.test(item.imageId ?? "")
      || (RUNNING_COMPONENTS.includes(component) && (item.running !== true || item.containerImageId !== item.imageId))) {
      throw new Error(`actual ${component} runtime does not match the immutable manifest`);
    }
  }
  return evidence;
}

/** Inspect the deployment Docker daemon, not values copied out of the manifest.
 * Sandbox is an on-demand image; all other components must be running.
 */
export function inspectDockerRuntime(bundle, containers, docker = (args) => JSON.parse(execFileSync("docker", args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
}))) {
  const evidence = {};
  for (const [component, image] of Object.entries(bundle.images)) {
    const [actual] = docker(["image", "inspect", image.reference]);
    if (!actual?.RepoDigests?.includes(image.reference) || actual.Config?.Labels?.["org.opencontainers.image.revision"] !== bundle.commit) {
      throw new Error(`actual ${component} image digest/revision does not match the immutable manifest`);
    }
    const item = { reference: image.reference, commit: actual.Config.Labels["org.opencontainers.image.revision"], imageId: actual.Id };
    if (RUNNING_COMPONENTS.includes(component)) {
      const container = containers?.[component];
      if (typeof container !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(container)) throw new Error(`container for ${component} is required`);
      const [running] = docker(["container", "inspect", container]);
      item.containerImageId = running?.Image;
      item.running = running?.State?.Running === true;
      if (running?.Config?.Image !== image.reference) throw new Error(`${component} container is not pinned to the expected digest`);
      if (component === "worker" && !running?.Config?.Env?.includes(`PI_SANDBOX_IMAGE=${bundle.images.sandbox.reference}`)) {
        throw new Error("worker sandbox configuration does not match the staged sandbox digest");
      }
    }
    evidence[component] = item;
  }
  return validateRuntimeEvidence(bundle, evidence);
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
  expectedAttestationPolicy,
  stagingEvidence,
  containers,
  inspectRuntime = inspectDockerRuntime,
  verifyAttestations = verifyGitHubAttestations,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (environment !== "staging" && environment !== "production") throw new Error("environment must be staging or production");
  if (!AUTH_MODES.has(expectedAuthMode)) throw new Error("expected auth mode is invalid");
  if (environment === "production" && expectedAuthMode === "development") throw new Error("production cannot use development authentication");
  const policy = attestationPolicy(expectedAttestationPolicy);
  if (environment === "production") authorizeProduction(bundle, stagingEvidence, policy);

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
  if (result?.commit && result.commit !== bundle.commit) throw new Error("health commit does not match the promotion request");
  if (expectedAuthMode === "clerk") {
    const authConfig = await checkedJson(new URL("/api/auth/config", health.origin).href, fetchImpl);
    if (authConfig?.mode !== "clerk" || typeof authConfig?.clerk?.publishableKey !== "string" || !authConfig.clerk.publishableKey) {
      throw new Error("Clerk public bootstrap configuration is not ready");
    }
  }

  const attestations = validateAttestationEvidence(bundle, await verifyAttestations(bundle, policy), policy);
  const runtime = validateRuntimeEvidence(bundle, await inspectRuntime(bundle, containers));
  return {
    schemaVersion: 3,
    environment,
    status: "succeeded",
    commit: bundle.commit,
    manifestSha256: bundle.manifestSha256,
    images: Object.fromEntries(Object.entries(bundle.images).map(([component, image]) => [component, image.reference])),
    attestations,
    runtime,
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
  const expectedAttestationPolicy = {
    repository: options["attestation-repository"],
    signerWorkflow: options["attestation-signer-workflow"],
  };

  if (command === "authorize") {
    const output = writeExclusive(options.output, authorizeProduction(bundle, stagingEvidence, expectedAttestationPolicy));
    console.log(`[oci-promotion] production authorized for ${bundle.commit}; wrote ${output}`);
    return;
  }
  const evidence = await recordPromotionEvidence({
    environment: required(options.environment, "environment"),
    bundle,
    healthUrl: options["health-url"],
    expectedAuthMode: required(options["expected-auth-mode"], "expected-auth-mode"),
    expectedAttestationPolicy,
    stagingEvidence,
    containers: JSON.parse(readFileSync(resolve(required(options.containers, "containers (JSON file mapping runtime/web/worker/executor to container names)")), "utf8")),
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
