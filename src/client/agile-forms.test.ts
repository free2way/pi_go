import { describe, expect, it } from "vitest";
import {
  agileFormErrorMessage,
  buildReleaseInput,
  buildSprintInput,
  buildStoryInput,
  buildTemplateInput,
  parseModelSelection,
  sprintToFormValues,
  storyToFormValues,
  type SprintFormValues,
  type StoryFormValues,
  type TemplateFormValues,
} from "./agile-forms";
import type { AgileSprint, AgileStory } from "../shared/agile";

const templateValues: TemplateFormValues = {
  name: "快速组合",
  developerModel: "deepseek::flash",
  reviewerModel: "openai::gpt-4o",
  budgetTokens: "",
  budgetCostUsd: "",
  budgetModelCalls: "",
  budgetDurationSeconds: "",
  maxParallel: "",
};

describe("parseModelSelection", () => {
  it("splits provider::model and rejects incomplete values", () => {
    expect(parseModelSelection("deepseek::flash")).toEqual({ provider: "deepseek", model: "flash" });
    expect(parseModelSelection("flash")).toBeUndefined();
    expect(parseModelSelection("::flash")).toBeUndefined();
    expect(parseModelSelection("deepseek::")).toBeUndefined();
  });
});

describe("buildTemplateInput", () => {
  it("builds a models-only template, omitting an unset budget and sending maxParallel null", () => {
    const result = buildTemplateInput(templateValues);
    expect(result).toEqual({
      ok: true,
      input: {
        name: "快速组合",
        developerModel: { provider: "deepseek", model: "flash" },
        reviewerModel: { provider: "openai", model: "gpt-4o" },
        maxParallel: null,
      },
    });
  });

  it("fills the whole budget from a partial entry, defaulting missing members to 0", () => {
    const result = buildTemplateInput({ ...templateValues, budgetTokens: "1000", maxParallel: "2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.budget).toEqual({ maxTokens: 1000, maxCostUsd: 0, maxModelCalls: 0, maxDurationSeconds: 0 });
    expect(result.input.maxParallel).toBe(2);
  });

  it("rejects empty names, missing models and bad numbers", () => {
    expect(buildTemplateInput({ ...templateValues, name: "  " })).toEqual({ ok: false, message: "请填写模板名称" });
    expect(buildTemplateInput({ ...templateValues, developerModel: "" })).toEqual({ ok: false, message: "请选择开发模型" });
    expect(buildTemplateInput({ ...templateValues, reviewerModel: "" })).toEqual({ ok: false, message: "请选择审核模型" });
    expect(buildTemplateInput({ ...templateValues, budgetCostUsd: "abc" })).toEqual({ ok: false, message: "预算成本（$） 必须是非负数字" });
    expect(buildTemplateInput({ ...templateValues, budgetTokens: "-1" })).toEqual({ ok: false, message: "预算 Token 必须是非负数字" });
    expect(buildTemplateInput({ ...templateValues, maxParallel: "0" })).toEqual({ ok: false, message: "最大并行需为 1–32 的整数" });
    expect(buildTemplateInput({ ...templateValues, maxParallel: "33" })).toEqual({ ok: false, message: "最大并行需为 1–32 的整数" });
  });
});

describe("buildReleaseInput", () => {
  it("trims name/version/notes and keeps the selected stories", () => {
    const result = buildReleaseInput({ name: " 结账 ", version: " v1.2.0 ", notes: " 上线 ", status: "in_progress", storyIds: ["s1", "s2"] });
    expect(result).toEqual({ ok: true, input: { name: "结账", version: "v1.2.0", notes: "上线", status: "in_progress", storyIds: ["s1", "s2"] } });
  });

  it("renders the validation copy in English", () => {
    expect(buildTemplateInput({ ...templateValues, name: "" }, "en")).toEqual({ ok: false, message: "Enter a template name" });
    expect(buildTemplateInput({ ...templateValues, budgetCostUsd: "abc" }, "en")).toEqual({
      ok: false,
      message: "Cost budget ($) must be a non-negative number",
    });
    expect(buildReleaseInput({ name: "", version: "v1", notes: "", status: "planned", storyIds: [] }, "en").ok).toBe(false);
    expect(agileFormErrorMessage({ code: "TEMPLATE_NOT_FOUND" }, "fallback", "en")).toBe("The template does not exist or was deleted");
  });

  it("requires both a name and a version", () => {
    expect(buildReleaseInput({ name: "", version: "v1", notes: "", status: "planned", storyIds: [] })).toEqual({ ok: false, message: "请填写发布名称" });
    expect(buildReleaseInput({ name: "结账", version: "  ", notes: "", status: "planned", storyIds: [] })).toEqual({ ok: false, message: "请填写版本号" });
  });
});

describe("agileFormErrorMessage", () => {
  it("surfaces the server's 409 name-taken message", () => {
    expect(agileFormErrorMessage({ code: "TEMPLATE_NAME_TAKEN", message: "模板名称 快速组合 已存在" }, "创建模板失败"))
      .toBe("模板名称 快速组合 已存在");
  });

  it("falls back on a code-specific hint, then the caller's message", () => {
    expect(agileFormErrorMessage({ code: "TEMPLATE_NAME_TAKEN" }, "创建模板失败")).toContain("已存在");
    expect(agileFormErrorMessage({ code: "TEMPLATE_NOT_FOUND" }, "删除模板失败")).toBe("模板不存在或已被删除");
    expect(agileFormErrorMessage(new Error("网络错误"), "创建模板失败")).toBe("网络错误");
    expect(agileFormErrorMessage(undefined, "创建模板失败")).toBe("创建模板失败");
  });
});

/** Bypass the unions so the tests can feed the invalid values the server would reject. */
const asSprintStatus = (value: string) => value as SprintFormValues["status"];
const asStoryPriority = (value: string) => value as StoryFormValues["priority"];

const sprintValues: SprintFormValues = {
  name: "冲刺 4",
  goal: "打通结算闭环",
  startDate: "2026-01-05",
  endDate: "2026-01-19",
  status: "active",
};

const storyValues: StoryFormValues = {
  title: "结算对账",
  description: "把 T+1 的对账结果写回账本",
  acceptanceCriteria: "差异可导出\n\n  重试三次后告警  \n",
  definitionOfDone: "单测覆盖",
  priority: "should",
  estimate: "",
  sprintId: "",
  workspaceId: "",
  developerModel: "",
  reviewerModel: "",
  maxParallel: "",
  budgetTokens: "",
  budgetCostUsd: "",
  budgetModelCalls: "",
  budgetDurationSeconds: "",
};

const sprint: AgileSprint = {
  id: "sp-1",
  projectId: "p-1",
  ownerId: "u-1",
  name: "冲刺 4",
  goal: "打通结算闭环",
  startDate: "2026-01-05",
  endDate: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const story: AgileStory = {
  id: "s-1",
  projectId: "p-1",
  ownerId: "u-1",
  title: "结算对账",
  description: "把 T+1 的对账结果写回账本",
  acceptanceCriteria: ["差异可导出", "重试三次后告警"],
  priority: "should",
  estimate: 8,
  definitionOfDone: ["单测覆盖", "灰度发布"],
  developerModel: { provider: "deepseek", model: "flash" },
  reviewerModel: { provider: "openai", model: "gpt-4o" },
  budget: { maxTokens: 20_000, maxCostUsd: 1.5, maxModelCalls: 30, maxDurationSeconds: 600 },
  maxParallel: 4,
  status: "in_progress",
  sprintId: "sprint-4",
  workspaceId: "ws-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("buildSprintInput", () => {
  it("trims the name/goal and turns blank dates into null", () => {
    expect(buildSprintInput({ ...sprintValues, name: " 冲刺 5 ", goal: "   ", startDate: " ", endDate: "" })).toEqual({
      ok: true,
      input: { name: "冲刺 5", goal: "", startDate: null, endDate: null, status: "active" },
    });
  });

  it("rejects an empty/over-long name, an over-long goal, a reversed date range and a bad status", () => {
    expect(buildSprintInput({ ...sprintValues, name: "   " })).toEqual({ ok: false, message: "请填写冲刺名称" });
    expect(buildSprintInput({ ...sprintValues, name: "x".repeat(121) })).toEqual({ ok: false, message: "冲刺名称最多 120 个字符" });
    expect(buildSprintInput({ ...sprintValues, goal: "x".repeat(4_001) })).toEqual({ ok: false, message: "冲刺目标最多 4000 个字符" });
    expect(buildSprintInput({ ...sprintValues, startDate: "2026-01-19", endDate: "2026-01-05" })).toEqual({
      ok: false,
      message: "结束日期不能早于开始日期",
    });
    expect(buildSprintInput({ ...sprintValues, status: asSprintStatus("paused") })).toEqual({ ok: false, message: "冲刺状态无效" });
  });

  it("renders the sprint validation copy in English", () => {
    expect(buildSprintInput({ ...sprintValues, name: "" }, "en")).toEqual({ ok: false, message: "Enter a sprint name" });
    expect(buildSprintInput({ ...sprintValues, startDate: "2026-02-01", endDate: "2026-01-01" }, "en")).toEqual({
      ok: false,
      message: "The end date cannot be earlier than the start date",
    });
  });
});

describe("sprintToFormValues", () => {
  it("maps a null date to an empty input and round-trips back into the same input", () => {
    expect(sprintToFormValues(sprint)).toEqual({
      name: "冲刺 4",
      goal: "打通结算闭环",
      startDate: "2026-01-05",
      endDate: "",
      status: "active",
    });
    expect(buildSprintInput(sprintToFormValues(sprint))).toEqual({
      ok: true,
      input: { name: sprint.name, goal: sprint.goal, startDate: sprint.startDate, endDate: sprint.endDate, status: sprint.status },
    });
  });
});

describe("buildStoryInput", () => {
  it("trims the text, splits the textareas into non-empty lines and clears the optional pickers", () => {
    expect(buildStoryInput(storyValues)).toEqual({
      ok: true,
      input: {
        title: "结算对账",
        description: "把 T+1 的对账结果写回账本",
        acceptanceCriteria: ["差异可导出", "重试三次后告警"],
        definitionOfDone: ["单测覆盖"],
        priority: "should",
        estimate: null,
        sprintId: null,
        workspaceId: null,
        developerModel: null,
        reviewerModel: null,
        maxParallel: null,
        budget: null,
      },
    });
  });

  it("treats a whitespace-only textarea as an empty list", () => {
    const result = buildStoryInput({ ...storyValues, acceptanceCriteria: "  \n \n", definitionOfDone: "\t\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.acceptanceCriteria).toEqual([]);
    expect(result.input.definitionOfDone).toEqual([]);
  });

  it("fills the whole budget from a partial entry and parses the pickers", () => {
    const result = buildStoryInput({
      ...storyValues,
      estimate: "5",
      sprintId: "sprint-4",
      workspaceId: "ws-1",
      developerModel: "deepseek::flash",
      reviewerModel: "openai::gpt-4o",
      maxParallel: "4",
      budgetTokens: "20000",
      budgetCostUsd: "1.5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.estimate).toBe(5);
    expect(result.input.sprintId).toBe("sprint-4");
    expect(result.input.workspaceId).toBe("ws-1");
    expect(result.input.developerModel).toEqual({ provider: "deepseek", model: "flash" });
    expect(result.input.reviewerModel).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(result.input.maxParallel).toBe(4);
    expect(result.input.budget).toEqual({ maxTokens: 20_000, maxCostUsd: 1.5, maxModelCalls: 0, maxDurationSeconds: 0 });
  });

  it("rejects a short/over-long title, bad estimate, bad maxParallel, bad budget and a bad priority", () => {
    expect(buildStoryInput({ ...storyValues, title: "短" })).toEqual({ ok: false, message: "故事标题至少 2 个字符" });
    expect(buildStoryInput({ ...storyValues, title: "x".repeat(201) })).toEqual({ ok: false, message: "故事标题最多 200 个字符" });
    expect(buildStoryInput({ ...storyValues, description: "x".repeat(4_001) })).toEqual({ ok: false, message: "描述最多 4000 个字符" });
    expect(buildStoryInput({ ...storyValues, acceptanceCriteria: "x".repeat(501) })).toEqual({
      ok: false,
      message: "验收标准/完成定义中每条最多 500 个字符",
    });
    const thirtyOneLines = Array.from({ length: 31 }, (_, index) => `条目 ${index}`).join("\n");
    expect(buildStoryInput({ ...storyValues, acceptanceCriteria: thirtyOneLines })).toEqual({ ok: false, message: "验收标准最多 30 条" });
    expect(buildStoryInput({ ...storyValues, definitionOfDone: thirtyOneLines })).toEqual({ ok: false, message: "完成定义最多 30 条" });
    expect(buildStoryInput({ ...storyValues, priority: asStoryPriority("maybe") })).toEqual({ ok: false, message: "优先级无效" });
    expect(buildStoryInput({ ...storyValues, estimate: "4" })).toEqual({ ok: false, message: "估算只能填写 1/2/3/5/8/13" });
    expect(buildStoryInput({ ...storyValues, maxParallel: "0" })).toEqual({ ok: false, message: "最大并行需为 1–32 的整数" });
    expect(buildStoryInput({ ...storyValues, maxParallel: "33" })).toEqual({ ok: false, message: "最大并行需为 1–32 的整数" });
    expect(buildStoryInput({ ...storyValues, maxParallel: "1.5" })).toEqual({ ok: false, message: "最大并行需为 1–32 的整数" });
    expect(buildStoryInput({ ...storyValues, budgetTokens: "abc" })).toEqual({ ok: false, message: "预算 Token 必须是非负数字" });
    expect(buildStoryInput({ ...storyValues, budgetCostUsd: "abc" })).toEqual({ ok: false, message: "预算成本（$） 必须是非负数字" });
    expect(buildStoryInput({ ...storyValues, budgetModelCalls: "-1" })).toEqual({ ok: false, message: "模型调用 必须是非负数字" });
    expect(buildStoryInput({ ...storyValues, budgetDurationSeconds: "1.5" })).toEqual({ ok: false, message: "时长（秒） 必须是非负数字" });
    expect(buildStoryInput({ ...storyValues, budgetCostUsd: "abc" }, "en")).toEqual({
      ok: false,
      message: "Cost budget ($) must be a non-negative number",
    });
  });
});

describe("storyToFormValues", () => {
  it("round-trips a fully populated story back into the same input", () => {
    expect(buildStoryInput(storyToFormValues(story))).toEqual({
      ok: true,
      input: {
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
        definitionOfDone: story.definitionOfDone,
        priority: story.priority,
        estimate: story.estimate,
        sprintId: story.sprintId,
        workspaceId: story.workspaceId,
        developerModel: story.developerModel,
        reviewerModel: story.reviewerModel,
        maxParallel: story.maxParallel,
        budget: story.budget,
      },
    });
  });

  it("maps nulls to empty inputs and joins the lists with newlines", () => {
    const bare: AgileStory = {
      ...story,
      acceptanceCriteria: ["差异可导出", "重试三次后告警"],
      definitionOfDone: [],
      estimate: null,
      developerModel: null,
      reviewerModel: null,
      budget: null,
      maxParallel: null,
      sprintId: null,
      workspaceId: null,
    };
    const form = storyToFormValues(bare);
    expect(form.acceptanceCriteria).toBe("差异可导出\n重试三次后告警");
    expect(form.definitionOfDone).toBe("");
    expect(form.estimate).toBe("");
    expect(form.developerModel).toBe("");
    expect(form.reviewerModel).toBe("");
    expect(form.sprintId).toBe("");
    expect(form.workspaceId).toBe("");
    expect(form.maxParallel).toBe("");
    expect(form.budgetTokens).toBe("");
    expect(buildStoryInput(form)).toEqual({
      ok: true,
      input: {
        title: bare.title,
        description: bare.description,
        acceptanceCriteria: bare.acceptanceCriteria,
        definitionOfDone: [],
        priority: bare.priority,
        estimate: null,
        sprintId: null,
        workspaceId: null,
        developerModel: null,
        reviewerModel: null,
        maxParallel: null,
        budget: null,
      },
    });
  });
});
