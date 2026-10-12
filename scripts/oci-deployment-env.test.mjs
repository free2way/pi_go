import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOciManifest, OCI_COMPONENTS } from "./oci-manifest.mjs";
import { DEPLOYMENT_IMAGE_ENV, renderDeploymentEnv, validateDeploymentManifest } from "./oci-deployment-env.mjs";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  return buildOciManifest({
    commit: COMMIT,
    repositoryPrefix: "ghcr.io/acme/pigo",
    generatedAt: "2026-10-12T00:00:00.000Z",
    metadataByComponent: Object.fromEntries(OCI_COMPONENTS.map((component) => [component, { "containerimage.digest": DIGEST }])),
  });
}

test("renders only digest-pinned image references for every deployable component", () => {
  const manifest = fixture();
  const rendered = renderDeploymentEnv(manifest, {
    expectedCommit: COMMIT,
    manifestSha256: "c".repeat(64),
  });

  assert.match(rendered, new RegExp(`^PIGO_RELEASE_COMMIT=${COMMIT}$`, "m"));
  for (const component of OCI_COMPONENTS) {
    assert.match(rendered, new RegExp(`^${DEPLOYMENT_IMAGE_ENV[component]}=ghcr\\.io/acme/pigo-${component}@${DIGEST}$`, "m"));
  }
  assert.doesNotMatch(rendered, /:a{40}$/m, "deployment references must not use mutable tags");
});

test("rejects a manifest for a different commit", () => {
  assert.throws(() => validateDeploymentManifest(fixture(), "d".repeat(40)), /does not match the expected commit/);
});

test("rejects a tag-shaped or tampered image reference", () => {
  const manifest = fixture();
  manifest.images.web.reference = `${manifest.images.web.repository}:${COMMIT}`;
  assert.throws(() => validateDeploymentManifest(manifest), /must exactly match repository@digest/);
});

test("rejects repository text that could inject another env entry", () => {
  const manifest = fixture();
  manifest.images.worker.repository += "\nUNSAFE=value";
  manifest.images.worker.reference = `${manifest.images.worker.repository}@${manifest.images.worker.digest}`;
  assert.throws(() => validateDeploymentManifest(manifest), /not a safe OCI repository/);
});

test("CI emits a deployment environment only after the vulnerability gate", () => {
  const workflow = readFileSync(resolve(REPO_ROOT, ".github/workflows/oci-supply-chain.yml"), "utf8");
  const gate = workflow.indexOf("- name: Enforce vulnerability gate");
  const deployment = workflow.indexOf("- name: Create digest-pinned deployment environment");
  const upload = workflow.indexOf("- name: Upload supply-chain evidence");
  assert.ok(gate >= 0 && deployment > gate, "deployment.env must be produced after the vulnerability gate");
  assert.ok(upload > deployment, "successful deployment.env must be included in the evidence artifact");
});

test("both Compose entry points accept digest-pinned image overrides", () => {
  const mainCompose = readFileSync(resolve(REPO_ROOT, "deploy/docker/compose.yaml"), "utf8");
  const executorCompose = readFileSync(resolve(REPO_ROOT, "deploy/executor/compose.yaml"), "utf8");
  for (const variable of ["PI_RUNTIME_IMAGE", "PI_WEB_IMAGE", "PI_WORKER_IMAGE", "PI_SANDBOX_IMAGE"]) {
    assert.match(mainCompose, new RegExp(`\\$\\{${variable}:-`));
  }
  assert.match(executorCompose, /\$\{PIGO_EXECUTOR_IMAGE:-/);
});
