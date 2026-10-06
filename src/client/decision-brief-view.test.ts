import { describe, expect, it } from "vitest";
import { buildDecisionBrief, type DecisionBrief } from "../shared/decision-brief";
import { t } from "../shared/i18n";
import {
  acceptConfirmMessage,
  continueConfirmMessage,
  decisionBriefActionRequest,
  decisionBriefExpanded,
  decisionBriefHeading,
  decisionBriefHeadingKey,
  decisionBriefTone,
  decisionGateKeys,
  decisionRemainingGroupKey,
  gateNavTarget,
  groupRemainingByAc,
} from "./decision-brief-view";

const green: DecisionBrief = buildDecisionBrief({
  criteria: [],
  findings: [],
  checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
  diffFiles: ["src/a.ts"],
});

const red: DecisionBrief = buildDecisionBrief({
  criteria: [],
  findings: [{ id: "f1", stableKey: "src/a.ts|问题", severity: "high", resolved: false, file: "src/a.ts", title: "问题" }],
  checks: [{ name: "单元测试", command: "npm test", status: "passed" }],
  diffFiles: ["src/a.ts"],
});

const unknown: DecisionBrief = buildDecisionBrief({});

describe("decision brief view · three-state rendering", () => {
  it("turns an all-green brief into an accept card", () => {
    expect(decisionBriefTone(green)).toBe("accept");
    expect(decisionBriefHeadingKey(green)).toBe("decision.headingAccept");
    expect(decisionBriefHeading(green)).toContain("可以接受交付");
    expect(decisionBriefHeading(green, "en")).toContain("can be accepted");
  });

  it("turns a red or unknown brief into a continue card", () => {
    expect(decisionBriefTone(red)).toBe("continue");
    expect(decisionBriefHeading(red)).toContain("建议继续开发");
    expect(decisionBriefTone(unknown)).toBe("continue");
    expect(decisionBriefHeading(unknown)).toContain("建议继续开发");
    expect(decisionBriefHeading(unknown, "en")).toContain("continue development");
  });

  it("expands only for a terminal run and respects an explicit collapse", () => {
    expect(decisionBriefExpanded("needs_human", false, ["needs_human", "failed"])).toBe(true);
    expect(decisionBriefExpanded("needs_human", true, ["needs_human"])).toBe(false);
    expect(decisionBriefExpanded("developing", false, ["needs_human"])).toBe(false);
  });

  it("groups remaining findings by AC label and splits the unmapped bucket by relevance", () => {
    const brief = buildDecisionBrief({
      criteria: [{ label: "AC#1", text: "修改 src/a.ts 的行为" }],
      findings: [
        { id: "f1", stableKey: "src/a.ts|问题一", severity: "medium", resolved: false, file: "src/a.ts", title: "问题一", evidence: "证据内容足够长可以判断" },
        { id: "f2", stableKey: "src/b.ts|问题二", severity: "high", resolved: false, file: "src/b.ts", title: "问题二", evidence: "证据内容足够长可以判断" },
        { id: "f3", stableKey: "tools/colors.ts|问题三", severity: "low", resolved: false, file: "tools/colors.ts", title: "问题三", evidence: "证据内容足够长可以判断" },
      ],
      diffFiles: ["src/a.ts"],
    });
    const groups = groupRemainingByAc(brief.remaining);
    expect(groups.map((group) => group.kind)).toEqual(["unknown", "ac", "unmapped"]);
    expect(groups[1].ac).toBe("AC#1");
    expect(groups.map((group) => group.ac ?? t("zh", decisionRemainingGroupKey(group.kind)!)))
      .toEqual(["相关性未确认", "AC#1", "未映射到 AC"]);
    expect(groups[1].items[0].streak).toBe(0);
    expect(groups[0].items[0].relevance).toBe("unknown");
    expect(groups[2].items[0].relevance).toBe("irrelevant");
  });

  it("exposes catalog keys for the gate labels", () => {
    expect(t("zh", decisionGateKeys.blocking)).toBe("阻断问题");
    expect(t("en", decisionGateKeys.blocking)).toBe("Blocking findings");
  });
});

describe("decision brief view · gate navigation", () => {
  it("anchors a blocking gate to its first finding", () => {
    const blocking = red.gates.find((gate) => gate.id === "blocking");
    expect(blocking).toBeDefined();
    expect(gateNavTarget(blocking!)).toEqual({ tab: "review", key: "src/a.ts|问题" });
  });

  it("routes the other gates to their evidence tabs", () => {
    for (const gate of unknown.gates) {
      if (gate.status === "green") continue;
      const target = gateNavTarget(gate);
      expect(["checks", "review", "diff"]).toContain(target.tab);
      if (gate.id !== "blocking") expect(target.key).toBeUndefined();
    }
  });
});

describe("decision brief view · one-click actions", () => {
  it("continue reuses approve(mode=continue) with the drafted note", () => {
    const request = decisionBriefActionRequest(red, "continue");
    expect(request.mode).toBe("continue");
    expect(request.note).toBe(red.recommendation.note);
    expect(request.acknowledgeOpenFindings).toBeUndefined();
    expect(continueConfirmMessage("任务", request.note ?? "")).toContain("不要改动其它文件");
  });

  it("accept reuses approve(mode=accept) and acknowledges open findings only when present", () => {
    expect(decisionBriefActionRequest(green, "accept")).toEqual({ mode: "accept" });
    expect(decisionBriefActionRequest(red, "accept")).toEqual({ mode: "accept", acknowledgeOpenFindings: true });
    expect(acceptConfirmMessage("任务", 2)).toContain("2 条未解决意见");
    expect(acceptConfirmMessage("任务", 0)).not.toContain("未解决意见");
    expect(acceptConfirmMessage("Task", 2, "en")).toContain("2 unresolved finding(s)");
    expect(continueConfirmMessage("Task", "note", "en")).toContain("drafted note");
  });
});
