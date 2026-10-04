import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAcceptanceSnapshot } from "./acceptance.js";

const baseRun = {
  findings: [
    { id: "f1", severity: "high" as const, resolved: true },
    { id: "f2", severity: "low" as const, resolved: false },
    { id: "f3", severity: "critical" as const, resolved: false },
  ],
  checks: [
    { id: "c1", name: "unit", command: "npm test", status: "passed" as const },
    { id: "c2", name: "lint", command: "npm run lint", status: "failed" as const },
    { id: "c3", name: "build", command: "npm run build", status: "pending" as const },
  ],
  usage: { inputTokens: 100, outputTokens: 20, estimatedCost: 0.5 },
  modelCalls: 7,
  diff: "diff --git a b",
};

describe("buildAcceptanceSnapshot (B2)", () => {
  it("splits resolved and remaining findings with severities", () => {
    const snapshot = buildAcceptanceSnapshot({ run: baseRun, acceptedAt: "now", acceptedBy: "admin", note: "ok" });
    expect(snapshot.findings.resolved).toEqual({ count: 1, ids: ["f1"] });
    expect(snapshot.findings.remaining).toEqual({ count: 2, items: [{ id: "f2", severity: "low" }, { id: "f3", severity: "critical" }] });
    expect(snapshot.checks).toEqual({ total: 3, passed: 1, failed: 1 });
    expect(snapshot.usage).toEqual({ inputTokens: 100, outputTokens: 20, estimatedCost: 0.5, modelCalls: 7 });
  });

  it("prefers artifact identity over hashing the inline diff", () => {
    const snapshot = buildAcceptanceSnapshot({
      run: baseRun,
      acceptedAt: "now",
      acceptedBy: "admin",
      artifact: { artifactId: "diff-r2", sha256: "abc", bytes: 42 },
    });
    expect(snapshot.diff).toEqual({ artifactId: "diff-r2", sha256: "abc", bytes: 42 });
  });

  it("hashes the inline diff when no artifact metadata exists", () => {
    const snapshot = buildAcceptanceSnapshot({ run: baseRun, acceptedAt: "now", acceptedBy: "admin" });
    expect(snapshot.diff.artifactId).toBe("diff");
    expect(snapshot.diff.sha256).toBe(createHash("sha256").update("diff --git a b", "utf8").digest("hex"));
    expect(snapshot.diff.bytes).toBe(Buffer.byteLength("diff --git a b", "utf8"));
  });

  it("keeps unknown identity as null instead of inventing zeros", () => {
    const snapshot = buildAcceptanceSnapshot({ run: { ...baseRun, diff: "" }, acceptedAt: "now", acceptedBy: "admin" });
    expect(snapshot.diff).toEqual({ artifactId: null, sha256: null, bytes: null });
  });

  it("trims the note and defaults acknowledgedOpenFindings to false", () => {
    const snapshot = buildAcceptanceSnapshot({ run: baseRun, acceptedAt: "now", acceptedBy: "admin", note: "  x  ", acknowledgedOpenFindings: true });
    expect(snapshot.note).toBe("x");
    expect(snapshot.acknowledgedOpenFindings).toBe(true);
    expect(buildAcceptanceSnapshot({ run: baseRun, acceptedAt: "now", acceptedBy: "admin" }).acknowledgedOpenFindings).toBe(false);
  });

  it("is defensive about missing findings/checks/usage (older snapshots)", () => {
    const snapshot = buildAcceptanceSnapshot({
      run: { findings: undefined as never, checks: undefined as never, usage: undefined as never, modelCalls: undefined, diff: "d" },
      acceptedAt: "now",
      acceptedBy: "admin",
    });
    expect(snapshot.findings).toEqual({ resolved: { count: 0, ids: [] }, remaining: { count: 0, items: [] } });
    expect(snapshot.checks).toEqual({ total: 0, passed: 0, failed: 0 });
    expect(snapshot.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCost: 0, modelCalls: 0 });
  });
});
