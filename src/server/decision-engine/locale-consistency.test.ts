import { describe, expect, it } from "vitest";
import type { Finding, Run } from "../../shared/types.js";
import { baseRealRun } from "../real-run.js";
import { APPLIED_NONE, resolveAppliedOutcome } from "./policy.js";
import { checkPayloadLimits, estimateTokens, measurePayload, questionSchemaHash, truncateChars } from "./redaction.js";
import {
  buildReviewTriageBatches,
  buildReviewTriageState,
  EXCERPT_CHARS,
  TITLE_MAX_CHARS,
  selectReviewFindings,
} from "./review-triage.js";
import { mapProviderResponse } from "./response-schema.js";
import type { DecisionQuestion, DecisionRequest } from "./types.js";

/**
 * AT-JEV-025 · 中英文一致性（docs/27 §7.7）。
 *
 * 这里覆盖**本地可测的那一半**：“合同均有效；不存在因编码导致的字段丢失或请求失败”。
 * 即中英（及多脚本混排）内容走完整条决策链路时字节级不丢失、截断不产生非法码元、
 * 同一语义的中英两个载荷都能通过合同与上限校验，且问题 schema 与语言无关。
 *
 * 诚实边界：用例**不做**“中英文语义差异”的判定——那需要供应商侧真 key 评估（AT-JEV-071），
 * 本文件只保证我方（投影/脱敏/上限/合同映射）不为语言引入任何不对称。
 */

const ZH_TASK = "上传接口需要拒绝超大请求体，并补上覆盖拒绝分支的测试。";
const ZH_AC = "- 超大上传返回 413\n- 存在覆盖拒绝分支的测试";
const EN_TASK = "The upload endpoint must reject oversized bodies and cover the rejection with a test.";
const EN_AC = "- Oversized uploads return 413\n- A test covers the rejection path";

/** Astral-plane and combining content that a UTF-16 slice can corrupt. */
const EMOJI = "\u{1F680}";
const FLAG = "\u{1F1E8}\u{1F1F3}";
const ACCENTS = "cafe\u0301 — naïve";
const RTL = "رفض الطلب الكبير جدًا";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    fingerprint: "fp-locale-1",
    severity: "high",
    file: "/home/operator/private/proj/src/server/upload.ts",
    line: 42,
    title: "Upload handler accepts unbounded body size",
    evidence: EMOJI,
    requiredChange: "Reject bodies larger than the configured limit.",
    resolved: false,
    consecutiveRounds: 2,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const base = baseRealRun(
    {
      title: "Locale fixture",
      task: ZH_TASK,
      acceptanceCriteria: ZH_AC,
      repository: "/home/operator/private/proj",
      workspaceId: "ws_locale",
      mode: "real",
      checks: ["npm test"],
    },
    "owner_locale",
  );
  return { ...base, state: "needs_human", round: 2, findings: [finding()], ...overrides };
}

function requestFor(run: Run = makeRun()): DecisionRequest {
  const batches = buildReviewTriageBatches({
    run,
    mode: "shadow",
    policyVersion: "review-triage-v1",
    maxFindings: 50,
    evaluationId: "de_locale_025",
    timeoutMs: 3000,
  });
  expect(batches).toHaveLength(1);
  return batches[0].request;
}

function validAnswers(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === "probability") return [id, { type: "noul", noul: 0.9 }];
      if (question.type === "choice") {
        const rest = Number((0.2 / (question.options.length - 1)).toFixed(4));
        return [
          id,
          {
            type: "choice",
            choice: question.options[0],
            probabilities: Object.fromEntries(question.options.map((option, index) => [option, index === 0 ? 0.8 : rest])),
            confidence: 0.9,
          },
        ];
      }
      const rest = Number((0.3 / (question.levels.length - 1)).toFixed(4));
      return [
        id,
        {
          type: "score",
          weighted_score: 1,
          probabilities: Object.fromEntries(question.levels.map((level, index) => [level.value, index === 1 ? 0.7 : rest])),
          confidence: 0.9,
        },
      ];
    }),
  );
}

/** True when the text contains an unpaired surrogate (not round-trippable UTF-8). */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Paths of every string (at any depth) that carries an unpaired surrogate. */
function loneSurrogatePaths(value: unknown, path = "$", acc: string[] = []): string[] {
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) acc.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => loneSurrogatePaths(item, `${path}[${index}]`, acc));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      loneSurrogatePaths(nested, `${path}.${key}`, acc);
    }
  }
  return acc;
}

function roundTrips(text: string): boolean {
  return Buffer.from(text, "utf8").toString("utf8") === text;
}

describe("AT-JEV-025 · 多脚本内容不因编码丢失", () => {
  it("中文任务/验收标准走完整条链路：投影保留文本、合同有效、shadow 不施加结果", () => {
    const run = makeRun();
    const request = requestFor(run);
    const state = buildReviewTriageState(run, selectReviewFindings(run));

    expect(state.run.taskSummary).toContain("上传接口需要拒绝超大请求体");
    expect(state.run.acceptanceCriteria.join("\n")).toContain("超大上传返回 413");
    expect(loneSurrogatePaths(state)).toEqual([]);

    const mapped = mapProviderResponse({ model: "jev-1.13.0", answers: validAnswers(request.questions) }, request);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.answers).toHaveLength(4);
      const outcome = resolveAppliedOutcome({
        mode: "shadow",
        kind: "review_triage",
        status: "completed",
        answers: mapped.answers,
      });
      expect(outcome.appliedOutcome).toBe(APPLIED_NONE);
    }
  });

  it("astral 字符（emoji/国旗）经过脱敏、截断与序列化后仍完整", () => {
    const run = makeRun({
      findings: [
        finding({
          title: `部署日志 ${EMOJI} 与国旗 ${FLAG} 混排`,
          evidence: `${ACCENTS} ${EMOJI}`,
          requiredChange: RTL,
        }),
      ],
    });
    const state = buildReviewTriageState(run, selectReviewFindings(run));
    const projection = state.findings[0];

    expect(projection.title).toContain(EMOJI);
    expect(projection.title).toContain(FLAG);
    expect(projection.evidenceExcerpt).toContain(EMOJI);
    expect(projection.requiredChangeExcerpt).toContain(RTL.slice(0, 10));
    for (const field of [projection.title, projection.evidenceExcerpt, projection.requiredChangeExcerpt]) {
      expect(hasLoneSurrogate(field)).toBe(false);
      expect(roundTrips(field)).toBe(true);
    }
  });

  it("截断落在代理对中间时不产生孤立码元（回归：199 字符 + emoji）", () => {
    // 这是修复前的真实缺陷：`slice(0, maxChars)` 会切断代理对，留下孤立高代理。
    const boundary = `${"x".repeat(TITLE_MAX_CHARS - 1)}${EMOJI}`;
    const cut = truncateChars(boundary, TITLE_MAX_CHARS);
    expect(cut).toBe("x".repeat(TITLE_MAX_CHARS - 1));
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(roundTrips(cut)).toBe(true);
    // 同一缺陷也存在于证据/整改要求的 excerpt 边界上。
    const evidenceBoundary = `${"y".repeat(EXCERPT_CHARS - 1)}${EMOJI}`;
    expect(hasLoneSurrogate(truncateChars(evidenceBoundary, EXCERPT_CHARS))).toBe(false);

    const run = makeRun({ findings: [finding({ title: boundary })] });
    const state = buildReviewTriageState(run, selectReviewFindings(run));
    expect(state.findings[0].title).toBe("x".repeat(TITLE_MAX_CHARS - 1));
    expect(loneSurrogatePaths(state)).toEqual([]);

    // Complete pairs are never trimmed: a boundary landing after a full emoji is kept.
    const complete = `${"z".repeat(TITLE_MAX_CHARS - 2)}${EMOJI}`;
    expect(truncateChars(complete, TITLE_MAX_CHARS)).toBe(complete);
    // Degenerate bounds stay safe.
    expect(truncateChars("abc", 0)).toBe("");
    expect(truncateChars("abc", -5)).toBe("");
    expect(truncateChars("", 10)).toBe("");
  });

  it("CJK 的 token 估计不低估、且越界时 fail-closed（拒绝而非截断）", () => {
    const cjk = "拒绝超大请求体并覆盖拒绝分支".repeat(20);
    const chars = [...cjk].length;
    // ceil(bytes/3)：中文字符 3 字节，估计值不低于字符数（保守方向）。
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(chars);
    // 与既有不变量一致：永不低于 bytes/4。
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(cjk, "utf8") / 4));

    const question: Record<string, DecisionQuestion> = { q: { type: "probability", prompt: "相关吗？" } };
    const oversized = { run: { taskSummary: cjk.repeat(20) } };
    const measurement = measurePayload(oversized, question);
    expect(measurement.stateTokens).toBeGreaterThan(0);
    expect(measurement.bytes).toBeGreaterThan(measurement.stateTokens); // 3 字节/字符 → 字节数远大于估计 token

    const byTokens = checkPayloadLimits(oversized, question, { maxTokens: 10, maxBytes: 10_000_000 });
    expect(byTokens.ok).toBe(false);
    if (!byTokens.ok) {
      expect(byTokens.reason).toBe("payload_rejected");
      expect(byTokens.detail).toContain("tokens");
      expect(byTokens.detail).not.toContain("拒绝超大");
    }
    const byBytes = checkPayloadLimits(oversized, question, { maxTokens: 10_000_000, maxBytes: 64 });
    expect(byBytes.ok).toBe(false);
    if (!byBytes.ok) expect(byBytes.detail).toContain("bytes");

    // 真实预算下中文载荷仍然通过：默认 24k token / 256KB 对本级别的状态留有余量。
    const realistic = checkPayloadLimits(oversized, question, { maxTokens: 24_000, maxBytes: 262_144 });
    expect(realistic.ok).toBe(true);
  });

  it("同一语义的中英两版各自合同有效，且问题 schema 与语言无关", () => {
    const zhRun = makeRun({ task: ZH_TASK, acceptanceCriteria: ZH_AC });
    const enRun = makeRun({ task: EN_TASK, acceptanceCriteria: EN_AC });
    const zh = requestFor(zhRun);
    const en = requestFor(enRun);

    expect(Object.keys(zh.questions)).toEqual(Object.keys(en.questions));
    expect(questionSchemaHash(zh.questions)).toBe(questionSchemaHash(en.questions));
    expect(zh.stateHash).not.toBe(en.stateHash);

    for (const request of [zh, en]) {
      const mapped = mapProviderResponse({ model: "jev-1.13.0", answers: validAnswers(request.questions) }, request);
      expect(mapped.ok).toBe(true);
      if (mapped.ok) expect(mapped.answers.map((answer) => answer.questionId)).toEqual(Object.keys(request.questions));
    }
    // 语言差异只体现在数据上：中英版本的差异不产生新的字段或问题。
    const zhState = buildReviewTriageState(zhRun, selectReviewFindings(zhRun));
    const enState = buildReviewTriageState(enRun, selectReviewFindings(enRun));
    expect(Object.keys(zhState).sort()).toEqual(Object.keys(enState).sort());
    expect(Object.keys(zhState.run).sort()).toEqual(Object.keys(enState.run).sort());
    expect(zhState.run.taskSummary).not.toBe(enState.run.taskSummary);
  });
});
