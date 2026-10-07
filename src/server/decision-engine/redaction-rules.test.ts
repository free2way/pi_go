/**
 * 脱敏规则用例（原 `redaction.test.ts` 迁入）。
 *
 * 来由：原文件里曾有一把**真实形状的 Google API key** 作为夹具，随仓库公开过（2026-10-06~07，
 * 详见 docs/27 §8.05）。处理后该文件在远端被删除，用例整体迁到这里；夹具一律使用**显式占位**
 * （`DUMMY` / `EXAMPLE` / `not-a-real`…）——形状合规以便真正驱动规则，内容明显是假值，
 * `npm run scan:secrets` 会放行（它只认这些假标记）。
 */
import { describe, expect, it } from "vitest";
import type { DecisionQuestion } from "./types.js";
import {
  REDACTED,
  canonicalJson,
  checkPayloadLimits,
  estimateTokens,
  matchedRedactionRules,
  measurePayload,
  redactDeep,
  redactExcerpt,
  redactText,
  sha256Hex,
  shannonEntropy,
  stateHash,
  stateManifest,
  questionSchemaHash,
} from "./redaction.js";

describe("redactText — secrets", () => {
  it.each([
    ["aws key", "AKIAIOSFODNN7DUMMY01", "aws_access_key"],
    ["github token", `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`, "github_token"],
    ["openai key", "sk-DUMMYabcdefghijklmnopqrstuvwxyz0123", "openai_key"],
    ["slack token", "xoxb-1234567890-abcdefghijkl", "slack_token"],
    ["google key", "AIzaSyDUMMY-not-a-real-key0000000000000", "google_api_key"],
  ])("[AT-JEV-051] redacts a %s", (_name, secret, rule) => {
    const text = `credential found: ${secret} end`;
    const redacted = redactText(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(REDACTED);
    expect(matchedRedactionRules(text)).toContain(rule);
  });

  it("[AT-JEV-051] redacts JWT and Authorization headers", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy";
    const text = `token=${jwt}\nAuthorization: Bearer DUMMY-token-abc123def456`;
    const redacted = redactText(text);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("DUMMY-token-abc123def456");
    expect(redacted).toContain("Authorization: [redacted]");
  });

  it("redacts cookies", () => {
    const redacted = redactText("Cookie: session=abcdef0123456789; theme=dark");
    expect(redacted).not.toContain("abcdef0123456789");
    expect(redacted).toContain("Cookie: [redacted]");
  });

  it("redacts private key blocks", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "DUMMY-MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n");
    const redacted = redactText(`key:\n${pem}`);
    expect(redacted).not.toContain("DUMMY-MIIEowIBAAKCAQEA");
    expect(redacted).toContain(REDACTED);
  });

  it("[AT-JEV-051] redacts URLs with embedded credentials", () => {
    const redacted = redactText("postgres://admin:hunter2@db.internal:5432/pigo");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain(`postgres://${REDACTED}@db.internal:5432/pigo`.replace("[redacted]@", "[redacted]@"));
  });

  it("redacts emails (PII)", () => {
    const redacted = redactText("contact jane.doe@example.com for details");
    expect(redacted).not.toContain("jane.doe@example.com");
    expect(redacted).toContain(REDACTED);
  });

  it("redacts high-entropy strings", () => {
    const secret = "Q2hhbmdlVGhpc1RvU29tZXRoaW5nRWxzZTEyMzQ1Ng";
    expect(shannonEntropy(secret)).toBeGreaterThan(3.5);
    const redacted = redactText(`the value ${secret} leaked`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(REDACTED);
  });

  it("leaves ordinary prose, paths and identifiers intact", () => {
    const text = "src/server/decision-engine/index.ts StateMaxTokensConfiguration get_user_by_id_from_database";
    expect(redactText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactText("Authorization: Bearer abc123def456ghi789");
    expect(redactText(once)).toBe(once);
  });

  it("does not mangle adjacent payload text when the match length varies", () => {
    const text = JSON.stringify({ findings: [{ key: "f_1", title: "no secrets here" }] });
    expect(redactText(text)).toBe(text);
  });
});

describe("redactDeep", () => {
  it("redacts nested strings and preserves shape", () => {
    const input = {
      run: { taskSummary: "use key sk-DUMMYabcdefghijklmnopqrstuvwxyz0123" },
      findings: [{ title: "ok", evidence: "mail admin@example.com" }],
      counts: [1, 2, 3],
    };
    const output = redactDeep(input);
    expect(output.run.taskSummary).not.toContain("sk-DUMMYabcdefghijklmnopqrstuvwxyz0123");
    expect(output.findings[0].evidence).not.toContain("admin@example.com");
    expect(output.counts).toEqual([1, 2, 3]);
    expect(Object.keys(output.findings[0])).toEqual(["title", "evidence"]);
  });

  it("tolerates a cycle without hanging", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(() => redactDeep(node)).not.toThrow();
  });
});

describe("canonicalJson + hashes", () => {
  it("[AT-JEV-015] is insensitive to object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } })).toBe(canonicalJson({ a: { c: [3, 4], d: 2 }, b: 1 }));
  });

  it("[AT-JEV-015] produces the same stateHash for semantically identical states", () => {
    expect(stateHash({ a: 1, b: [2, 3] })).toBe(stateHash({ b: [2, 3], a: 1 }));
  });

  it("[AT-JEV-015] changes the stateHash when content changes", () => {
    expect(stateHash({ a: 1 })).not.toBe(stateHash({ a: 2 }));
  });

  it("[AT-JEV-051] hashes the redacted form, so two states differing only by a secret collide", () => {
    const withSecret = stateHash({ note: "key sk-DUMMYabcdefghijklmnopqrstuvwxyz0123" });
    const redacted = stateHash({ note: "key [redacted]" });
    expect(withSecret).toBe(redacted);
  });

  it("normalizes non-finite numbers to null", () => {
    expect(canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe('{"a":null,"b":null}');
  });

  it("[AT-JEV-015] questionSchemaHash changes when options or levels change", () => {
    const base: Record<string, DecisionQuestion> = {
      q1: { type: "choice", prompt: "pick", options: ["a", "b"] },
      q2: { type: "score", prompt: "rate", levels: [{ value: "low", description: "l" }, { value: "high", description: "h" }] },
    };
    const changedOptions = { ...base, q1: { type: "choice" as const, prompt: "pick", options: ["a", "c"] } };
    expect(questionSchemaHash(base)).toBe(questionSchemaHash(base));
    expect(questionSchemaHash(base)).not.toBe(questionSchemaHash(changedOptions));
    expect(questionSchemaHash(base)).toHaveLength(64);
  });

  it("sha256Hex matches the known digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("estimateTokens / measurePayload", () => {
  it("is conservative (never below bytes/4)", () => {
    const text = "hello world";
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(text, "utf8") / 4));
  });

  it("uses state + longest question, not the sum of all questions", () => {
    const questions: Record<string, DecisionQuestion> = {
      a: { type: "probability", prompt: "short" },
      b: { type: "probability", prompt: "x".repeat(300) },
    };
    const measurement = measurePayload({ run: { round: 1 } }, questions);
    expect(measurement.longestQuestionTokens).toBeGreaterThan(measurement.stateTokens);
    expect(measurement.tokens).toBe(measurement.stateTokens + measurement.longestQuestionTokens);
    expect(measurement.bytes).toBeGreaterThan(0);
  });

  it("[AT-JEV-016] rejects over-limit payloads with payload_rejected (no truncation)", () => {
    const state = { blob: "y".repeat(4000) };
    const questions: Record<string, DecisionQuestion> = { q: { type: "probability", prompt: "p" } };
    const tooFewTokens = checkPayloadLimits(state, questions, { maxTokens: 10, maxBytes: 1_000_000 });
    expect(tooFewTokens.ok).toBe(false);
    if (tooFewTokens.ok) return;
    expect(tooFewTokens.reason).toBe("payload_rejected");
    expect(tooFewTokens.detail).toContain("tokens");
    expect(tooFewTokens.detail).not.toContain("y".repeat(50));

    const tooFewBytes = checkPayloadLimits(state, questions, { maxTokens: 1_000_000, maxBytes: 16 });
    expect(tooFewBytes.ok).toBe(false);
    if (tooFewBytes.ok) return;
    expect(tooFewBytes.detail).toContain("bytes");

    const ok = checkPayloadLimits(state, questions, { maxTokens: 10_000, maxBytes: 100_000 });
    expect(ok.ok).toBe(true);
  });
});

describe("stateManifest", () => {
  it("records field names, counts and sizes but never values", () => {
    const state = {
      run: { round: 2, taskSummary: "top secret task" },
      findings: [{ key: "f_1" }, { key: "f_2" }],
    };
    const manifest = stateManifest(state, { f_1_requirement_relevant: { type: "probability", prompt: "p" } });
    const json = JSON.stringify(manifest);
    expect(json).not.toContain("top secret task");
    expect(json).not.toContain("f_1\"");
    expect(manifest.fields).toContain("run.round");
    expect(manifest.counts).toMatchObject({ "findings": 2 });
    expect(manifest.stateBytes).toBeGreaterThan(0);
    expect(manifest.stateTokens).toBeGreaterThan(0);
    expect(manifest.questionCount).toBe(1);
    expect(manifest.questionIds).toEqual(["f_1_requirement_relevant"]);
  });

  it("records question option/level counts instead of contents", () => {
    const manifest = stateManifest({}, {
      c: { type: "choice", prompt: "p", options: ["a", "b", "c"] },
      s: { type: "score", prompt: "p", levels: [{ value: "l", description: "d" }, { value: "h", description: "d" }] },
    });
    const questions = manifest.questions as Array<Record<string, unknown>>;
    expect(questions.find((q) => q.id === "c")?.optionCount).toBe(3);
    expect(questions.find((q) => q.id === "s")?.levelCount).toBe(2);
  });
});

describe("redactExcerpt", () => {
  it("caps at 300 chars after redaction", () => {
    const excerpt = redactExcerpt(`prefix sk-DUMMYabcdefghijklmnopqrstuvwxyz0123 ${"z".repeat(500)}`);
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).not.toContain("sk-DUMMYabcdefghijklmnopqrstuvwxyz0123");
  });

  it("trims and tolerates null", () => {
    expect(redactExcerpt(null)).toBe("");
    expect(redactExcerpt("  padded  ")).toBe("padded");
  });
});
