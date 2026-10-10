import { describe, expect, it } from "vitest";
import { parseRequirementSpec, renderAcceptanceCriteria, renderRequirementStoryDescription, renderRequirementTask } from "./requirement-assistant.js";

describe("requirement assistant protocol", () => {
  it("parses fenced output, caps questions and normalizes criteria", () => {
    const spec = parseRequirementSpec(`prefix\n\`\`\`json
      {"schemaVersion":1,"title":"发布进度窗口","objective":"让用户能够持续查看发布进度并随时关闭窗口。","background":"当前发布没有持续反馈。","inScope":["显示步骤"],"outOfScope":["修改发布协议"],"constraints":["不得自动重试"],"acceptanceCriteria":[{"id":"AC-1","statement":"发布期间持续显示最新步骤","verification":"manual"},"关闭窗口不应中断发布"],"definitionOfDone":["测试通过"],"assumptions":[],"risks":["断线重连"],"openQuestions":["是否保存日志？","保留多久？","谁能查看？","多余问题"],"suggestedChecks":["npm test"],"readiness":"ready"}
    \`\`\`\ntrailer`);
    expect(spec.readiness).toBe("needs_clarification");
    expect(spec.openQuestions).toHaveLength(3);
    expect(spec.acceptanceCriteria[1]).toMatchObject({ id: "AC-2", verification: "review" });
  });

  it("rejects a ready response without acceptance criteria", () => {
    expect(() => parseRequirementSpec(JSON.stringify({ schemaVersion: 1, title: "合法标题", objective: "这是足够长而且清晰的目标描述。", readiness: "ready" })))
      .toThrow(/acceptance criteria/);
  });

  it("rejects an unsupported contract version", () => {
    expect(() => parseRequirementSpec(JSON.stringify({ schemaVersion: 2, title: "合法标题", objective: "这是足够长而且清晰的目标描述。" })))
      .toThrow(/schema version/);
  });

  it("renders a stable task and a compatibility acceptance field", () => {
    const spec = parseRequirementSpec(JSON.stringify({
      schemaVersion: 1,
      title: "需求助手",
      objective: "把自然语言需求整理成结构化开发输入。",
      background: "用户输入不稳定。",
      inScope: ["创建任务入口"],
      outOfScope: ["自动启动任务"],
      constraints: ["一次模型调用"],
      acceptanceCriteria: [{ id: "AC-1", statement: "用户确认后才应用结果", verification: "manual" }],
      definitionOfDone: ["单元测试通过"],
      assumptions: [], risks: [], openQuestions: [], suggestedChecks: [], readiness: "ready",
    }));
    expect(renderRequirementTask(spec, "zh")).toContain("## 验收条件");
    expect(renderRequirementTask(spec, "en")).toContain("## Acceptance criteria");
    expect(renderAcceptanceCriteria(spec)).toBe("[AC-1] 用户确认后才应用结果 (manual)");
    expect(renderRequirementStoryDescription(spec, "zh")).toContain("范围内:\n- 创建任务入口");
  });
});
