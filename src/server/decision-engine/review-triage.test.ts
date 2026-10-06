import { describe, expect, it } from "vitest";
import type { CheckResult, Finding, Run } from "../../shared/types.js";
import type { DecisionEvaluation } from "./types.js";
import { measurePayload } from "./redaction.js";
import { baseRealRun } from "../real-run.js";
import {
  DEFAULT_REVIEW_LOCALE,
  EXCERPT_CHARS,
  HUMAN_URGENCY_OPTIONS,
  QUESTION_SUFFIXES,
  RETRY_VALUE_LEVELS,
  SECURITY_IMPACT_OPTIONS,
  buildReviewTriageBatches,
  buildReviewTriageQuestions,
  buildReviewTriageRequest,
  buildReviewTriageState,
  diffChangeStats,
  findingQuestionId,
  findingStableKey,
  runReviewTriageBatches,
  sanitizeFindingFile,
  selectReviewFindings,
} from "./review-triage.js";
import type { DecisionEngine, DecisionRequest } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    severity: "high",
    file: "src/server/worker.ts",
    line: 10,
    title: "Missing authorization check",
    evidence: "The handler reads the run without verifying ownership.",
    requiredChange: "Verify owner before returning the run.",
    resolved: false,
    consecutiveRounds: 2,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const run = baseRealRun(
    {
      title: "Review triage fixture",
      task: "Fix the authorization check in the worker.",
      repository: "/Users/operator/private/proj",
      workspaceId: "ws_1",
      mode: "real",
      checks: ["npm test"],
    },
    "owner_1",
  );
  return { ...run, state: "needs_human", round: 2, ...overrides };
}

const checked = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  id: "check-1",
  name: "unit tests",
  command: "npm test",
  status: "passed",
  exitCode: 0,
  ...overrides,
});

const input = (run: Run, overrides: Partial<Parameters<typeof buildReviewTriageBatches>[0]> = {}) => ({
  run,
  mode: "shadow" as const,
  policyVersion: "review-triage-v1",
  maxFindings: 50,
  evaluationId: "de_review_1",
  timeoutMs: 3000,
  ...overrides,
});

describe("review-triage state projection", () => {
  it("builds the minimal state with checks, change stats and finding projections", () => {
    const run = makeRun({
      findings: [finding(), finding({ id: "F2", severity: "low", resolved: true })],
      checks: [checked(), checked({ id: "check-2", name: "lint", status: "failed" })],
      acceptanceCriteria: "AC1: ownership is enforced\nAC2: tests pass",
      diff: [
        "diff --git a/src/server/worker.ts b/src/server/worker.ts",
        "--- a/src/server/worker.ts",
        "+++ b/src/server/worker.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "+extra",
      ].join("\n"),
    });
    const state = buildReviewTriageState(run);
    expect(state.run.round).toBe(2);
    expect(state.run.locale).toBe(DEFAULT_REVIEW_LOCALE);
    expect(state.run.taskSummary).toContain("authorization");
    expect(state.run.acceptanceCriteria).toEqual(["AC1: ownership is enforced", "AC2: tests pass"]);
    expect(state.checks).toEqual({ allPassed: false, failedNames: ["lint"] });
    expect(state.change.files).toEqual(["src/server/worker.ts"]);
    expect(state.change.addedLines).toBe(2);
    expect(state.change.deletedLines).toBe(1);
    expect(state.change.diffComplete).toBe(true);
    // Only the unresolved finding is projected.
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({
      key: findingStableKey(finding()),
      severity: "high",
      file: "src/server/worker.ts",
      streak: 2,
    });
  });

  it("drops resolved findings and orders by severity then stable key", () => {
    const run = makeRun({
      findings: [
        finding({ id: "a", severity: "low", title: "z low" }),
        finding({ id: "b", severity: "critical", title: "critical" }),
        finding({ id: "c", severity: "high", title: "a high" }),
        finding({ id: "d", severity: "high", title: "b high" }),
      ],
    });
    expect(selectReviewFindings(run).map((f) => f.title)).toEqual(["critical", "a high", "b high", "z low"]);
  });

  it("caps every excerpt at 300 characters", () => {
    const run = makeRun({ findings: [finding({ evidence: "证".repeat(900), requiredChange: "改".repeat(900), title: "t".repeat(400) })] });
    const state = buildReviewTriageState(run);
    expect(state.findings[0].evidenceExcerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(state.findings[0].requiredChangeExcerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(state.findings[0].title.length).toBeLessThanOrEqual(200);
  });

  it("[AT-JEV-051] redacts secrets and PII in every free-text field", () => {
    const secret = "sk-DUMMYabcdefghijklmnopqrstuvwxyz0123";
    const run = makeRun({
      task: `use ${secret} for the deploy`,
      findings: [finding({ evidence: `key=${secret}`, requiredChange: "email admin@example.com" })],
    });
    const state = buildReviewTriageState(run);
    const json = JSON.stringify(state);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("admin@example.com");
    expect(json).toContain("[redacted]");
  });

  it("never emits an absolute host path", () => {
    expect(sanitizeFindingFile("/Users/operator/private/proj/src/server/worker.ts")).toBe("src/server/worker.ts");
    expect(sanitizeFindingFile("C:\\Users\\op\\proj\\src\\a.ts")).toBe("proj/src/a.ts");
    expect(sanitizeFindingFile("src/a.ts")).toBe("src/a.ts");
    expect(sanitizeFindingFile(null)).toBeNull();
    const run = makeRun({ findings: [finding({ file: "/Users/operator/private/proj/src/server/worker.ts" })] });
    expect(JSON.stringify(buildReviewTriageState(run))).not.toContain("/Users/operator");
  });

  it("[AT-JEV-027] flags an incomplete diff and never includes diff content", () => {
    const run = makeRun({ diff: "# [PiGO] inline diff truncated bytes=999999\ndiff --git a/a.ts b/a.ts\n+leaked source line" });
    const state = buildReviewTriageState(run);
    expect(state.change.diffComplete).toBe(false);
    expect(JSON.stringify(state)).not.toContain("leaked source line");
    expect(diffChangeStats("").diffComplete).toBe(false);
    expect(diffChangeStats("diff --git a/a.ts b/a.ts\n+x").diffComplete).toBe(true);
  });
});

describe("review-triage questions", () => {
  it("produces the four fixed questions per finding with stable program-generated ids", () => {
    const run = makeRun({ findings: [finding()] });
    const key = findingStableKey(finding());
    const questions = buildReviewTriageQuestions(run.findings);
    const ids = Object.keys(questions);
    expect(ids).toHaveLength(4);
    for (const suffix of QUESTION_SUFFIXES) expect(ids).toContain(findingQuestionId(key, suffix));
    expect(questions[findingQuestionId(key, "requirement_relevant")]).toMatchObject({ type: "probability" });
    expect(questions[findingQuestionId(key, "security_impact")]).toMatchObject({ type: "choice", options: [...SECURITY_IMPACT_OPTIONS] });
    expect(questions[findingQuestionId(key, "human_urgency")]).toMatchObject({ type: "choice", options: [...HUMAN_URGENCY_OPTIONS] });
    expect(questions[findingQuestionId(key, "retry_value")]).toMatchObject({ type: "score", levels: RETRY_VALUE_LEVELS.map((level) => ({ ...level })) });
  });

  it("is deterministic and independent of finding order", () => {
    const a = finding();
    const b = finding({ id: "F2", title: "Second issue", file: "src/b.ts" });
    expect(findingQuestionId(findingStableKey(a), "human_urgency")).toBe(findingQuestionId(findingStableKey(a), "human_urgency"));
    expect(Object.keys(buildReviewTriageQuestions([a, b])).sort()).toEqual(Object.keys(buildReviewTriageQuestions([b, a])).sort());
  });

  it("returns fresh, mutation-safe question clones", () => {
    const first = buildReviewTriageQuestions([finding()]);
    const second = buildReviewTriageQuestions([finding()]);
    const choiceId = findingQuestionId(findingStableKey(finding()), "security_impact");
    (first[choiceId] as { options: string[] }).options.push("injected");
    expect((second[choiceId] as { options: string[] }).options).toEqual([...SECURITY_IMPACT_OPTIONS]);
  });
});

describe("review-triage request", () => {
  it("builds a redacted DecisionRequest with a state hash over the projected state", () => {
    const run = makeRun({ findings: [finding()] });
    const request = buildReviewTriageRequest(input(run));
    expect(request).toMatchObject({
      evaluationId: "de_review_1",
      runId: run.id,
      kind: "review_triage",
      mode: "shadow",
      policyVersion: "review-triage-v1",
      timeoutMs: 3000,
    });
    expect(request.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(request.questions)).toHaveLength(4);
    expect(JSON.stringify(request)).not.toContain("/Users/operator");
  });

  it("returns a single batch when everything fits", () => {
    const run = makeRun({ findings: [finding(), finding({ id: "F2", title: "other" })] });
    const batches = buildReviewTriageBatches(input(run));
    expect(batches).toHaveLength(1);
    expect(batches[0].withinLimits).toBe(true);
    expect(buildReviewTriageRequest(input(run))).toEqual(batches[0].request);
  });

  it("falls back to the resolved findings when nothing is unresolved (shadow coverage)", () => {
    // Policy: unresolved findings are the primary target; an approved round whose
    // findings were all fixed still gets evaluated, so shadow calibration keeps
    // collecting samples instead of going silent. `resolved` is never projected.
    const run = makeRun({ findings: [finding({ resolved: true })] });
    const batches = buildReviewTriageBatches(input(run));
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0].request.questions)).toHaveLength(4);
    expect(JSON.stringify(batches[0].request.state)).not.toContain("resolved");
  });

  it("produces no batch when the run never had a finding (empty questions are invalid)", () => {
    // Live evidence (prod, v0.27.13): a run with no findings was dispatched with
    // `questions: {}` and TypeSafe answered `HTTP 422 loc=body.questions
    // msg=Dictionary should have at least 1 item after validation, not 0
    // type=too_short`. Nothing to ask ⇒ no request.
    expect(buildReviewTriageBatches(input(makeRun({ findings: [] })))).toEqual([]);
  });
});

describe("review-triage batching", () => {
  const manyFindings = (count: number): Finding[] =>
    Array.from({ length: count }, (_, index) =>
      finding({ id: `F${index}`, title: `finding ${index}`, file: `src/f${index}.ts`, consecutiveRounds: index % 3 }),
    );

  it("[AT-JEV-026] splits beyond maxFindings into ordered, disjoint, complete batches", () => {
    const run = makeRun({ findings: manyFindings(100) });
    const batches = buildReviewTriageBatches(input(run, { maxFindings: 50 }));
    expect(batches).toHaveLength(2);
    const keys = batches.flatMap((batch) => batch.findingKeys);
    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100);
    expect(keys).toEqual(selectReviewFindings(run).map(findingStableKey));
    expect(batches.map((batch) => batch.evaluationId)).toEqual(["de_review_1-b01", "de_review_1-b02"]);
    for (const batch of batches) {
      expect(batch.withinLimits).toBe(true);
      expect(Object.keys(batch.request.questions)).toHaveLength(batch.findingKeys.length * 4);
    }
  });

  it("keeps each batch inside the token and byte caps", () => {
    const run = makeRun({ findings: manyFindings(6) });
    const first = run.findings[0];
    const second = run.findings[1];
    const oneTokens = measurePayload(buildReviewTriageState(run, [first]), buildReviewTriageQuestions([first])).tokens;
    const twoTokens = measurePayload(buildReviewTriageState(run, [first, second]), buildReviewTriageQuestions([first, second])).tokens;
    expect(twoTokens).toBeGreaterThan(oneTokens);
    const maxTokens = Math.floor((oneTokens + twoTokens) / 2);

    const batches = buildReviewTriageBatches(input(run), { maxTokens, maxBytes: 1_000_000 });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.withinLimits).toBe(true);
      expect(batch.measurement.tokens).toBeLessThanOrEqual(maxTokens);
      expect(batch.measurement.bytes).toBeLessThanOrEqual(1_000_000);
    }
    expect(batches.flatMap((batch) => batch.findingKeys)).toHaveLength(6);
  });

  it("[AT-JEV-016] reports an over-limit batch instead of truncating the question set", () => {
    const run = makeRun({ findings: manyFindings(3) });
    const batches = buildReviewTriageBatches(input(run), { maxTokens: 1, maxBytes: 1_000_000 });
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.withinLimits).toBe(false);
      expect(batch.reason).toBe("payload_rejected");
      // The question definitions are intact even when the batch is unsendable.
      expect(Object.keys(batch.request.questions)).toHaveLength(batch.findingKeys.length * 4);
    }
  });
});

describe("runReviewTriageBatches — isolation", () => {
  const completed = (request: DecisionRequest): DecisionEvaluation => ({
    evaluationId: request.evaluationId,
    runId: request.runId,
    kind: request.kind,
    mode: request.mode,
    provider: "mock",
    requestedModel: "jev-latest",
    policyVersion: request.policyVersion,
    stateHash: request.stateHash,
    status: "completed",
    answers: Object.keys(request.questions).map((questionId) => ({
      questionId,
      type: "probability" as const,
      value: true,
      probability: 0.9,
      certainty: 0.8,
    })),
    latencyMs: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
  });

  const fallback = (request: DecisionRequest): DecisionEvaluation => ({
    ...completed(request),
    status: "fallback",
    answers: [],
    fallbackReason: "timeout",
  });

  it("[AT-JEV-026] lets a failing batch fail without affecting the others", async () => {
    const run = makeRun({ findings: Array.from({ length: 3 }, (_, index) => finding({ id: `F${index}`, title: `finding ${index}` })) });
    const batches = buildReviewTriageBatches(input(run, { maxFindings: 1 }));
    expect(batches).toHaveLength(3);

    const engine: DecisionEngine = {
      evaluate: async (request: DecisionRequest) => {
        if (request.evaluationId.endsWith("b02")) throw new Error("engine exploded");
        if (request.evaluationId.endsWith("b03")) return fallback(request);
        return completed(request);
      },
    };
    const result = await runReviewTriageBatches({ batches, engine });
    expect(result.outcomes.map((outcome) => outcome.evaluationId)).toEqual(["de_review_1-b01", "de_review_1-b03"]);
    expect(result.answers).toHaveLength(4);
    expect(result.failures.map((failure) => failure.evaluationId)).toEqual(["de_review_1-b02", "de_review_1-b03"]);
    expect(result.failures.map((failure) => failure.reason)).toEqual(["unknown", "timeout"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips over-limit batches without calling the engine", async () => {
    const run = makeRun({ findings: [finding()] });
    const batches = buildReviewTriageBatches(input(run), { maxTokens: 1, maxBytes: 1_000_000 });
    let calls = 0;
    const engine: DecisionEngine = {
      evaluate: async (request) => {
        calls += 1;
        return completed(request);
      },
    };
    const result = await runReviewTriageBatches({ batches, engine });
    expect(calls).toBe(0);
    expect(result.answers).toEqual([]);
    expect(result.skipped).toEqual(batches.map((batch) => batch.evaluationId));
    expect(result.failures.every((failure) => failure.reason === "payload_rejected")).toBe(true);
  });
});
