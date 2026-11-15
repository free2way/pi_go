import { useState } from "react";
import { applyModelTemplate, type AgileStory, type StoryPriority } from "../shared/agile";
import { api } from "./api";
import { agileFormErrorMessage, buildStoryInput, storyToFormValues } from "./agile-forms";
import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "../shared/i18n";
import type { ModelTemplate, StoryDetail } from "../shared/agile";
import type { Workspace } from "../shared/types";
import type { useT } from "./i18n";

type StoryFormOptions = {
  projectId: string;
  locale: Locale;
  t: ReturnType<typeof useT>["t"];
  templates: ModelTemplate[];
  workspaces: Workspace[];
  setPanel: (panel: "none" | "story") => void;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
  setBusy: (busy: string) => void;
  setStories: Dispatch<SetStateAction<AgileStory[]>>;
  setDetail: Dispatch<SetStateAction<StoryDetail | undefined>>;
  setSelectedId: (id: string) => void;
};

export function useAgileStoryForm({
  projectId, locale, t, templates, workspaces, setPanel, setError, setNotice,
  setBusy, setStories, setDetail, setSelectedId,
}: StoryFormOptions) {
  // new-story form — `storyManageId` empty = create mode, otherwise the edited story.
  // One form instance serves both, exactly like 「发布管理」: fill it with
  // `storyToFormValues` to edit, and `saveStory` picks POST or PATCH.
  const [storyManageId, setStoryManageId] = useState("");
  const [storyTitle, setStoryTitle] = useState("");
  const [storyDescription, setStoryDescription] = useState("");
  const [storyCriteria, setStoryCriteria] = useState("");
  const [storyDod, setStoryDod] = useState("");
  const [storyPriority, setStoryPriority] = useState<StoryPriority>("should");
  const [storyEstimate, setStoryEstimate] = useState("");
  const [storyWorkspace, setStoryWorkspace] = useState("");
  const [storySprint, setStorySprint] = useState("");
  const [storyTemplate, setStoryTemplate] = useState("");
  const [storyDeveloper, setStoryDeveloper] = useState("");
  const [storyReviewer, setStoryReviewer] = useState("");
  const [storyMaxParallel, setStoryMaxParallel] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [budgetCost, setBudgetCost] = useState("");
  const [budgetCalls, setBudgetCalls] = useState("");
  const [budgetSeconds, setBudgetSeconds] = useState("");

  const selectedStoryWorkspace = workspaces.find((workspace) => workspace.id === storyWorkspace);
  const storyRequirementDraft = [
    storyDescription.trim(),
    storyCriteria.trim() ? `${locale === "en" ? "Current acceptance criteria" : "当前验收条件"}:\n${storyCriteria.trim()}` : "",
    storyDod.trim() ? `${locale === "en" ? "Current definition of done" : "当前完成定义"}:\n${storyDod.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  const applyStoryTemplate = (id: string) => {
    setStoryTemplate(id);
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    setStoryDeveloper(`${template.developerModel.provider}::${template.developerModel.model}`);
    setStoryReviewer(`${template.reviewerModel.provider}::${template.reviewerModel.model}`);
    const applied = applyModelTemplate(template);
    if (applied.budget) {
      setBudgetTokens(String(applied.budget.maxTokens));
      setBudgetCost(String(applied.budget.maxCostUsd));
      setBudgetCalls(String(applied.budget.maxModelCalls));
      setBudgetSeconds(String(applied.budget.maxDurationSeconds));
    }
    if (applied.maxParallel !== undefined) setStoryMaxParallel(String(applied.maxParallel));
  };

  // 故事表单: create + edit share one form, same switch as the sprint form above.
  const resetStoryForm = () => {
    setStoryManageId("");
    setStoryTitle("");
    setStoryDescription("");
    setStoryCriteria("");
    setStoryDod("");
    setStoryEstimate("");
    setStoryMaxParallel("");
    setStoryDeveloper("");
    setStoryReviewer("");
    setStoryWorkspace("");
    setStorySprint("");
    setStoryTemplate("");
    setStoryPriority("should");
    setBudgetTokens("");
    setBudgetCost("");
    setBudgetCalls("");
    setBudgetSeconds("");
  };

  const closeStoryForm = () => {
    resetStoryForm();
    setPanel("none");
  };

  /** Fill the story form from an existing story (list row, board card or detail panel). */
  const editStory = (story: AgileStory) => {
    const values = storyToFormValues(story);
    setStoryManageId(story.id);
    setStoryTitle(values.title);
    setStoryDescription(values.description);
    setStoryCriteria(values.acceptanceCriteria);
    setStoryDod(values.definitionOfDone);
    setStoryPriority(values.priority);
    setStoryEstimate(values.estimate);
    setStorySprint(values.sprintId);
    setStoryWorkspace(values.workspaceId);
    setStoryDeveloper(values.developerModel);
    setStoryReviewer(values.reviewerModel);
    setStoryMaxParallel(values.maxParallel);
    setBudgetTokens(values.budgetTokens);
    setBudgetCost(values.budgetCostUsd);
    setBudgetCalls(values.budgetModelCalls);
    setBudgetSeconds(values.budgetDurationSeconds);
    setStoryTemplate("");
    setPanel("story");
    setError("");
    setNotice("");
  };

  const saveStory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError(t("agile.error.selectProjectFirst")); return; }
    const built = buildStoryInput({
      title: storyTitle,
      description: storyDescription,
      acceptanceCriteria: storyCriteria,
      definitionOfDone: storyDod,
      priority: storyPriority,
      estimate: storyEstimate,
      sprintId: storySprint,
      workspaceId: storyWorkspace,
      developerModel: storyDeveloper,
      reviewerModel: storyReviewer,
      maxParallel: storyMaxParallel,
      budgetTokens,
      budgetCostUsd: budgetCost,
      budgetModelCalls: budgetCalls,
      budgetDurationSeconds: budgetSeconds,
    }, locale);
    if (!built.ok) { setError(built.message); return; }
    const editing = storyManageId !== "";
    setBusy("story");
    setError("");
    try {
      if (editing) {
        const updated = await api.patchStory(storyManageId, built.input);
        setStories((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        // Keep the open detail panel in step (it is the same story object).
        setDetail((current) => (current && current.id === updated.id ? { ...current, ...updated } : current));
        setNotice(t("agile.storyForm.updated"));
      } else {
        const story = await api.createStory({ projectId, ...built.input });
        setStories((current) => [story, ...current]);
        setSelectedId(story.id);
      }
      closeStoryForm();
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t(editing ? "agile.error.patchStory" : "agile.error.createStory"), locale));
    } finally {
      setBusy("");
    }
  };

  return {
    saveStory, storyManageId, storyTitle, setStoryTitle, setStoryDescription, setStoryCriteria,
    setStoryDod, storyDescription, storyCriteria, storyDod, storyPriority, setStoryPriority,
    storyEstimate, setStoryEstimate, storyWorkspace, setStoryWorkspace, storySprint, setStorySprint,
    storyTemplate, storyMaxParallel, setStoryMaxParallel, storyDeveloper, setStoryDeveloper,
    storyReviewer, setStoryReviewer, budgetTokens, setBudgetTokens, budgetCost, setBudgetCost,
    budgetCalls, setBudgetCalls, budgetSeconds, setBudgetSeconds, storyRequirementDraft,
    selectedStoryWorkspace, applyStoryTemplate, resetStoryForm, closeStoryForm, editStory,
  };
}
