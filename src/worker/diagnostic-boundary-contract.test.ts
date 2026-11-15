import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function readSource(module: string) {
  return readFileSync(new URL(`./${module}.ts`, import.meta.url), "utf8");
}

it("all caught Worker console diagnostics use the safe sink", () => {
  const modules = [
    "index", "worker-runtime", "worker-process", "worker-web-client", "worker-git",
    "pi-cli-runner", "run-review", "run-execution", "worker-jobs", "worker-http",
  ];
  const lines = modules.flatMap((module) => readSource(module).split("\n"))
    .filter((line) => /console\.(warn|error|log)/.test(line));
  expect(lines.some((line) => /\$\{[^}]*\.message\}/.test(line))).toBe(false);
  for (const label of ["statfs failed", "claim failed", "heartbeat failed", "deferred dispatch failed", "checkpoints",
    "deadline terminal update failed", "budget terminal update failed", "terminal update failed", "finish failed", "reclaim failed"]) {
    const line = lines.find((candidate) => candidate.includes(label));
    expect(line, label).toBeDefined();
    expect(line, label).toContain("diagnosticMessage(");
  }
});

it("callback diagnostics reach the job-aware sink before truncation", () => {
  const callbacks = readSource("worker-web-client");
  const body = callbacks.slice(callbacks.indexOf("async function postUpdate("), callbacks.indexOf("async function update("));
  expect(body).toContain("${response.status} ${body}");
  expect(body).not.toContain("body.slice(");
  const review = readSource("run-review");
  const snapshot = review.slice(review.indexOf("async function prepareReviewSnapshot("), review.indexOf("const decision = evaluateSnapshotDivergence"));
  expect(snapshot).toContain("snapshotFailedText(diagnosticMessage(error, Object.values(input.credentials), 300))");
});

it("HTTP errors are sanitized without rewriting successful model protocols or patches", () => {
  const http = readSource("worker-http");
  const body = http.slice(http.indexOf("function json("), http.indexOf("const MAX_INTERNAL_BODY"));
  expect(body).toContain('typeof body.error === "string"');
  expect(body).toContain("{ ...body, error: diagnosticMessage(body.error) } : body");
  expect(readSource("index")).toContain("parseDevelopmentPlan(redactJobSecrets(result.text, credentials)");
  expect(readSource("index")).toContain("parseReview(redactJobSecrets(firstReview.text, input.credentials)");
});
