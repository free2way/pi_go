/**
 * Drift guard for the shared decision-audit mirror (docs/26 §8.2).
 *
 * The client must read exactly the redacted projection the server emits. This
 * suite pins the two sides together three ways:
 *
 *  1. compile-time bidirectional assignability (`Shared ⇒ Server` and
 *     `Server ⇒ Shared`), which fails on any added/removed/optionality/enum
 *     difference within the mirrored shape;
 *  2. a runtime key-set comparison of a REAL `projectDecision(record)` output
 *     against the frozen contract key list — so the projection function and the
 *     shared interface cannot drift apart;
 *  3. a runtime key-set comparison of a fully-populated shared sample against
 *     the same list — so the shared interface cannot silently drop a field.
 *
 * It deliberately imports BOTH sides: the test is the only place they meet.
 */

import { describe, expect, it } from "vitest";
import {
  DECISION_AUDIT_FALLBACK_REASONS,
  type DecisionAuditAnswer,
  type DecisionAuditProjection,
} from "./decision-audit";
import { projectDecision } from "../server/decision-routes.js";
import {
  FALLBACK_REASONS,
  type DecisionAnswer,
  type DecisionEvaluationRecord,
} from "../server/decision-engine/types.js";
import type { DecisionProjection } from "../server/decision-routes.js";

/** The frozen contract: every key the projection may ever carry. */
const FROZEN_KEYS = [
  "answers",
  "appliedOutcome",
  "createdAt",
  "detail",
  "estimatedCostUsd",
  "evaluationId",
  "fallbackReason",
  "inputTokens",
  "kind",
  "latencyMs",
  "mode",
  "outputTokens",
  "policyVersion",
  "provider",
  "questionSchemaHash",
  "requestedModel",
  "resolvedModel",
  "runId",
  "stateHash",
  "stateManifest",
  "status",
].sort();

describe("decision-audit type drift (shared mirror vs server)", () => {
  it("is bidirectionally assignable at the projection level", () => {
    // A field added/removed/made-optional or an enum member changed on EITHER
    // side makes one of these fail to compile.
    const serverAsShared: DecisionAuditProjection = {} as DecisionProjection;
    const sharedAsServer: DecisionProjection = {} as DecisionAuditProjection;
    void serverAsShared;
    void sharedAsServer;
  });

  it("is bidirectionally assignable at the answer level", () => {
    const serverAsShared: DecisionAuditAnswer[] = [] as DecisionAnswer[];
    const sharedAsServer: DecisionAnswer[] = [] as DecisionAuditAnswer[];
    void serverAsShared;
    void sharedAsServer;
  });

  it("keeps the fallback-reason union identical to the server constant", () => {
    // The union is derived from the shared const, so comparing the two arrays
    // pins the member set and its order in one runtime assertion.
    expect([...DECISION_AUDIT_FALLBACK_REASONS]).toEqual([...FALLBACK_REASONS]);
  });

  it("emits exactly the frozen key set for a fully-populated projection", () => {
    // A record with EVERY optional field present, so the key set is the full
    // contract rather than the sparse fallback path.
    const record: DecisionEvaluationRecord = {
      evaluationId: "de_0123456789abcdef0123456789abcdef",
      runId: "run_drift",
      kind: "review_triage",
      mode: "shadow",
      provider: "typesafe",
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      policyVersion: "policy-v1",
      stateHash: "a".repeat(64),
      questionSchemaHash: "b".repeat(64),
      status: "completed",
      answers: [
        { questionId: "q1", type: "probability", value: true, probability: 0.87, certainty: 0.74 },
        { questionId: "q2", type: "choice", value: "continue", probabilities: { continue: 0.8 }, confidence: 0.8 },
        { questionId: "q3", type: "score", value: "medium", probabilities: { low: 0.2, medium: 0.6 }, weightedScore: 0.6, confidence: 0.7 },
      ],
      appliedOutcome: "none",
      fallbackReason: "timeout",
      detail: "provider timed out",
      latencyMs: 1234,
      inputTokens: 900,
      outputTokens: 120,
      estimatedCostUsd: 0.0042,
      createdAt: "2026-01-01T00:00:00.000Z",
      stateManifest: {
        fields: ["findings", "findings[0].title"],
        counts: { "findings[0]": 1 },
        fieldsTruncated: false,
        stateBytes: 512,
        stateChars: 512,
        stateTokens: 128,
        questionCount: 3,
        questionIds: ["q1", "q2", "q3"],
        questions: [],
      },
      idempotencyKey: "run_drift:review_triage:policy-v1:aaaa",
    };

    const projected = projectDecision(record);
    expect(Object.keys(projected).sort()).toEqual(FROZEN_KEYS);

    // The same frozen set must be expressible through the shared interface: a
    // fully-populated shared sample carries exactly these keys, so the shared
    // type cannot silently narrow the contract.
    const sharedSample: DecisionAuditProjection = {
      evaluationId: record.evaluationId,
      runId: record.runId,
      kind: record.kind,
      mode: record.mode,
      provider: record.provider,
      requestedModel: record.requestedModel,
      resolvedModel: record.resolvedModel,
      policyVersion: record.policyVersion,
      stateHash: record.stateHash,
      questionSchemaHash: record.questionSchemaHash,
      status: record.status,
      answers: record.answers,
      appliedOutcome: record.appliedOutcome,
      fallbackReason: record.fallbackReason,
      detail: record.detail,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      estimatedCostUsd: record.estimatedCostUsd,
      createdAt: record.createdAt,
      stateManifest: record.stateManifest,
    };
    expect(Object.keys(sharedSample).sort()).toEqual(FROZEN_KEYS);

    // The two sides agree on the key set (transitively guaranteed by the shared
    // literal, asserted directly here for an explicit drift failure message).
    expect(Object.keys(projected).sort()).toEqual(Object.keys(sharedSample).sort());
  });

  it("omits (never zero-fills) an unavailable cost in the real projection", () => {
    const base: DecisionEvaluationRecord = {
      evaluationId: "de_x",
      runId: "run_x",
      kind: "review_triage",
      mode: "shadow",
      provider: "typesafe",
      requestedModel: "jev-latest",
      policyVersion: "policy-v1",
      stateHash: "c".repeat(64),
      questionSchemaHash: "d".repeat(64),
      status: "completed",
      answers: [],
      latencyMs: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      stateManifest: {},
      idempotencyKey: "k",
    };
    expect(projectDecision(base)).not.toHaveProperty("estimatedCostUsd");
  });
});
