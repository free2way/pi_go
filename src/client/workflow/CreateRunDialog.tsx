import { AlertTriangle, Code2, LoaderCircle, Play, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeError } from "../../shared/i18n";
import { useT } from "../i18n";
import type { ConfigStatus, ModelCatalogResponse, Run, RunMode, Workspace } from "../../shared/types";
import type { ModelTemplate } from "../../shared/agile";
import { api } from "../api";
import { requirementSummary } from "../requirement-history";
import { buildRoleModelOptions, modelOptionText, preferredModelId, roleUncovered } from "../model-options";
import { isModelSelectableForRole } from "../../shared/model-select";
import { RequirementAssistant } from "../RequirementAssistant";

export function CreateRunDialog({ open, onClose, onCreated, config, recentRuns, onGoWorkspaces }: {
  open: boolean;
  onClose: () => void;
  onCreated: (run: Run) => void;
  config?: ConfigStatus;
  recentRuns: Run[];
  onGoWorkspaces: () => void;
}) {
  const { t, locale } = useT();
  const [title, setTitle] = useState(() => t("createRun.demoTitle"));
  const [repository, setRepository] = useState("demo/auth-service");
  const [task, setTask] = useState(() => t("createRun.demoTask"));
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [mode, setMode] = useState<RunMode>("demo");
  const [checks, setChecks] = useState("npm test");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [models, setModels] = useState<ModelCatalogResponse>();
  const [developerModelId, setDeveloperModelId] = useState("");
  const [reviewerModelId, setReviewerModelId] = useState("");
  const [templates, setTemplates] = useState<ModelTemplate[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !config?.realRunsAvailable) return;
    void api.templates().then((result) => setTemplates(result.templates)).catch(() => undefined);
    void Promise.all([api.workspaces(), api.models()]).then(([workspaceResult, modelResult]) => {
      const active = workspaceResult.workspaces.filter((item) => item.status === "active");
      setWorkspaces(active);
      setModels(modelResult);
      const preferred = active.find((item) => !item.git?.dirty) ?? active[0];
      if (preferred) {
        setWorkspaceId(preferred.id);
        if (preferred.defaultChecks.length > 0) setChecks(preferred.defaultChecks.join("\n"));
      }
      const pick = (selection: { provider: string; model: string }, role: "developer" | "reviewer") => {
        // AUD-09: only default to a pair the run preflight will accept; an
        // unusable catalogue entry stays visible (disabled) in the select but is
        // never preselected. Falls back to the exact default when it is usable.
        return preferredModelId(modelResult.models, role, selection);
      };
      setDeveloperModelId(pick(modelResult.defaultDeveloper, "developer"));
      setReviewerModelId(pick(modelResult.defaultReviewer, "reviewer"));
    }).catch((cause) => setError(localizeError(locale, cause as { code?: string; message?: string })));
  }, [open, config?.realRunsAvailable, locale]);

  if (!open) return null;
  // AUD-09: options come from the shared predicate, so the dialog can only offer
  // pairs the run preflight accepts; unusable entries stay visible but disabled
  // with the reason (never silently hidden).
  const developerOptions = buildRoleModelOptions(models?.models, "developer", locale);
  const reviewerOptions = buildRoleModelOptions(models?.models, "reviewer", locale);
  const developerUsable = developerOptions.some((option) => option.id === developerModelId && option.selectable);
  const reviewerUsable = reviewerOptions.some((option) => option.id === reviewerModelId && option.selectable);
  const developerUncovered = roleUncovered(models?.models, "developer");
  const reviewerUncovered = roleUncovered(models?.models, "reviewer");
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedDirty = Boolean(selectedWorkspace?.git?.dirty);
  const selectWorkspace = (nextId: string) => {
    setWorkspaceId(nextId);
    const next = workspaces.find((item) => item.id === nextId);
    if (next) setChecks(next.defaultChecks.join("\n") || "npm test");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const developer = models?.models.find((entry) => entry.id === developerModelId);
      const reviewer = models?.models.find((entry) => entry.id === reviewerModelId);
      const run = await api.createRun({
        title,
        task,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        mode,
        ...(mode === "real"
          ? {
              workspaceId,
              checks: checks.split("\n").map((item) => item.trim()).filter(Boolean),
              developerModel: developer ? { provider: developer.provider, model: developer.model } : undefined,
              reviewerModel: reviewer ? { provider: reviewer.provider, model: reviewer.model } : undefined,
            }
          : { repository, checks: [] }),
      }, { locale });
      onCreated(run);
      onClose();
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal create-run-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><span className="eyebrow">NEW WORKFLOW</span><h2>{t("createRun.title")}</h2></div>
          <button className="icon-button" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mode-picker">
          <button type="button" className={mode === "demo" ? "active" : ""} onClick={() => { setMode("demo"); setRepository("demo/auth-service"); }}><Sparkles size={14} />{t("createRun.modeDemo")}</button>
          <button type="button" className={mode === "real" ? "active" : ""} disabled={!config?.realRunsAvailable} onClick={() => setMode("real")}><Code2 size={14} />{t("createRun.modeReal")}</button>
        </div>
        <div className="demo-notice">
          {mode === "demo" ? <><Sparkles size={16} />{t("createRun.demoNotice")}</> : <><ShieldCheck size={16} />{t("createRun.realNotice")}</>}
        </div>
        <label>{t("createRun.name")}<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {mode === "real" ? (
          workspaces.length === 0 ? (
            <div className="workspace-empty-notice">
              <AlertTriangle size={15} />
              <div><strong>{t("createRun.noWorkspaces")}</strong><span>{t("createRun.noWorkspacesHint")}</span></div>
              <button type="button" className="button secondary" onClick={onGoWorkspaces}>{t("createRun.goWorkspaces")}</button>
            </div>
          ) : (
            <>
              <label>{t("createRun.workspace")}<select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name} · {workspace.git?.branch || "—"}{workspace.git?.dirty ? t("createRun.dirtySuffix") : ""}
                  </option>
                ))}
              </select></label>
              {templates.length > 0 && (
                <label>{t("createRun.template")}
                  <select value="" onChange={(event) => {
                    const template = templates.find((item) => item.id === event.target.value);
                    if (!template || !models) return;
                    const match = (selection: { provider: string; model: string }, role: "developer" | "reviewer") =>
                      // AUD-09: a template may pin a pair this deployment cannot
                      // preflight; never apply it silently — leave the current
                      // (selectable) choice so the disabled option explains why.
                      models.models.find((entry) => entry.roles.includes(role) && entry.provider === selection.provider && entry.model === selection.model && isModelSelectableForRole(entry, role))?.id;
                    const developer = match(template.developerModel, "developer");
                    const reviewer = match(template.reviewerModel, "reviewer");
                    if (developer) setDeveloperModelId(developer);
                    if (reviewer) setReviewerModelId(reviewer);
                  }}>
                    <option value="">{t("createRun.templatePlaceholder")}</option>
                    {templates.map((template) => (
                      <option value={template.id} key={template.id}>
                        {template.name} · {template.developerModel.model} / {template.reviewerModel.model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>{t("createRun.developerModel")}<select value={developerModelId} onChange={(event) => setDeveloperModelId(event.target.value)}>
                {developerOptions.map((option) => (
                  <option value={option.id} key={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>
                ))}
              </select></label>
              {developerUncovered && <div className="form-error">{t("createRun.modelRoleUncovered")}</div>}
              <label>{t("createRun.reviewerModel")}<select value={reviewerModelId} onChange={(event) => setReviewerModelId(event.target.value)}>
                {reviewerOptions.map((option) => (
                  <option value={option.id} key={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>
                ))}
              </select></label>
              {reviewerUncovered && <div className="form-error">{t("createRun.modelRoleUncovered")}</div>}
              {selectedDirty && (
                <div className="dirty-warning">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>{t("createRun.dirtyTitle")}</strong>
                    <span>{t("createRun.dirtyHint")}</span>
                    {selectedWorkspace?.git?.dirtyFiles?.length ? <code>{selectedWorkspace.git.dirtyFiles.slice(0, 5).join(" · ")}{selectedWorkspace.git.dirtyFiles.length > 5 ? " …" : ""}</code> : null}
                  </div>
                </div>
              )}
            </>
          )
        ) : <label>{t("createRun.repository")}<input value={repository} onChange={(event) => setRepository(event.target.value)} /></label>}
        <div className="field-block">
          <div className="requirement-authoring-head">
            <span>{t("createRun.task")}</span>
            <RequirementAssistant
              draft={task}
              title={title}
              models={models}
              context={{ source: "run", workspaceName: selectedWorkspace?.name || repository }}
              onApply={(refinement) => {
                setTitle(refinement.spec.title);
                setTask(refinement.task);
                setAcceptanceCriteria(refinement.acceptanceCriteria);
              }}
            />
          </div>
          <textarea rows={5} value={task} onChange={(event) => { setTask(event.target.value); setAcceptanceCriteria(""); }} />
        </div>
        {mode === "real" && <label className="create-run-checks">{t("createRun.checks")}<textarea rows={4} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="npm test" /></label>}
        {recentRuns.length > 0 && (
          <details className="recent-requirements">
            <summary><span className="eyebrow">{t("createRun.recent")}</span></summary>
            <div className="recent-list">
              {recentRuns.slice(0, 5).map((item) => (
                <button
                  type="button"
                  className="recent-item"
                  key={item.id}
                  title={requirementSummary(item.task, 300)}
                  onClick={() => { setTitle(item.title); setTask(item.task); setAcceptanceCriteria(item.acceptanceCriteria ?? ""); }}
                >
                  <strong>{item.title}</strong>
                  <small>{requirementSummary(item.task, 70)}</small>
                </button>
              ))}
            </div>
          </details>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="button primary" disabled={submitting || (mode === "real" && (!workspaceId || selectedDirty || !developerUsable || !reviewerUsable))}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{t(mode === "real" ? "createRun.submitReal" : "createRun.submitDemo")}
          </button>
        </div>
      </form>
    </div>
  );
}
