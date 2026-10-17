import assert from "node:assert/strict";
import test from "node:test";
import { buildOciManifest, OCI_COMPONENTS } from "./oci-manifest.mjs";
import { renderDeploymentEnv } from "./oci-deployment-env.mjs";
import { authorizeProduction, recordPromotionEvidence, validateDockerHosts, validatePromotionBundle, inspectDockerRuntime, verifyGitHubAttestations } from "./oci-promotion-gate.mjs";
import { createHash } from "node:crypto";

const COMMIT = "1".repeat(40);
const DIGEST = `sha256:${"2".repeat(64)}`;
const POLICY = {
  repository: "acme/pigo",
  signerWorkflow: "acme/pigo/.github/workflows/oci-supply-chain.yml",
};

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

function dockerFixture(bundle, mutate = () => {}) {
  const containers = Object.fromEntries(["runtime", "web", "worker", "executor"].map(name => [name, name]));
  const docker = (args) => {
    const component = args[0] === "image"
      ? Object.keys(bundle.images).find(name => bundle.images[name].reference === args[2]) : args[2];
    const value = args[0] === "image"
      ? { Id: DIGEST, RepoDigests: [bundle.images[component].reference], Config: { Labels: { "org.opencontainers.image.revision": COMMIT } } }
      : { Image: DIGEST, State: { Running: true }, Config: { Image: bundle.images[component].reference, Env: [`PI_SANDBOX_IMAGE=${bundle.images.sandbox.reference}`] } };
    mutate(args, value);
    return [value];
  };
  return () => inspectDockerRuntime(bundle, containers, docker);
}

function verifiedAttestations(bundle, mutate = () => {}) {
  const evidence = Object.fromEntries(Object.entries(bundle.images).map(([component, image]) => [component, {
    verified: true,
    reference: image.reference,
    repository: POLICY.repository,
    signerWorkflow: POLICY.signerWorkflow,
    sourceDigest: bundle.commit,
  }]));
  mutate(evidence);
  return evidence;
}

function attestationFixture(bundle, mutate) {
  return {
    expectedAttestationPolicy: POLICY,
    verifyAttestations: async () => verifiedAttestations(bundle, mutate),
  };
}

test("records staging evidence only after health and Clerk bootstrap both pass", async () => {
  const bundle = fixture();
  const urls = [];
  const evidence = await recordPromotionEvidence({
    environment: "staging",
    bundle,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "clerk",
    ...attestationFixture(bundle),
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
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    ...attestationFixture(bundle),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });
  assert.equal(authorizeProduction(bundle, stagingEvidence, POLICY), bundle.deploymentEnvText);
  assert.throws(
    () => authorizeProduction(bundle, { ...stagingEvidence, images: { ...stagingEvidence.images, worker: `ghcr.io/acme/pigo-worker@sha256:${"9".repeat(64)}` } }, POLICY),
    /worker digest does not match/,
  );
});

test("healthy endpoints cannot certify absent or different running artifacts", async () => {
  const bundle = fixture();
  const options = { environment: "staging", bundle, healthUrl: "https://staging.example.com/api/health", expectedAuthMode: "cloudflare", ...attestationFixture(bundle),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }) };
  await assert.rejects(() => recordPromotionEvidence({ ...options, inspectRuntime: async () => undefined }), /actual runtime runtime/);
  await assert.rejects(() => recordPromotionEvidence({ ...options, inspectRuntime: dockerFixture(bundle, (args, value) => {
    if (args[0] === "container" && args[2] === "web") value.Image = `sha256:${"9".repeat(64)}`;
  }) }), /actual web runtime/);
  await assert.rejects(() => recordPromotionEvidence({ ...options, inspectRuntime: dockerFixture(bundle, (args, value) => {
    if (args[0] === "image") value.Config.Labels["org.opencontainers.image.revision"] = "9".repeat(40);
  }) }), /image digest\/revision/);
  await assert.rejects(() => recordPromotionEvidence({ ...options, inspectRuntime: dockerFixture(bundle),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare", commit: "9".repeat(40) }) }), /health commit/);
  assert.throws(() => authorizeProduction(bundle, { schemaVersion: 2, environment: "staging", status: "succeeded" }, POLICY), /successful staging evidence/);
});

test("runtime checks reject stopped containers, mutable references and mismatched sandbox config", () => {
  const bundle = fixture();
  assert.throws(dockerFixture(bundle, (args, value) => {
    if (args[0] === "container") value.State.Running = false;
  }), /actual runtime runtime/);
  assert.throws(dockerFixture(bundle, (args, value) => {
    if (args[0] === "container") value.Config.Image = "local/image:latest";
  }), /not pinned/);
  assert.throws(dockerFixture(bundle, (args, value) => {
    if (args[0] === "container" && args[2] === "worker") value.Config.Env = [];
  }), /sandbox configuration/);
});

test("runtime inspection routes each component to its configured local Docker daemon", () => {
  const bundle = fixture();
  const containers = Object.fromEntries(["runtime", "web", "worker", "executor"].map((name) => [name, name]));
  const calls = [];
  const docker = (args, dockerHost) => {
    calls.push({ args, dockerHost });
    const component = args[0] === "image"
      ? Object.keys(bundle.images).find((name) => bundle.images[name].reference === args[2])
      : args[2];
    return [args[0] === "image"
      ? { Id: DIGEST, RepoDigests: [bundle.images[component].reference], Config: { Labels: { "org.opencontainers.image.revision": COMMIT } } }
      : { Image: DIGEST, State: { Running: true }, Config: { Image: bundle.images[component].reference, Env: [`PI_SANDBOX_IMAGE=${bundle.images.sandbox.reference}`] } }];
  };

  inspectDockerRuntime(bundle, containers, docker, { sandbox: "unix:///run/user/1000/docker.sock" });

  assert.equal(calls.find(({ args }) => args[0] === "image" && args[2] === bundle.images.sandbox.reference)?.dockerHost,
    "unix:///run/user/1000/docker.sock");
  assert.equal(calls.find(({ args }) => args[0] === "image" && args[2] === bundle.images.runtime.reference)?.dockerHost, undefined);
  assert.ok(calls.filter(({ args }) => args[0] === "container").every(({ dockerHost }) => dockerHost === undefined));
});

test("docker daemon mappings reject remote, relative and unknown targets", () => {
  assert.deepEqual(validateDockerHosts(), {});
  assert.deepEqual(validateDockerHosts({ sandbox: "unix:///run/user/1000/docker.sock" }), {
    sandbox: "unix:///run/user/1000/docker.sock",
  });
  assert.throws(() => validateDockerHosts({ sandbox: "tcp://docker.example.com:2376" }), /absolute local Unix socket/);
  assert.throws(() => validateDockerHosts({ sandbox: "unix://relative/docker.sock" }), /absolute local Unix socket/);
  assert.throws(() => validateDockerHosts({ sandbox: "unix:///run/user/../docker.sock" }), /absolute local Unix socket/);
  assert.throws(() => validateDockerHosts({ database: "unix:///var/run/docker.sock" }), /component database is invalid/);
});

test("recording forwards Docker daemon mappings to the runtime inspector", async () => {
  const bundle = fixture();
  let received;
  await recordPromotionEvidence({
    environment: "staging",
    bundle,
    dockerHosts: { sandbox: "unix:///run/user/1000/docker.sock" },
    inspectRuntime: async (...args) => {
      received = args[3];
      return dockerFixture(bundle)();
    },
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    ...attestationFixture(bundle),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });
  assert.deepEqual(received, { sandbox: "unix:///run/user/1000/docker.sock" });
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
      ...attestationFixture(bundle),
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
      ...attestationFixture(bundle),
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

test("verifies every digest against the trusted repository, workflow and source commit", () => {
  const bundle = fixture();
  const calls = [];
  const evidence = verifyGitHubAttestations(bundle, POLICY, (args) => {
    calls.push(args);
    return JSON.stringify([{ verificationResult: "success" }]);
  });
  assert.equal(calls.length, OCI_COMPONENTS.length);
  for (const args of calls) {
    assert.ok(args[2].startsWith("oci://ghcr.io/acme/pigo-"));
    assert.ok(args.includes(POLICY.repository));
    assert.ok(args.includes(POLICY.signerWorkflow));
    assert.ok(args.includes(COMMIT));
    assert.ok(args.includes("--bundle-from-oci"));
    assert.ok(args.includes("--deny-self-hosted-runners"));
  }
  assert.deepEqual(evidence, verifiedAttestations(bundle));
  assert.throws(() => verifyGitHubAttestations(bundle, POLICY, () => "[]"), /returned no trusted result/);
});

test("production rejects missing or wrong staging attestation identity", async () => {
  const bundle = fixture();
  const stagingEvidence = await recordPromotionEvidence({
    environment: "staging",
    bundle,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    ...attestationFixture(bundle),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });
  assert.throws(() => authorizeProduction(bundle, {
    ...stagingEvidence,
    attestations: verifiedAttestations(bundle, (value) => { value.web.repository = "attacker/fork"; }),
  }, POLICY), /web image is missing trusted/);
  await assert.rejects(() => recordPromotionEvidence({
    environment: "staging",
    bundle,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    expectedAttestationPolicy: POLICY,
    verifyAttestations: async () => ({}),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  }), /runtime image is missing trusted/);
});

test("advisory attestation mode records warnings without weakening immutable promotion gates", async () => {
  const bundle = fixture();
  const stagingEvidence = await recordPromotionEvidence({
    environment: "staging",
    bundle,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    expectedAttestationPolicy: POLICY,
    attestationMode: "advisory",
    verifyAttestations: async () => { throw new Error("verification tool is unavailable"); },
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });

  assert.deepEqual(stagingEvidence.attestation, { mode: "advisory", status: "warning" });
  assert.equal(stagingEvidence.attestations.runtime.verified, false);
  assert.equal(stagingEvidence.attestations.runtime.status, "warning");
  assert.match(stagingEvidence.attestations.runtime.warning, /verification tool is unavailable/);
  assert.throws(() => authorizeProduction(bundle, stagingEvidence, POLICY), /missing trusted/);
  assert.equal(authorizeProduction(bundle, stagingEvidence, POLICY, "advisory"), bundle.deploymentEnvText);

  assert.throws(() => authorizeProduction(bundle, {
    ...stagingEvidence,
    attestations: {
      ...stagingEvidence.attestations,
      web: { ...stagingEvidence.attestations.web, reference: `ghcr.io/acme/pigo-web@sha256:${"9".repeat(64)}` },
    },
  }, POLICY, "advisory"), /web image is missing trusted/);

  const productionEvidence = await recordPromotionEvidence({
    environment: "production",
    bundle,
    stagingEvidence,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://production.example.com/api/health",
    expectedAuthMode: "cloudflare",
    expectedAttestationPolicy: POLICY,
    attestationMode: "advisory",
    verifyAttestations: async () => ({}),
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  });
  assert.equal(productionEvidence.status, "succeeded");
  assert.deepEqual(productionEvidence.attestation, { mode: "advisory", status: "warning" });
});

test("rejects unknown attestation modes", async () => {
  const bundle = fixture();
  await assert.rejects(() => recordPromotionEvidence({
    environment: "staging",
    bundle,
    inspectRuntime: dockerFixture(bundle),
    healthUrl: "https://staging.example.com/api/health",
    expectedAuthMode: "cloudflare",
    expectedAttestationPolicy: POLICY,
    attestationMode: "disabled",
    fetchImpl: async () => jsonResponse({ status: "ok", authMode: "cloudflare" }),
  }), /attestation mode must be enforce or advisory/);
});
