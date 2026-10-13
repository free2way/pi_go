import assert from "node:assert/strict";
import test from "node:test";
import { buildOciManifest, OCI_COMPONENTS } from "./oci-manifest.mjs";
import { renderDeploymentEnv } from "./oci-deployment-env.mjs";
import { authorizeProduction, recordPromotionEvidence, validatePromotionBundle } from "./oci-promotion-gate.mjs";
import { createHash } from "node:crypto";

const COMMIT = "1".repeat(40);
const DIGEST = `sha256:${"2".repeat(64)}`;

function fixture() {
  const manifest = buildOciManifest({
    commit: COMMIT,
    repositoryPrefix: "ghcr.io/acme/pigo",
    generatedAt: "2026-10-12T00:00:00.000Z",
    metadataByComponent: Object.fromEntries(OCI_COMPONENTS.map((component) => [component, { "containerimage.digest": DIGEST }])),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const deploymentEnvText = renderDeploymentEnv(manifest, { expectedCommit: COMMIT, manifestSha256 });
  return validatePromotionBundle({ manifestText, deploymentEnvText, expectedCommit: COMMIT });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("records staging evidence only after health and Clerk bootstrap both pass", async () => {
  const bundle = fixture();
  const urls = [];
  const evidence = await recordPromotionEvidence({
    environment: "staging",
    bundle,
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "clerk",
    now: () => new Date("2026-10-12T01:00:00.000Z"),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).endsWith("/api/health")
        ? jsonResponse({ status: "ok", authMode: "clerk" })
        : jsonResponse({ mode: "clerk", clerk: { publishableKey: "public-value" } });
    },
  });
  assert.deepEqual(urls, ["https://staging.example.com/api/health", "https://staging.example.com/api/auth/config"]);
  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.health.authMode, "clerk");
  assert.equal(evidence.images.web, bundle.images.web.reference);
});

test("authorizes production only for the exact staged manifest and all component digests", async () => {
  const bundle = fixture();
  const stagingEvidence = await recordPromotionEvidence({
    environment: "staging",
    bundle,
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });
  assert.equal(authorizeProduction(bundle, stagingEvidence), bundle.deploymentEnvText);
  assert.throws(
    () => authorizeProduction(bundle, { ...stagingEvidence, images: { ...stagingEvidence.images, worker: `ghcr.io/acme/pigo-worker@sha256:${"9".repeat(64)}` } }),
    /worker digest does not match/,
  );
});

test("rejects changed deployment env, redirects, and wrong runtime auth mode", async () => {
  const bundle = fixture();
  assert.throws(
    () => validatePromotionBundle({
      manifestText: `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      deploymentEnvText: bundle.deploymentEnvText.replace(DIGEST, `sha256:${"3".repeat(64)}`),
      expectedCommit: COMMIT,
    }),
    /does not exactly match/,
  );
  await assert.rejects(
    () => recordPromotionEvidence({
      environment: "staging",
      bundle,
      healthUrl: "https://staging.example.com/api/health",
      expectedAuthMode: "clerk",
      fetchImpl: async () => new Response(null, { status: 302 }),
    }),
    /intercepted by an upstream login redirect/,
  );
  await assert.rejects(
    () => recordPromotionEvidence({
      environment: "staging",
      bundle,
      healthUrl: "https://staging.example.com/api/health",
      expectedAuthMode: "clerk",
      fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
    }),
    /auth mode does not match/,
  );
  await assert.rejects(
    () => recordPromotionEvidence({
      environment: "production",
      bundle,
      healthUrl: "https://production.example.com/api/health",
      expectedAuthMode: "development",
      stagingEvidence: {},
      fetchImpl: async () => jsonResponse({ status: "ok", authMode: "development" }),
    }),
    /production cannot use development authentication/,
  );
});
