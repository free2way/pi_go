import { describe, expect, it, vi } from "vitest";
import { uploadRunArtifact } from "./artifact-upload.js";

describe("uploadRunArtifact (NEW-07)", () => {
  it("posts the full body to the internal artifact route and returns the server reference", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      artifact: { runId: "run_1", artifactId: "diff-r2-abcdef123456", kind: "patch", bytes: 3_200_000, sha256: "a".repeat(64), baseSha: null, createdAt: "2026-01-01T00:00:00.000Z" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const artifact = await uploadRunArtifact({
      callbackBase: "http://web:3100",
      token: "internal-token",
      runId: "run_1",
      artifactId: "diff-r2-abcdef123456",
      kind: "patch",
      content: "x".repeat(3_200_000),
      ownerId: "owner-a",
    }, fetchImpl);

    expect(artifact.artifactId).toBe("diff-r2-abcdef123456");
    expect(artifact.bytes).toBe(3_200_000);
    expect(artifact.sha256).toBe("a".repeat(64));
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(url).toBe("http://web:3100/api/internal/runs/run_1/artifacts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer internal-token");
    const sent = JSON.parse(String(init.body)) as { content: string; artifactId: string; ownerId: string };
    expect(sent.artifactId).toBe("diff-r2-abcdef123456");
    expect(sent.content.length).toBe(3_200_000);
    expect(sent.ownerId).toBe("owner-a");
  });

  it("throws on an upload failure so the caller can keep the local artifact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    await expect(uploadRunArtifact({
      callbackBase: "http://web:3100",
      token: "",
      runId: "run_1",
      artifactId: "diff-r2-abcdef123456",
      kind: "patch",
      content: "diff",
    }, fetchImpl)).rejects.toThrow(/Unauthorized/);
  });
});
