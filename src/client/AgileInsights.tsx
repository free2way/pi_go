import { BarChart3, LayoutTemplate, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { STORY_STATUSES } from "../shared/agile";
import { storyStatusKey } from "./agile-view";
import { formatDuration } from "./agile-format";
import type { AgilePageState } from "./useAgilePage";

export function AgileInsights({ state }: { state: AgilePageState["insights"] }) {
  const {
    panel, t, createTemplate, templateName, setTemplateName, templateDeveloper, setTemplateDeveloper,
    models, templateReviewer, setTemplateReviewer, templateBudgetTokens, setTemplateBudgetTokens,
    templateBudgetCost, setTemplateBudgetCost, templateBudgetCalls, setTemplateBudgetCalls,
    templateBudgetSeconds, setTemplateBudgetSeconds, templateMaxParallel, setTemplateMaxParallel, busy,
    templates, removeTemplate, metricsSprintId, setMetricsSprintId, sprints, metricsLoading,
    metricsView, locale, metrics,
  } = state;

  return (
    <>
      {panel === "templates" && (
        <section className="panel agile-metrics agile-templates">
          <div className="panel-head"><div><span className="eyebrow">MODEL TEMPLATES</span><h3>{t("agile.template.title")}</h3></div><LayoutTemplate size={15} /></div>
          <div className="agile-metrics-body">
            <form className="ws-form" onSubmit={createTemplate}>
              <div className="ws-form-head"><div><span className="eyebrow">NEW TEMPLATE</span><h3>{t("agile.template.new")}</h3></div></div>
              <p className="ws-form-help">{t("agile.template.help")}</p>
              <label>{t("agile.template.name")}<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t("agile.template.namePlaceholder")} autoFocus /></label>
              <div className="agile-form-row">
                <label>{t("agile.storyForm.developerModel")}
                  <select value={templateDeveloper} onChange={(event) => setTemplateDeveloper(event.target.value)}>
                    <option value="">{t("agile.template.pleaseSelect")}</option>
                    {(models?.models ?? []).filter((entry) => entry.roles.includes("developer")).map((entry) => (
                      <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                    ))}
                  </select>
                </label>
                <label>{t("agile.storyForm.reviewerModel")}
                  <select value={templateReviewer} onChange={(event) => setTemplateReviewer(event.target.value)}>
                    <option value="">{t("agile.template.pleaseSelect")}</option>
                    {(models?.models ?? []).filter((entry) => entry.roles.includes("reviewer")).map((entry) => (
                      <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="agile-form-row agile-budget-row">
                <label>{t("agile.storyForm.budgetTokens")}<input inputMode="numeric" value={templateBudgetTokens} onChange={(event) => setTemplateBudgetTokens(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
                <label>{t("agile.storyForm.budgetCost")}<input inputMode="decimal" value={templateBudgetCost} onChange={(event) => setTemplateBudgetCost(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
                <label>{t("agile.storyForm.budgetCalls")}<input inputMode="numeric" value={templateBudgetCalls} onChange={(event) => setTemplateBudgetCalls(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
                <label>{t("agile.storyForm.budgetSeconds")}<input inputMode="numeric" value={templateBudgetSeconds} onChange={(event) => setTemplateBudgetSeconds(event.target.value)} placeholder={t("agile.storyForm.unlimited")} /></label>
              </div>
              <div className="agile-form-row">
                <label>{t("agile.template.maxParallel")}<input inputMode="numeric" value={templateMaxParallel} onChange={(event) => setTemplateMaxParallel(event.target.value)} placeholder={t("agile.template.maxParallelPlaceholder")} /></label>
                <span />
              </div>
              <div className="ws-form-actions">
                <button type="submit" className="button primary" disabled={busy === "template" || !templateName.trim() || !templateDeveloper || !templateReviewer}>
                  {busy === "template" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t("agile.template.create")}
                </button>
              </div>
            </form>
            <div className="agile-manage-list">
              <h4>{t("agile.template.existing", { count: templates.length })}</h4>
              {templates.map((template) => (
                <div className="agile-release-row" key={template.id}>
                  <span>{template.name}</span>
                  <code>{template.developerModel.provider}:{template.developerModel.model} / {template.reviewerModel.provider}:{template.reviewerModel.model}</code>
                  <small>{template.budget ? t("agile.template.budget", { cost: template.budget.maxCostUsd, tokens: template.budget.maxTokens }) : t("agile.template.noBudget")}{template.maxParallel !== null ? ` · ${t("agile.template.parallel", { count: template.maxParallel })}` : ""}</small>
                  <button type="button" className="danger" disabled={busy === `delete-template:${template.id}`} onClick={() => void removeTemplate(template)}><Trash2 size={12} />{t("common.delete")}</button>
                </div>
              ))}
              {templates.length === 0 && <div className="agile-hint">{t("agile.template.empty")}</div>}
            </div>
          </div>
        </section>
      )}

      {panel === "metrics" && (
        <section className="panel agile-metrics">
          <div className="panel-head"><div><span className="eyebrow">SPRINT METRICS</span><h3>{t("agile.metrics.title")}</h3></div><BarChart3 size={15} /></div>
          <div className="agile-metrics-body">
            <div className="agile-toolbar">
              <label>{t("agile.sprint")}
                <select value={metricsSprintId} onChange={(event) => setMetricsSprintId(event.target.value)}>
                  <option value="">{t("agile.metrics.projectSummary")}</option>
                  {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
                </select>
              </label>
              <span className="agile-hint">{t("agile.metrics.hint")}</span>
            </div>
            {metricsLoading && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>{t("agile.metrics.loading")}</span></div>}
            {!metricsLoading && !metricsView && <div className="agile-hint">{t("agile.metrics.empty")}</div>}
            {!metricsLoading && metricsView && (
              <>
                <div className="metrics-grid agile-metrics-grid">
                  <div className="metric"><span>{t("agile.metrics.completedStories")}</span><strong>{metricsView.stories.completed}/{metricsView.stories.total}</strong><small>{t("agile.metrics.completedHint")}</small></div>
                  <div className="metric"><span>{t("agile.metrics.reworkRate")}</span><strong>{(metricsView.rework.rate * 100).toFixed(0)}%</strong><small>{t("agile.metrics.reworked", { reworked: metricsView.rework.reworked, completed: metricsView.rework.completed })}</small></div>
                  <div className="metric"><span>{t("agile.metrics.costPerStory")}</span><strong>${metricsView.costPerCompletedStory.toFixed(3)}</strong><small>{t("agile.metrics.totalCost", { cost: metricsView.usage.cost.toFixed(3) })}</small></div>
                  <div className="metric"><span>{t("agile.metrics.cycleMedianP90")}</span><strong>{formatDuration(metricsView.cycleTime.medianSeconds, locale)} / {formatDuration(metricsView.cycleTime.p90Seconds, locale)}</strong><small>{t("agile.metrics.samples", { count: metricsView.cycleTime.samples })}</small></div>
                </div>
                <div className="agile-metrics-cols">
                  <div>
                    <h4>{t("agile.metrics.storyStatus")}</h4>
                    {STORY_STATUSES.map((status) => (
                      <div className="agile-metrics-row" key={status}><span>{t(storyStatusKey(status))}</span><strong>{metricsView.stories.byStatus[status]}</strong></div>
                    ))}
                  </div>
                  <div>
                    <h4>{t("agile.metrics.runOutcomes")}</h4>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.runCompleted")}</span><strong>{metricsView.runOutcomes.completed}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.runNeedsHuman")}</span><strong>{metricsView.runOutcomes.needs_human}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.runCancelled")}</span><strong>{metricsView.runOutcomes.cancelled}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.runFailed")}</span><strong>{metricsView.runOutcomes.failed}</strong></div>
                  </div>
                  <div>
                    <h4>{t("agile.metrics.usageAndReview")}</h4>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.modelCalls")}</span><strong>{metricsView.usage.modelCalls}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.tokensInOut")}</span><strong>{metricsView.usage.inputTokens} / {metricsView.usage.outputTokens}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.cacheRead")}</span><strong>{metricsView.usage.cacheReadTokens}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.findingsResolved")}</span><strong>{metricsView.reviewFindings.resolved}/{metricsView.reviewFindings.total}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.notConverging")}</span><strong>{metricsView.reviewFindings.notConverging}</strong></div>
                  </div>
                </div>
                {!metricsSprintId && metrics && metrics.sprints.length > 1 && (
                  <div className="agile-metrics-sprints">
                    <h4>{t("agile.metrics.sprints")}</h4>
                    <div className="agile-metrics-row agile-metrics-head"><span>{t("agile.metrics.col.sprint")}</span><strong>{t("agile.metrics.col.completedTotal")}</strong><strong>{t("agile.metrics.col.cycleMedian")}</strong><strong>{t("agile.metrics.col.reworkRate")}</strong><strong>{t("agile.metrics.col.cost")}</strong></div>
                    {metrics.sprints.map((sprint) => (
                      <button type="button" className="agile-metrics-row" key={sprint.sprintId} onClick={() => setMetricsSprintId(sprint.sprintId)}>
                        <span>{sprint.name}</span>
                        <strong>{sprint.stories.completed}/{sprint.stories.total}</strong>
                        <strong>{formatDuration(sprint.cycleTime.medianSeconds, locale)}</strong>
                        <strong>{(sprint.rework.rate * 100).toFixed(0)}%</strong>
                        <strong>${sprint.usage.cost.toFixed(3)}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}
