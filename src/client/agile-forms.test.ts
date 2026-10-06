import { describe, expect, it } from "vitest";
import { agileFormErrorMessage, buildReleaseInput, buildTemplateInput, parseModelSelection, type TemplateFormValues } from "./agile-forms";

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
