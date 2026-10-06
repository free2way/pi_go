import { describe, expect, it } from "vitest";
import {
  acRelevance,
  buildDecisionBrief,
  diffFilePaths,
  evidenceSanity,
  gateAcceptance,
  gateBlocking,
  gateChecks,
  gateScope,
  matchCriterion,
  normalizeBriefText,
  recommendDecision,
  stopReasonFrom,
  type DecisionBriefGate,
  type DecisionBriefRemainingItem,
} from "./decision-brief.js";

const ac = (label: string, text: string) => ({ label, text });

/**
 * A change set freshly proven complete. The audit follow-up means the brief may
 * only clear a finding as "outside the change set" when the caller has this
 * proof; tests that exercise the clearing path must pass it explicitly.
 */
const completeDiff = { complete: true as const, reason: "complete" as const };

describe("decision brief · text normalization", () => {
  it("normalizes case, whitespace and Chinese/English punctuation", () => {
    expect(normalizeBriefText("  凭据  隔离：API  Key（必填）")).toBe("凭据 隔离:api key(必填)");
  });
});

describe("decision brief · diff file list", () => {
  it("extracts changed files from a unified diff and drops /dev/null", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "diff --git a/src/old.ts b/src/new.ts",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "diff --git a/removed.ts b/removed.ts",
      "deleted file mode 100644",
      "--- a/removed.ts",
      "+++ /dev/null",
    ].join("\n");
    expect(diffFilePaths(diff)).toEqual(["removed.ts", "src/a.ts", "src/new.ts", "src/old.ts"]);
  });

  it("returns an empty list for missing or empty input", () => {
    expect(diffFilePaths(undefined)).toEqual([]);
    expect(diffFilePaths("")).toEqual([]);
  });
});

describe("decision brief · checks gate", () => {
  it("is green only when every check passed", () => {
    expect(gateChecks([{ name: "单元测试", command: "npm test", status: "passed" }]).status).toBe("green");
  });

  it("is red when any check failed and names the command", () => {
    const gate = gateChecks([
      { name: "单元测试", command: "npm test", status: "failed", exitCode: 1 },
      { name: "Lint", command: "npm run lint", status: "passed" },
    ]);
    expect(gate.status).toBe("red");
    expect(gate.detail).toContain("npm test");
    expect(gate.detail).toContain("exit 1");
  });

  it("is unknown when a check is still running or nothing was recorded", () => {
    expect(gateChecks([{ name: "单元测试", status: "running" }]).status).toBe("unknown");
    expect(gateChecks([]).status).toBe("unknown");
    expect(gateChecks(null).status).toBe("unknown");
  });
});

describe("decision brief · AC relevance matcher (fail-safe)", () => {
  const criteria = [ac("AC#1", "凭据隔离：API Key 不得写入日志")];
  const changedFiles = ["src/server/credential-vault.ts"];

  it("matches on a shared file path", () => {
    expect(acRelevance({ file: "src/server/credential-vault.ts", title: "凭据隔离缺失" }, criteria)).toBe("relevant");
  });

  it("matches on shared keywords", () => {
    expect(acRelevance({ file: null, title: "API Key 写入日志", evidence: "日志中出现 key" }, criteria)).toBe("relevant");
  });

  it("is irrelevant only with explicit out-of-scope proof (file outside a known, complete change set, zero shared tokens)", () => {
    expect(
      acRelevance(
        { file: "src/client/App.tsx", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于标准" },
        criteria,
        { diffFiles: changedFiles, diffComplete: true },
      ),
    ).toBe("irrelevant");
  });

  it("fails safe to 'unknown' for the same finding when the change set is unknown or empty", () => {
    const finding = { file: "src/client/App.tsx", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于标准" };
    expect(acRelevance(finding, criteria)).toBe("unknown");
    expect(acRelevance(finding, criteria, {})).toBe("unknown");
    expect(acRelevance(finding, criteria, { diffFiles: [] })).toBe("unknown");
    expect(acRelevance(finding, criteria, { diffFiles: null })).toBe("unknown");
  });

  it("never clears when the change set exists but is not provably complete (audit follow-up: truncated diff)", () => {
    const finding = { file: "src/client/App.tsx", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于标准" };
    // Omitted / false completeness ⇒ the changed-file list may have been
    // truncated, so the file could in fact be part of the change set.
    expect(acRelevance(finding, criteria, { diffFiles: changedFiles })).toBe("unknown");
    expect(acRelevance(finding, criteria, { diffFiles: changedFiles, diffComplete: false })).toBe("unknown");
    expect(acRelevance(finding, criteria, { diffFiles: changedFiles, diffComplete: null })).toBe("unknown");
  });

  it("keeps a high-severity defect in scope when its file is part of the change, even with no shared keywords", () => {
    const finding = { file: "src/server/credential-vault.ts", title: "事务提交顺序颠倒", evidence: "并发写入时可能覆盖前一次提交" };
    expect(acRelevance(finding, criteria, { diffFiles: changedFiles, diffComplete: true })).toBe("unknown");
  });

  it("never clears a finding with no concrete file, or one that shares even a single token", () => {
    expect(
      acRelevance({ file: null, title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于标准" }, criteria, { diffFiles: changedFiles, diffComplete: true }),
    ).toBe("unknown");
    expect(
      acRelevance({ file: "src/client/App.tsx", title: "日志轮转策略不合理", evidence: "轮转阈值过高" }, criteria, { diffFiles: changedFiles, diffComplete: true }),
    ).toBe("unknown");
  });

  it("never claims relevance on a single ambiguous token", () => {
    expect(acRelevance({ file: "src/server/run-patch.ts", title: "补丁生成失败" }, [ac("AC#1", "导出补丁功能必须可用")])).toBe("unknown");
  });

  it("is unknown when the criteria or the finding carry no usable material", () => {
    expect(acRelevance({ file: "src/a.ts", title: "问题" }, [])).toBe("unknown");
    expect(acRelevance({ file: null, title: "" }, criteria)).toBe("unknown");
  });

  it("matchCriterion returns the label of the matched item only", () => {
    const matched = matchCriterion({ file: "src/server/credential-vault.ts", title: "凭据隔离缺失" }, criteria);
    expect(matched?.label).toBe("AC#1");
    expect(matchCriterion({ file: "src/client/App.tsx", title: "按钮对比度不足" }, criteria)).toBeUndefined();
  });
});

describe("decision brief · evidence sanity / false positives", () => {
  it("flags vague, empty or non-positive-line evidence", () => {
    expect(evidenceSanity({ file: "src/a.ts", line: 10, evidence: "该分支在异常时没有回滚事务，会留下脏数据" })).toBe(true);
    expect(evidenceSanity({ file: "src/a.ts", evidence: "无" })).toBe(false);
    expect(evidenceSanity({ file: "src/a.ts", evidence: "n/a" })).toBe(false);
    expect(evidenceSanity({ file: "src/a.ts", evidence: "太短" })).toBe(false);
    expect(evidenceSanity({ file: "src/a.ts", line: 0, evidence: "该分支在异常时没有回滚事务" })).toBe(false);
  });
});

describe("decision brief · blocking gate (fail-safe)", () => {
  const criteria = [ac("AC#1", "凭据隔离：API Key 不得写入日志")];
  const changedFiles = ["src/server/credential-vault.ts"];

  it("is red for any unresolved critical", () => {
    const gate = gateBlocking([{ severity: "critical", file: "src/a.ts", title: "凭据泄漏" }], criteria);
    expect(gate.status).toBe("red");
    expect(gate.findings).toHaveLength(1);
  });

  it("is red for an AC-relevant unresolved high", () => {
    expect(gateBlocking([{ severity: "high", file: "src/server/credential-vault.ts", title: "凭据隔离缺失" }], criteria).status).toBe("red");
  });

  it("keeps a plausible high-severity defect blocking even when its wording shares no keywords with the AC (audit scenario)", () => {
    const gate = gateBlocking(
      [{ severity: "high", file: "src/server/credential-vault.ts", title: "事务提交顺序颠倒", evidence: "并发写入时会覆盖前一次提交" }],
      criteria,
      changedFiles,
      true,
    );
    expect(gate.status).toBe("red");
    expect(gate.findings?.[0]?.key).toBe("src/server/credential-vault.ts|事务提交顺序颠倒");
  });

  it("is green only when the finding names a file outside the change AND is clearly unrelated to every criterion", () => {
    const finding = { severity: "high", file: "src/client/App.tsx", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于 AA 标准" };
    expect(gateBlocking([finding], criteria, changedFiles, true).status).toBe("green");
  });

  it("keeps that same finding blocking whenever the change set is unknown, empty or not provably complete", () => {
    const finding = { severity: "high", file: "src/client/App.tsx", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于 AA 标准" };
    expect(gateBlocking([finding], criteria).status).toBe("red");
    expect(gateBlocking([finding], criteria, []).status).toBe("red");
    expect(gateBlocking([finding], criteria, null).status).toBe("red");
    // Audit follow-up: an incomplete (truncated) change set must not clear.
    expect(gateBlocking([finding], criteria, changedFiles, false).status).toBe("red");
    expect(gateBlocking([finding], criteria, changedFiles).status).toBe("red");
    const incomplete = gateBlocking([finding], criteria, changedFiles, false);
    expect(incomplete.detail).toContain("改动清单不完整");
  });

  it("treats an unresolved high of unknown relevance conservatively as blocking", () => {
    expect(gateBlocking([{ severity: "high", file: "src/server/run-patch.ts", title: "补丁生成失败" }], [ac("AC#1", "导出补丁功能必须可用")]).status).toBe("red");
    // No criteria at all ⇒ relevance is unknown, so a high still blocks.
    expect(gateBlocking([{ severity: "high", file: "src/a.ts", title: "输出不稳定" }], []).status).toBe("red");
    // A finding with no file can never be proven out of scope.
    expect(gateBlocking([{ severity: "high", file: null, title: "输出不稳定", evidence: "输出内容不稳定" }], criteria, changedFiles).status).toBe("red");
  });

  it("distinguishes AC-relevant blockers from unresolved-relevance blockers in the detail", () => {
    const gate = gateBlocking(
      [
        { severity: "high", file: "src/server/credential-vault.ts", title: "凭据隔离缺失" },
        { severity: "high", file: "src/server/run-patch.ts", title: "补丁生成失败" },
      ],
      criteria,
      ["src/server/credential-vault.ts", "src/server/run-patch.ts"],
      true,
    );
    expect(gate.status).toBe("red");
    expect(gate.detail).toContain("1 个明确与 AC/DoD 相关");
    expect(gate.detail).toContain("1 个相关性无法排除");
    expect(gate.detail).not.toContain("改动清单不完整");
  });

  it("ignores resolved findings", () => {
    expect(gateBlocking([{ severity: "critical", resolved: true, file: "src/a.ts", title: "已修复" }], criteria).status).toBe("green");
  });
});

describe("decision brief · scope gate", () => {
  it("is green for source files only when the change set is provably complete", () => {
    expect(gateScope(["src/a.ts", "src/b.ts"], null, true).status).toBe("green");
  });

  it("is red for generated/dirty files even in a partial list", () => {
    expect(gateScope(["src/a.ts", ".state/artifacts/diff.patch", "package-lock.json"], null, true).status).toBe("red");
    expect(gateScope(["dist/server/index.js"], null, false).status).toBe("red");
  });

  it("is red for files outside the allowed paths", () => {
    const gate = gateScope(["src/a.ts", "docs/secret.md"], ["src"]);
    expect(gate.status).toBe("red");
    expect(gate.detail).toContain("docs/secret.md");
    expect(gateScope(["src/a.ts", "src/nested/b.ts"], ["src"], true).status).toBe("green");
  });

  it("is unknown when the file list is missing or empty", () => {
    expect(gateScope(undefined, null).status).toBe("unknown");
    expect(gateScope([], null).status).toBe("unknown");
  });

  it("is unknown when a clean-looking list is not provably complete (audit follow-up: truncated diff)", () => {
    // A truncated inline diff can hide a generated/out-of-scope file, so a clean
    // partial list must not yield a green "scope is clean" claim.
    const omitted = gateScope(["src/a.ts"], null);
    expect(omitted.status).toBe("unknown");
    expect(omitted.detail).toContain("改动清单不完整");
    expect(gateScope(["src/a.ts"], null, false).status).toBe("unknown");
    expect(gateScope(["src/a.ts"], null, null).status).toBe("unknown");
  });
});

describe("decision brief · acceptance gate", () => {
  it("is green when every AC/DoD item maps to a change or a check", () => {
    const gate = gateAcceptance(
      [ac("AC#1", "修改 src/server/run-patch.ts 导出补丁文件"), ac("DoD#1", "npm test 通过")],
      ["src/server/run-patch.ts"],
      [{ name: "单元测试", command: "npm test", status: "passed" }],
    );
    expect(gate.status).toBe("green");
  });

  it("is red when a criterion names a file no change touches", () => {
    const gate = gateAcceptance([ac("AC#1", "修改 src/server/run-patch.ts 导出补丁文件"), ac("AC#2", "更新 docs/translation.md 支持多语言")], ["src/server/run-patch.ts"], []);
    expect(gate.status).toBe("red");
    expect(gate.detail).toContain("AC#2");
  });

  it("is red when no code change was delivered at all", () => {
    expect(gateAcceptance([ac("AC#1", "导出补丁文件")], [], []).status).toBe("red");
  });

  it("is unknown for prose criteria that cannot be mapped lexically", () => {
    expect(gateAcceptance([ac("AC#1", "错误提示必须优雅且可恢复")], ["src/a.ts"], []).status).toBe("unknown");
  });

  it("is unknown when there is nothing to verify against", () => {
    expect(gateAcceptance([ac("AC#1", "导出补丁文件")], null, []).status).toBe("unknown");
  });

  it("treats a story without AC/DoD as vacuously covered", () => {
    expect(gateAcceptance([], [], []).status).toBe("green");
    expect(gateAcceptance([], null, null).status).toBe("unknown");
  });
});

describe("decision brief · stop reason mapping", () => {
  it("maps max-rounds and strips the heavy findings/diff meta", () => {
    const reason = stopReasonFrom([
      { type: "review.changes_requested", message: "第 1 轮退回" },
      { type: "run.needs_human", message: "达到最大审核轮次", meta: { findings: [{ id: "f1" }], diff: "xxx", durationMs: 12 } },
    ]);
    expect(reason.code).toBe("max_review_rounds");
    expect(reason.message).toBe("达到最大审核轮次");
    expect(reason.meta).toEqual({ durationMs: 12 });
  });

  it("maps the convergence guard and keeps stallRule/persistingBlockingKeys", () => {
    const reason = stopReasonFrom([
      { type: "review.not_converging", message: "审核未收敛", meta: { stallRule: "unresolved-blocking", persistingBlockingKeys: ["src/a.ts|x"] } },
    ]);
    expect(reason.code).toBe("review_not_converging");
    expect(reason.meta.stallRule).toBe("unresolved-blocking");
    expect(reason.meta.persistingBlockingKeys).toEqual(["src/a.ts|x"]);
  });

  it("maps the other guard codes and falls back to unknown", () => {
    expect(stopReasonFrom([{ type: "run.deadline_exceeded" }]).code).toBe("deadline_exceeded");
    expect(stopReasonFrom([{ type: "run.budget_exhausted" }]).code).toBe("budget_exhausted");
    expect(stopReasonFrom([{ type: "checks.blocked_retry_review" }]).code).toBe("checks_failed");
    expect(stopReasonFrom([{ type: "run.completion_blocked" }]).code).toBe("completion_guard");
    expect(stopReasonFrom([{ type: "guard.scope" }]).code).toBe("guard");
    expect(stopReasonFrom([{ type: "chat.message" }]).code).toBe("unknown");
    expect(stopReasonFrom([]).code).toBe("unknown");
  });
});

describe("decision brief · streak → recommendation", () => {
  const gate = (id: DecisionBriefGate["id"], status: DecisionBriefGate["status"]): DecisionBriefGate => ({ id, status, detail: id });
  const item = (over: Partial<DecisionBriefRemainingItem> = {}): DecisionBriefRemainingItem => ({
    severity: "high",
    key: "src/a.ts|问题",
    streak: 1,
    evidenceOk: true,
    ...over,
  });

  it("accepts only when all four gates are green, listing remaining and false positives", () => {
    const gates = [gate("checks", "green"), gate("blocking", "green"), gate("scope", "green"), gate("acceptance", "green")];
    const recommendation = recommendDecision(gates, [item({ severity: "medium", streak: 0 }), item({ severity: "low", evidenceOk: false })]);
    expect(recommendation.action).toBe("accept");
    expect(recommendation.note).toContain("medium 1 条");
    expect(recommendation.note).toContain("疑似误报 1 条");
  });

  it("keeps developing when a gate is only unknown", () => {
    const gates = [gate("checks", "green"), gate("blocking", "green"), gate("scope", "green"), gate("acceptance", "unknown")];
    const recommendation = recommendDecision(gates, []);
    expect(recommendation.action).toBe("continue");
    expect(recommendation.note).toContain("acceptance");
  });

  it("names the file|title fingerprint and the 'do not touch other files' boundary for a streak ≥ 2", () => {
    const gates = [gate("checks", "green"), gate("blocking", "red"), gate("scope", "green"), gate("acceptance", "green")];
    const recommendation = recommendDecision(gates, [item({ streak: 2, key: "src/server/credential-vault.ts|凭据隔离缺失" })]);
    expect(recommendation.action).toBe("continue");
    expect(recommendation.note).toContain("src/server/credential-vault.ts|凭据隔离缺失");
    expect(recommendation.note).toContain("已返修 2 次未解决");
    expect(recommendation.note).toContain("不要改动其它文件");
  });

  it("produces a per-red note for streak = 1 findings", () => {
    const gates = [gate("checks", "green"), gate("blocking", "red"), gate("scope", "green"), gate("acceptance", "green")];
    const recommendation = recommendDecision(gates, [item({ streak: 1 }), item({ streak: 1, key: "src/b.ts|另一个问题" })]);
    expect(recommendation.action).toBe("continue");
    expect(recommendation.note).toContain("不要改动其它文件");
    expect(recommendation.note).not.toContain("已返修");
  });

  it("warns that the direction is probably wrong when the batch persists ≥ 3 rounds", () => {
    const gates = [gate("checks", "green"), gate("blocking", "red"), gate("scope", "green"), gate("acceptance", "green")];
    const recommendation = recommendDecision(gates, [item({ streak: 3 })]);
    expect(recommendation.note).toContain("方向可能不对");
    expect(recommendation.note).toContain("技术债");
  });

  it("points the note at the failed check when checks are red", () => {
    const gates = [
      { id: "checks", status: "red", detail: "1 项检查未通过：单元测试（npm test，exit 1）" },
      gate("blocking", "green"),
      gate("scope", "green"),
      gate("acceptance", "green"),
    ] as DecisionBriefGate[];
    const recommendation = recommendDecision(gates, []);
    expect(recommendation.action).toBe("continue");
    expect(recommendation.note).toContain("npm test");
  });
});

describe("decision brief · buildDecisionBrief", () => {
  it("degrades missing data to unknown instead of throwing", () => {
    const brief = buildDecisionBrief({});
    expect(brief.gates.map((gate) => gate.id)).toEqual(["checks", "blocking", "scope", "acceptance"]);
    expect(brief.gates.every((gate) => gate.status === "unknown")).toBe(true);
    expect(brief.remaining).toEqual([]);
    expect(brief.stopReason.code).toBe("unknown");
    expect(brief.recommendation.action).toBe("continue");
    // No diff metadata at all ⇒ completeness is not proven.
    expect(brief.diff).toMatchObject({ complete: false, reason: "absent" });
  });

  it("accepts a fully green run and classifies remaining findings by AC", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "修改 src/server/credential-vault.ts 实现凭据隔离：API Key 不得写入日志")],
      findings: [
        { id: "f1", stableKey: "src/server/credential-vault.ts|凭据隔离缺失", severity: "low", resolved: false, file: "src/server/credential-vault.ts", title: "凭据隔离缺失", evidence: "日志中出现了完整 API Key，未做脱敏处理", consecutiveRounds: 0 },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      diffFiles: ["src/server/credential-vault.ts"],
      diff: completeDiff,
      events: [{ type: "run.needs_human", message: "达到最大审核轮次", meta: { findings: [] } }],
    });
    expect(brief.stopReason.code).toBe("max_review_rounds");
    expect(brief.gates.every((gate) => gate.status === "green")).toBe(true);
    expect(brief.diff).toMatchObject({ complete: true, reason: "complete" });
    expect(brief.remaining).toHaveLength(1);
    expect(brief.remaining[0].ac).toBe("AC#1");
    expect(brief.remaining[0].streak).toBe(0);
    expect(brief.remaining[0].evidenceOk).toBe(true);
    expect(brief.recommendation.action).toBe("accept");
  });

  it("keeps a persisting blocker red with its streak and continues", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "凭据隔离：API Key 不得写入日志")],
      findings: [
        { id: "f1", stableKey: "src/server/credential-vault.ts|凭据隔离缺失", severity: "high", resolved: false, file: "src/server/credential-vault.ts", title: "凭据隔离缺失", evidence: "日志中出现了完整 API Key，未做脱敏处理", consecutiveRounds: 2 },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      diffFiles: ["src/server/credential-vault.ts"],
      events: [{ type: "review.not_converging", message: "审核未收敛", meta: { stallRule: "unresolved-blocking" } }],
    });
    expect(brief.gates.find((gate) => gate.id === "blocking")?.status).toBe("red");
    expect(brief.remaining[0].streak).toBe(2);
    expect(brief.recommendation.action).toBe("continue");
    expect(brief.recommendation.note).toContain("已返修 2 次未解决");
  });

  it("never clears a real high whose file is in the change but whose wording misses the AC text (audit regression)", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "凭据隔离：API Key 不得写入日志")],
      findings: [
        { id: "f1", severity: "high", resolved: false, file: "src/server/credential-vault.ts", title: "事务提交顺序颠倒", evidence: "并发写入时会覆盖前一次提交" },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      diffFiles: ["src/server/credential-vault.ts"],
    });
    expect(brief.gates.find((gate) => gate.id === "blocking")?.status).toBe("red");
    expect(brief.remaining[0]).toMatchObject({ severity: "high", relevance: "unknown" });
    expect(brief.remaining[0].ac).toBeUndefined();
    expect(brief.recommendation.action).toBe("continue");
  });

  it("clears an out-of-scope high only with explicit proof and records its relevance", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "修改 credential-vault.ts 实现凭据隔离")],
      findings: [
        { id: "f1", severity: "high", resolved: false, file: "src/client/theme.ts", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于 AA 标准" },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      diffFiles: ["src/server/credential-vault.ts"],
      diff: completeDiff,
    });
    expect(brief.gates.every((gate) => gate.status === "green")).toBe(true);
    expect(brief.remaining[0].relevance).toBe("irrelevant");
    expect(brief.recommendation.action).toBe("accept");
    // The green blocking gate names the complete change set as the proof.
    expect(brief.gates.find((gate) => gate.id === "blocking")?.detail).toContain("完整改动范围");
  });

  it("blocks an out-of-scope high when the brief has no diff to prove it out of scope", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "凭据隔离：API Key 不得写入日志")],
      findings: [
        { id: "f1", severity: "high", resolved: false, file: "src/client/theme.ts", title: "按钮颜色对比度不足", evidence: "对比度 3.2 低于 AA 标准" },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
    });
    expect(brief.gates.find((gate) => gate.id === "blocking")?.status).toBe("red");
    expect(brief.recommendation.action).toBe("continue");
  });

  it("audit follow-up: a truncated change set can never clear a real changed-file high (fail-safe)", () => {
    // The inline diff was truncated, so the changed file legitimately missing
    // from `diffFiles` must not be treated as "outside the change set".
    const finding = { id: "f1", severity: "high", resolved: false, file: "src/server/credential-vault.ts", title: "事务提交顺序颠倒", evidence: "并发写入时会覆盖前一次提交" };
    const criteria = [ac("AC#1", "实现凭据隔离：API Key 不得写入日志")];
    const brief = buildDecisionBrief({
      criteria,
      findings: [finding],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      // Only an unrelated file survived the truncated list.
      diffFiles: ["src/client/theme.ts"],
      diff: { complete: false, reason: "truncated", inlineBytes: 400_150, recordedBytes: 3_200_000 },
    });
    expect(brief.diff).toMatchObject({ complete: false, reason: "truncated" });
    expect(brief.diff.detail).toContain("截断");
    const blocking = brief.gates.find((gate) => gate.id === "blocking");
    expect(blocking?.status).toBe("red");
    expect(blocking?.detail).toContain("改动清单不完整");
    expect(brief.remaining[0]).toMatchObject({ severity: "high", relevance: "unknown" });
    expect(brief.recommendation.action).toBe("continue");
    // The scope gate cannot claim the partial list is clean either.
    expect(brief.gates.find((gate) => gate.id === "scope")?.status).toBe("unknown");
  });

  it("audit follow-up: a change set without provenance is treated as incomplete (missing artifact metadata)", () => {
    const brief = buildDecisionBrief({
      criteria: [ac("AC#1", "实现凭据隔离：API Key 不得写入日志")],
      findings: [
        { id: "f1", severity: "high", resolved: false, file: "src/a.ts", title: "事务提交顺序颠倒", evidence: "并发写入时会覆盖前一次提交" },
      ],
      checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
      diffFiles: ["src/b.ts"],
    });
    expect(brief.diff).toMatchObject({ complete: false, reason: "missing-metadata" });
    expect(brief.gates.find((gate) => gate.id === "blocking")?.status).toBe("red");
    expect(brief.gates.find((gate) => gate.id === "scope")?.status).toBe("unknown");
    expect(brief.recommendation.action).toBe("continue");
  });
});
