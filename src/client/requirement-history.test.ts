import { describe, expect, it } from "vitest";
import type { Run } from "../shared/types";
import { copyTextForRun, humanNoteKindLabel, humanNotesOf, requirementSummary, runStateLabels } from "./requirement-history";

describe("requirement-history helpers (需求历史)", () => {
  it("collapses multi-line requirements and truncates with an ellipsis", () => {
    expect(requirementSummary("第一行\n\n第二行   有空格")).toBe("第一行 第二行 有空格");
    const long = "需求".repeat(120);
    const summary = requirementSummary(long, 20);
    expect(summary.length).toBeLessThanOrEqual(20);
    expect(summary.endsWith("…")).toBe(true);
    expect(requirementSummary("短需求", 20)).toBe("短需求");
  });

  it("labels every human note kind in Chinese", () => {
    expect(humanNoteKindLabel("approve_continue")).toBe("继续开发");
    expect(humanNoteKindLabel("approve_accept")).toBe("接受交付");
    expect(humanNoteKindLabel("resume")).toBe("恢复下一轮");
    expect(humanNoteKindLabel("reject")).toBe("拒绝交付");
  });

  it("reads missing humanNotes as an empty list", () => {
    expect(humanNotesOf({} as Pick<Run, "humanNotes">)).toEqual([]);
    expect(humanNotesOf({ humanNotes: [] })).toEqual([]);
  });

  it("builds the copy text from title and full task", () => {
    expect(copyTextForRun({ title: "修复并发", task: "详细需求\n第二行" })).toBe("修复并发\n\n详细需求\n第二行");
    expect(copyTextForRun({ title: "", task: "只有需求" })).toBe("只有需求");
  });

  it("covers all nine run states with labels", () => {
    expect(Object.keys(runStateLabels)).toHaveLength(9);
    expect(runStateLabels.needs_human).toBe("需要人工处理");
  });
});
