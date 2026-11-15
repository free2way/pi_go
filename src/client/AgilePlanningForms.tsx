import { LoaderCircle, Plus, Save, X } from "lucide-react";
import { SPRINT_STATUSES, STORY_PRIORITIES, type SprintStatus, type StoryPriority } from "../shared/agile";
import { renderAcceptanceCriteria, renderRequirementStoryDescription } from "../shared/requirement-assistant";
import { STORY_ESTIMATES } from "./agile-forms";
import { estimateLabel, priorityLabel } from "./agile-view";
import { RequirementAssistant } from "./RequirementAssistant";
import { sprintStatusKey } from "./agile-format";
import type { AgilePageState } from "./useAgilePage";

export function AgilePlanningForms({ state }: { state: AgilePageState["forms"] }) {
  const {
    panel, createProject, t, setPanel, projectName, setProjectName, projectKey, setProjectKey, busy,
    saveSprint, sprintManageId, closeSprintForm, sprintName, setSprintName, sprintGoal, setSprintGoal,
    sprintStart, setSprintStart, sprintEnd, setSprintEnd, sprintFormStatus, setSprintFormStatus,
    saveStory, storyManageId, closeStoryForm, storyTitle, setStoryTitle, storyRequirementDraft, models,
    selectedProject, selectedStoryWorkspace, setStoryDescription, locale, setStoryCriteria, setStoryDod,
    storyDescription, storyCriteria, storyDod, storyPriority, setStoryPriority, storyEstimate,
    setStoryEstimate, storyWorkspace, setStoryWorkspace, workspaces, storySprint, setStorySprint,
    sprints, storyTemplate, applyStoryTemplate, templates, storyMaxParallel, setStoryMaxParallel,
    storyDeveloper, setStoryDeveloper, storyReviewer, setStoryReviewer, budgetTokens, setBudgetTokens,
    budgetCost, setBudgetCost, budgetCalls, setBudgetCalls, budgetSeconds, setBudgetSeconds,
  } = state;

  return (
    <>
      <div className="ws-forms">
        {panel === "project" && (
          <form className="ws-form" onSubmit={createProject}>
            <div className="ws-form-head"><div><span className="eyebrow">NEW PROJECT</span><h3>{t("agile.projectForm.title")}</h3></div><button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button></div>
            <p className="ws-form-help">{t("agile.projectForm.help")}</p>
            <label>{t("agile.projectForm.name")}<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={t("agile.projectForm.namePlaceholder")} autoFocus /></label>
            <label>{t("agile.projectForm.key")}<input value={projectKey} onChange={(event) => setProjectKey(event.target.value.toUpperCase())} placeholder="AUTH" /></label>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={() => setPanel("none")}>{t("common.cancel")}</button>
              <button type="submit" className="button primary" disabled={busy === "project" || !projectName.trim() || projectKey.trim().length < 2}>
                {busy === "project" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t("agile.projectForm.create")}
              </button>
            </div>
          </form>
        )}
        {panel === "sprint" && (
          <form className="ws-form" onSubmit={saveSprint}>
            <div className="ws-form-head"><div><span className="eyebrow">{sprintManageId ? "EDIT SPRINT" : "NEW SPRINT"}</span><h3>{t(sprintManageId ? "agile.sprintForm.edit" : "agile.sprintForm.title")}</h3></div><button className="icon-button" type="button" onClick={closeSprintForm}><X size={16} /></button></div>
            <p className="ws-form-help">{t("agile.sprintForm.help")}</p>
            <label>{t("agile.sprintForm.name")}<input value={sprintName} onChange={(event) => setSprintName(event.target.value)} placeholder="Sprint 1" autoFocus /></label>
            <label>{t("agile.sprintForm.goal")}<input value={sprintGoal} onChange={(event) => setSprintGoal(event.target.value)} placeholder={t("agile.sprintForm.goalPlaceholder")} /></label>
            <div className="agile-form-row">
              <label>{t("agile.sprintForm.startDate")}<input type="date" value={sprintStart} onChange={(event) => setSprintStart(event.target.value)} /></label>
              <label>{t("agile.sprintForm.endDate")}<input type="date" value={sprintEnd} onChange={(event) => setSprintEnd(event.target.value)} /></label>
            </div>
            <label>{t("agile.sprintForm.status")}
              <select value={sprintFormStatus} onChange={(event) => setSprintFormStatus(event.target.value as SprintStatus)}>
                {SPRINT_STATUSES.map((value) => <option key={value} value={value}>{t(sprintStatusKey(value))}</option>)}
              </select>
            </label>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={closeSprintForm}>{t("common.cancel")}</button>
              <button type="submit" className="button primary" disabled={busy === "sprint" || !sprintName.trim()}>
                {busy === "sprint" ? <LoaderCircle className="spin" size={15} /> : sprintManageId ? <Save size={15} /> : <Plus size={15} />}
                {t(sprintManageId ? "common.save" : "agile.projectForm.create")}
              </button>
            </div>
          </form>
        )}
        {panel === "story" && (
          <form className="ws-form" onSubmit={saveStory}>
            <div className="ws-form-head"><div><span className="eyebrow">{storyManageId ? "EDIT STORY" : "NEW STORY"}</span><h3>{t(storyManageId ? "agile.storyForm.edit" : "agile.storyForm.title")}</h3></div><button className="icon-button" type="button" onClick={closeStoryForm}><X size={16} /></button></div>
            <label>{t("agile.storyForm.titleField")}<input value={storyTitle} onChange={(event) => setStoryTitle(event.target.value)} placeholder={t("agile.storyForm.titlePlaceholder")} autoFocus /></label>
            <div className="field-block">
              <div className="requirement-authoring-head">
                <span>{t("agile.storyForm.description")}</span>
                <RequirementAssistant
                  draft={storyRequirementDraft}
                  title={storyTitle}
                  models={models}
                  context={{ source: "story", projectName: selectedProject?.name, workspaceName: selectedStoryWorkspace?.name }}
                  onApply={(refinement) => {
                    setStoryTitle(refinement.spec.title);
                    setStoryDescription(renderRequirementStoryDescription(refinement.spec, locale));
                    setStoryCriteria(renderAcceptanceCriteria(refinement.spec));
                    setStoryDod(refinement.spec.definitionOfDone.join("\n"));
                  }}
                />
              </div>
              <textarea rows={3} value={storyDescription} onChange={(event) => setStoryDescription(event.target.value)} placeholder={t("agile.storyForm.descriptionPlaceholder")} />
            </div>
            <label>{t("agile.storyForm.criteria")}<textarea rows={3} value={storyCriteria} onChange={(event) => setStoryCriteria(event.target.value)} placeholder={t("agile.storyForm.criteriaPlaceholder")} /></label>
            <label>{t("agile.storyForm.dod")}<textarea rows={2} value={storyDod} onChange={(event) => setStoryDod(event.target.value)} placeholder={t("agile.storyForm.dodPlaceholder")} /></label>
            <div className="agile-form-row">
              <label>{t("agile.storyForm.priority")}
                <select value={storyPriority} onChange={(event) => setStoryPriority(event.target.value as StoryPriority)}>
                  {STORY_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}
                </select>
              </label>
              <label>{t("agile.storyForm.estimate")}
                <select value={storyEstimate} onChange={(event) => setStoryEstimate(event.target.value)}>
                  <option value="">{t("agile.estimate.none")}</option>
                  {STORY_ESTIMATES.map((value) => <option key={value} value={value}>{estimateLabel(value, locale)}</option>)}
                </select>
              </label>
            </div>
            <div className="agile-form-row">
              <label>{t("agile.storyForm.workspace")}
                <select value={storyWorkspace} onChange={(event) => setStoryWorkspace(event.target.value)}>
                  <option value="">{t("agile.notSpecified")}</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
              <label>{t("agile.storyForm.sprint")}
                <select value={storySprint} onChange={(event) => setStorySprint(event.target.value)}>
                  <option value="">{t("agile.unassignedTodo")}</option>
                  {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
                </select>
              </label>
            </div>
            <div className="agile-form-row">
              <label>{t("agile.storyForm.template")}
                <select value={storyTemplate} onChange={(event) => applyStoryTemplate(event.target.value)}>
                  <option value="">{t("agile.storyForm.templateNone")}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name} · {template.developerModel.model} / {template.reviewerModel.model}</option>
                  ))}
                </select>
              </label>
              <label>{t("agile.storyForm.maxParallel")}
                <input inputMode="numeric" value={storyMaxParallel} onChange={(event) => setStoryMaxParallel(event.target.value)} placeholder={t("agile.storyForm.defaultPlaceholder")} />
              </label>
            </div>
            <div className="agile-form-row">
              <label>{t("agile.storyForm.developerModel")}
                <select value={storyDeveloper} onChange={(event) => setStoryDeveloper(event.target.value)}>
                  <option value="">{t("agile.storyForm.defaultOption")}</option>
                  {(models?.models ?? []).filter((entry) => entry.roles.includes("developer")).map((entry) => (
                    <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                  ))}
                </select>
              </label>
              <label>{t("agile.storyForm.reviewerModel")}
                <select value={storyReviewer} onChange={(event) => setStoryReviewer(event.target.value)}>
                  <option value="">{t("agile.storyForm.defaultOption")}</option>
                  {(models?.models ?? []).filter((entry) => entry.roles.includes("reviewer")).map((entry) => (
                    <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="agile-form-row agile-budget-row">
              <label>{t("agile.storyForm.budgetTokens")}<input inputMode="numeric" value={budgetTokens} onChange={(event) => setBudgetTokens(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
              <label>{t("agile.storyForm.budgetCost")}<input inputMode="decimal" value={budgetCost} onChange={(event) => setBudgetCost(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
              <label>{t("agile.storyForm.budgetCalls")}<input inputMode="numeric" value={budgetCalls} onChange={(event) => setBudgetCalls(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
              <label>{t("agile.storyForm.budgetSeconds")}<input inputMode="numeric" value={budgetSeconds} onChange={(event) => setBudgetSeconds(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
            </div>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={closeStoryForm}>{t("common.cancel")}</button>
              <button type="submit" className="button primary" disabled={busy === "story" || storyTitle.trim().length < 2}>
                {busy === "story" ? <LoaderCircle className="spin" size={15} /> : storyManageId ? <Save size={15} /> : <Plus size={15} />}
                {t(storyManageId ? "common.save" : "agile.storyForm.createStory")}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
