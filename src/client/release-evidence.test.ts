import { describe, expect, it } from "vitest";
import { releaseEvidenceRows, releaseEvidenceStatus } from "./ReleaseEvidence";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("release evidence", () => {
  it("projects every immutable deployment field in a stable order", () => {
    expect(releaseEvidenceRows({
      commit: "1".repeat(40),
      deploymentId: "deploy_1",
      image: "registry.example/app@sha256:abc",
      imageDigest: DIGEST,
      expectedImageDigest: DIGEST,
    })).toEqual([
      expect.objectContaining({ key: "commit", value: "1".repeat(40) }),
      expect.objectContaining({ key: "deploymentId", value: "deploy_1" }),
      expect.objectContaining({ key: "image", value: "registry.example/app@sha256:abc" }),
      expect.objectContaining({ key: "imageDigest", value: DIGEST }),
      expect.objectContaining({ key: "expectedImageDigest", value: DIGEST }),
    ]);
  });

  it("distinguishes verified, incomplete, and mismatched evidence", () => {
    expect(releaseEvidenceStatus({ imageDigest: DIGEST })).toBe("verified");
    expect(releaseEvidenceStatus({ imageDigest: DIGEST, expectedImageDigest: DIGEST })).toBe("verified");
    expect(releaseEvidenceStatus({ imageDigest: "latest" })).toBe("incomplete");
    expect(releaseEvidenceStatus({ imageDigest: DIGEST, expectedImageDigest: `sha256:${"b".repeat(64)}` })).toBe("mismatch");
  });

  it("omits absent and whitespace-only fields", () => {
    expect(releaseEvidenceRows({ commit: "  ", imageDigest: DIGEST }).map((row) => row.key)).toEqual(["imageDigest"]);
  });
});
