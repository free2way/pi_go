import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMergeRequestPayload,
  mergeRequestUnavailable,
  patchFileName,
  resolveMergeRequestConfig,
  selectPatch,
} from "./run-patch.js";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("selectPatch (A1)", () => {
  it("prefers the durable artifact over the possibly-truncated inline diff", () => {
    const selection = selectPatch({
      artifact: { artifactId: "diff-r2-abc", content: "full patch", sha256: "ignored", bytes: 1 },
      runDiff: "truncated",
      baseSha: "base1",
    });
    expect(selection).toMatchObject({ origin: "artifact", content: "full patch", artifactId: "diff-r2-abc", baseSha: "base1" });
    expect(selection?.sha256).toBe(hash("full patch"));
    expect(selection?.bytes).toBe(Buffer.byteLength("full patch", "utf8"));
  });

  it("falls back to the inline diff when the artifact has no body", () => {
    expect(selectPatch({ artifact: { artifactId: "diff", content: null }, runDiff: "inline" })).toMatchObject({ origin: "run", content: "inline" });
  });

  it("falls back to a freshly generated worktree diff", () => {
    expect(selectPatch({ runDiff: "", worktreeDiff: "fresh" })).toMatchObject({ origin: "worktree", content: "fresh" });
  });

  it("returns undefined when no source produced content", () => {
    expect(selectPatch({ artifact: { content: null }, runDiff: "", worktreeDiff: "" })).toBeUndefined();
    expect(selectPatch({})).toBeUndefined();
  });
});

describe("patchFileName", () => {
  it("sanitizes the run id", () => {
    expect(patchFileName("run_abc-123")).toBe("run_abc-123.patch");
    expect(patchFileName("run/../evil")).toBe("run_.._evil.patch");
    expect(patchFileName("")).toBe("run.patch");
  });
});

describe("resolveMergeRequestConfig (A1)", () => {
  it("is not configured without a URL and gives a clear reason", () => {
    const config = resolveMergeRequestConfig({});
    expect(config.configured).toBe(false);
    expect(config.reason).toContain("PI_MERGE_REQUEST_URL");
  });

  it("rejects a non-http URL", () => {
    expect(resolveMergeRequestConfig({ PI_MERGE_REQUEST_URL: "ftp://x" })).toMatchObject({ configured: false });
  });

  it("reads the optional token, project and target branch", () => {
    expect(resolveMergeRequestConfig({
      PI_MERGE_REQUEST_URL: "https://git.example/api/mr",
      PI_MERGE_REQUEST_TOKEN: "tok",
      PI_MERGE_REQUEST_PROJECT: "team/repo",
      PI_MERGE_REQUEST_TARGET_BRANCH: "main",
    })).toEqual({ configured: true, url: "https://git.example/api/mr", token: "tok", project: "team/repo", targetBranch: "main" });
  });
});

describe("mergeRequestUnavailable / buildMergeRequestPayload (A1)", () => {
  it("shapes a 409 refusal", () => {
    expect(mergeRequestUnavailable({ configured: false, reason: "nope" })).toEqual({ status: 409, code: "MERGE_REQUEST_NOT_CONFIGURED", message: "nope" });
  });

  it("carries the full patch and never any token", () => {
    const patch = selectPatch({ runDiff: "diff --git a b" })!;
    const payload = buildMergeRequestPayload({
      run: { id: "run_1", title: "T", task: "task", repository: "r", branch: "pigo/run_1", baseSha: "b", summary: "s" },
      patch,
      targetBranch: "main",
      project: "team/repo",
      requestedBy: "user_1",
    });
    expect(payload).toMatchObject({ action: "open_merge_request", runId: "run_1", sourceBranch: "pigo/run_1", targetBranch: "main", repository: "team/repo" });
    expect(payload.patch.content).toBe("diff --git a b");
    expect(payload.patch.sha256).toBe(hash("diff --git a b"));
  });
});
