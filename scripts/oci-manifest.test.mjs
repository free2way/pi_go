import test from "node:test";
import assert from "node:assert/strict";

import { OCI_COMPONENTS, buildOciManifest, metadataDigest, parseArgs } from "./oci-manifest.mjs";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function metadata() {
  return Object.fromEntries(OCI_COMPONENTS.map((component) => [component, { "containerimage.digest": DIGEST }]));
}

test("buildOciManifest emits only full-SHA tags and digest-pinned references", () => {
  const manifest = buildOciManifest({
    commit: COMMIT,
    repositoryPrefix: "ghcr.io/example/pigo",
    runUrl: "https://github.com/example/pigo/actions/runs/1",
    generatedAt: "2026-10-11T00:00:00.000Z",
    metadataByComponent: metadata(),
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.commit, COMMIT);
  assert.deepEqual(Object.keys(manifest.images), OCI_COMPONENTS);
  assert.deepEqual(manifest.images.worker, {
    repository: "ghcr.io/example/pigo-worker",
    tag: COMMIT,
    digest: DIGEST,
    reference: `ghcr.io/example/pigo-worker@${DIGEST}`,
  });
});

test("metadataDigest rejects missing and mutable metadata", () => {
  assert.throws(() => metadataDigest({}, "web"), /valid containerimage\.digest/u);
  assert.throws(() => metadataDigest({ "containerimage.digest": "latest" }, "web"), /valid containerimage\.digest/u);
});

test("buildOciManifest rejects abbreviated commits", () => {
  assert.throws(
    () => buildOciManifest({
      commit: "abc123",
      repositoryPrefix: "ghcr.io/example/pigo",
      generatedAt: "2026-10-11T00:00:00.000Z",
      metadataByComponent: metadata(),
    }),
    /full lowercase 40-character Git SHA/u,
  );
});

test("parseArgs rejects incomplete option pairs", () => {
  assert.deepEqual(parseArgs(["--commit", COMMIT, "--output", "manifest.json"]), { commit: COMMIT, output: "manifest.json" });
  assert.throws(() => parseArgs(["--commit"]), /invalid argument/u);
});
