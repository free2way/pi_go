import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

it("all caught Worker console diagnostics use the safe sink", () => {
  const lines = source.split("\n").filter((line) => /console\.(warn|error|log)/.test(line));
  expect(lines.some((line) => /\$\{[^}]*\.message\}/.test(line))).toBe(false);
  for (const label of ["statfs failed", "claim failed", "heartbeat failed", "deferred dispatch failed", "checkpoints",
    "deadline terminal update failed", "budget terminal update failed", "terminal update failed", "finish failed", "reclaim failed"]) {
    const line = lines.find((candidate) => candidate.includes(label));
    expect(line, label).toBeDefined();
    expect(line, label).toContain("diagnosticMessage(");
  }
});

it("callback diagnostics reach the job-aware sink before truncation", () => {
  const body = source.slice(source.indexOf("async function postUpdate("), source.indexOf("async function update("));
  expect(body).toContain("${response.status} ${body}");
  expect(body).not.toContain("body.slice(");
  const snapshot = source.slice(source.indexOf("async function prepareReviewSnapshot("), source.indexOf("const decision = evaluateSnapshotDivergence"));
  expect(snapshot).toContain("snapshotFailedText(diagnosticMessage(error, Object.values(input.credentials), 300))");
});

it("HTTP errors are sanitized without rewriting successful model protocols or patches", () => {
  const body = source.slice(source.indexOf("function json("), source.indexOf("const MAX_INTERNAL_BODY"));
  expect(body).toContain('typeof body.error === "string"');
  expect(body).toContain("{ ...body, error: diagnosticMessage(body.error) } : body");
  expect(source).toContain("parseDevelopmentPlan(redactJobSecrets(result.text, credentials)");
  expect(source).toContain("parseReview(redactJobSecrets(firstReview.text, input.credentials)");
});
