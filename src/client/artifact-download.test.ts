import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunArtifact } from "../shared/types";
import { ArtifactDownloadError, diagnosticFilename, validatedArtifactBlob } from "./artifact-download";
import { api, setAuthTokenProvider } from "./api";

const body = "trace safe [redacted] 中文\n";
const artifact: RunArtifact = { runId: "run-one", artifactId: "trace", kind: "trace", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), baseSha: null, createdAt: "2026-01-01T00:00:00Z" };
const response = (text = body) => new Response(text, { headers: { "content-type": "application/octet-stream" } });
afterEach(() => vi.unstubAllGlobals());

describe("diagnostic artifact downloads", () => {
  it("preserves Unicode bytes after SHA validation", async () => {
    expect(await (await validatedArtifactBlob(response(), artifact)).text()).toBe(body);
  });
  it.each([[409, "unsafe"], [401, "unavailable"], [403, "unavailable"], [404, "unavailable"], [413, "tooLarge"], [500, "failed"]])("does not expose an error body for HTTP %s", async (status, reason) => {
    const pending = validatedArtifactBlob(new Response("DUMMY_private_proxy_diagnostic", { status: Number(status) }), artifact);
    await expect(pending).rejects.toMatchObject({ reason, message: "Artifact download failed" });
  });
  it("blocks a login page returned as success", async () => {
    await expect(validatedArtifactBlob(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), artifact)).rejects.toBeInstanceOf(ArtifactDownloadError);
  });
  it("blocks same-length body substitution", async () => {
    await expect(validatedArtifactBlob(response(body.replace("safe", "fake")), artifact)).rejects.toMatchObject({ reason: "integrity" });
  });
  it.each([{ bytes: artifact.bytes + 1 }, { sha256: null }, { sha256: "bad" }])("requires matching bytes and a usable hash: %o", async (override) => {
    await expect(validatedArtifactBlob(response(), { ...artifact, ...override })).rejects.toMatchObject({ reason: "integrity" });
  });
  it("uses same-origin credentials, Clerk token, encoded IDs and no redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
    const dispose = setAuthTokenProvider(async () => "DUMMY_auth_token");
    try {
      const signal = new AbortController().signal;
      await api.downloadDiagnosticArtifact({ ...artifact, runId: "run/one", artifactId: "trace?x" }, signal);
      expect(fetcher).toHaveBeenCalledWith("/api/runs/run%2Fone/artifacts/trace%3Fx/download", { credentials: "same-origin", redirect: "error", signal, headers: { Authorization: "Bearer DUMMY_auth_token" } });
    } finally { dispose(); }
  });
  it("never fetches after a cancelled token lookup", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const dispose = setAuthTokenProvider(async () => { controller.abort(); return "DUMMY_auth_token"; });
    try {
      await expect(api.downloadDiagnosticArtifact(artifact, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { dispose(); }
  });
  it("does not use server headers or arbitrary path characters in download names", () => {
    expect(diagnosticFilename({ ...artifact, runId: "../run", artifactId: "trace\r\n/x" })).toBe("___run-trace___x.txt");
  });
});
