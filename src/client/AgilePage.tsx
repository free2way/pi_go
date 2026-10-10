import { Activity, ArrowUpRight, Check, CircleDot, FolderCog, BarChart3, ClipboardList, Copy, Download, LayoutTemplate, ListChecks, LoaderCircle, Pencil, Plus, Rocket, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, intlLocale, localizeError, t, type Locale, type MessageKey } from "../shared/i18n";
import { useT } from "./i18n";
import { runStateKey } from "./requirement-history";
import { applyModelTemplate, RELEASE_STATUSES, SPRINT_STATUSES, STORY_PRIORITIES, STORY_STATUSES, type AgileProject, type AgileRelease, type AgileSprint, type AgileStory, type ModelTemplate, type ReleaseDeployRecord, type ReleaseStatus, type SprintStatus, type StoryDetail, type StoryPriority, type StoryStatus } from "../shared/agile";
import type { AgileMetricsResponse, ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import type { ConfigStatus, ModelCatalogResponse, Workspace } from "../shared/types";
import { renderAcceptanceCriteria, renderRequirementStoryDescription } from "../shared/requirement-assistant";
import { api } from "./api";
import { agileFormErrorMessage, buildReleaseInput, buildSprintInput, buildStoryInput, buildTemplateInput, sprintToFormValues, storyToFormValues, STORY_ESTIMATES } from "./agile-forms";
import { agileReleaseProgressView, boardColumnKey, columnPoints, estimateLabel, groupStoriesByColumn, priorityKey, priorityLabel, RELEASE_DEPLOY_ACTION_KEYS, releaseDeployAction, releaseExportFilename, releaseExportJson, storyReference, storyStatusKey , projectContentsLabel, projectDeletionWarning, type AgileReleaseProgressState } from "./agile-view";
import { browserDeploymentUrl } from "./release-progress";
import { RequirementAssistant } from "./RequirementAssistant";

/** Catalog key for the sprint/release/deploy badges (labels live in the catalog). */
const sprintStatusKey = (status: AgileSprint["status"]): MessageKey => `agile.sprintStatus.${status}` as MessageKey;
const releaseStatusKey = (status: AgileRelease["status"]): MessageKey => `agile.releaseStatus.${status}` as MessageKey;
const deployStatusKey = (status: ReleaseDeployRecord["status"]): MessageKey => `agile.deployStatus.${status}` as MessageKey;

const formatTime = (value: string, locale: Locale = DEFAULT_LOCALE) =>
  new Intl.DateTimeFormat(intlLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

/** Compact human duration for cycle times (seconds in). */
function formatDuration(seconds: number, locale: Locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds >= 86_400) return t(locale, "agile.duration.days", { value: (seconds / 86_400).toFixed(1) });
  if (seconds >= 3_600) return t(locale, "agile.duration.hours", { value: (seconds / 3_600).toFixed(1) });
  if (seconds >= 60) return t(locale, "agile.duration.minutes", { value: Math.round(seconds / 60) });
  return t(locale, "agile.duration.seconds", { value: Math.round(seconds) });
}

function AgileReleaseProgressDialog({ open, release, error, onClose }: {
  open: boolean;
  release?: AgileRelease;
  error: string;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const [, setClock] = useState(0);
  const deploy = release?.deploy;
  const view = agileReleaseProgressView(deploy);
  const startedAt = deploy?.startedAt ?? deploy?.at;
  const elapsedMs = startedAt
    ? Math.max(0, (deploy?.finishedAt ? Date.parse(deploy.finishedAt) : Date.now()) - Date.parse(startedAt))
    : 0;
  const deploymentUrl = browserDeploymentUrl(deploy?.url);

  useEffect(() => {
    if (!open || view.status !== "running") return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [open, view.status]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open || !release) return null;
  const stepIcon = (state: AgileReleaseProgressState) => state === "done"
    ? <Check size={12} />
    : state === "failed"
      ? <X size={12} />
      : state === "active"
        ? <LoaderCircle className="spin" size={12} />
        : <CircleDot size={11} />;
  const stepLabel = (state: AgileReleaseProgressState) => t(state === "active"
    ? "release.progress.running"
    : state === "done"
      ? "release.progress.done"
      : state === "failed"
        ? "release.progress.failed"
        : "release.progress.waiting");

  return (
    <aside className="release-progress-window" role="dialog" aria-modal="false" aria-labelledby="agile-release-progress-title">
      <div className="release-progress-head">
        <div>
          <span className="eyebrow">AGILE RELEASE</span>
          <h3 id="agile-release-progress-title">{t("agile.publish.title", { version: release.version, name: release.name })}</h3>
        </div>
        <div className="release-progress-head-actions">
          <span className={`release-progress-status is-${view.status}`}>{view.status === "running" && <i />}{t(`release.progress.status.${view.status}`)}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("release.progress.close")} title={t("release.progress.close")}><X size={16} /></button>
        </div>
      </div>
      <div className="release-progress-summary">
        <div><span>{t("agile.releaseManage.version")}</span><strong>{release.version}</strong></div>
        <div><span>{t("release.environment")}</span><strong>{deploy?.environment ?? "—"}</strong></div>
        <div><span>attempt</span><strong>{deploy?.attempt ?? "—"}</strong></div>
        <div><span>{t("release.progress.elapsed")}</span><strong>{startedAt ? formatDuration(elapsedMs / 1_000, locale) : "—"}</strong></div>
      </div>
      <div className="release-progress-body">
        <ol className="release-progress-timeline">
          <li className={`is-${view.request}`}><span>{stepIcon(view.request)}</span><div><strong>{t("release.progress.request")}</strong><small>{deploy?.deliveryId ?? t("release.progress.requesting")}</small></div></li>
          <li className={`is-${view.registration}`}><span>{stepIcon(view.registration)}</span><div><strong>{t("agile.publish.progress.registration")}</strong><small>{view.registration === "active" ? t("agile.publish.progress.registrationHelp") : stepLabel(view.registration)}</small></div></li>
          <li className={`is-${view.result}`}><span>{stepIcon(view.result)}</span><div><strong>{t("release.progress.result")}</strong><small>{deploy?.detail ?? t(view.status === "running" ? "release.progress.awaitingResult" : "release.progress.waiting")}</small></div></li>
        </ol>
        {deploy && (
          <div className="release-progress-log">
            <div><span>{t("release.progress.events")}</span><small>{t(deploy.status === "pending" ? "release.progress.awaitingResult" : `release.progress.status.${view.status}`)}</small></div>
            <p><time>{formatTime(deploy.at, locale)}</time><span>{deploy.detail}</span></p>
          </div>
        )}
      </div>
      {error ? <div className="form-error release-progress-error">{error}</div> : null}
      <div className="release-progress-actions">
        <button type="button" className="button secondary" onClick={onClose}>{t("release.progress.close")}</button>
        {deploymentUrl && <a className="button secondary" href={deploymentUrl} target="_blank" rel="noreferrer">{t("release.viewDeploy")}<ArrowUpRight size={13} /></a>}
      </div>
      <p className="release-progress-footnote">{t("release.progress.closeHint")}</p>
    </aside>
  );
}

/** Sprint 3 batch 1: project/story planning on top of the existing run engine. */
export function AgilePage({ config, onOpenRun }: { config?: ConfigStatus; onOpenRun: (runId: string) => void }) {
  const { t, locale } = useT();
  const [projects, setProjects] = useState<AgileProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [stories, setStories] = useState<AgileStory[]>([]);
  const [sprints, setSprints] = useState<AgileSprint[]>([]);
  const [releases, setReleases] = useState<AgileRelease[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [detail, setDetail] = useState<StoryDetail>();
  const [selectedId, setSelectedId] = useState("");
  const [sprintFilter, setSprintFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<"none" | "project" | "sprint" | "story" | "metrics" | "release" | "templates" | "releases" | "manage">("none");
  /** 正在二次确认删除的项目 id（空 = 没有待确认的删除）。 */
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  /** 成功类提示（与 error 分开：删除成功不该显示成错误）。 */
  const [notice, setNotice] = useState("");
  const [templates, setTemplates] = useState<ModelTemplate[]>([]);
  const [models, setModels] = useState<ModelCatalogResponse>();
  const [metrics, setMetrics] = useState<AgileMetricsResponse>();
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsSprintId, setMetricsSprintId] = useState("");
  // Sprint 4 core: release detail panel (summary + retrospective export).
  const [releaseDetailId, setReleaseDetailId] = useState("");
  const [releaseSummary, setReleaseSummary] = useState<ReleaseSummary>();
  const [releaseRetrospective, setReleaseRetrospective] = useState<ReleaseRetrospective>();
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseExporting, setReleaseExporting] = useState(false);
  const [releaseExportNote, setReleaseExportNote] = useState("");

  // 模板管理 form (create) + delete feedback.
  const [templateName, setTemplateName] = useState("");
  const [templateDeveloper, setTemplateDeveloper] = useState("");
  const [templateReviewer, setTemplateReviewer] = useState("");
  const [templateBudgetTokens, setTemplateBudgetTokens] = useState("");
  const [templateBudgetCost, setTemplateBudgetCost] = useState("");
  const [templateBudgetCalls, setTemplateBudgetCalls] = useState("");
  const [templateBudgetSeconds, setTemplateBudgetSeconds] = useState("");
  const [templateMaxParallel, setTemplateMaxParallel] = useState("");

  // 发布管理: `releaseManageId` empty = create mode, otherwise the edited release.
  const [releaseManageId, setReleaseManageId] = useState("");
  const [releaseName, setReleaseName] = useState("");
  const [releaseVersion, setReleaseVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatus>("planned");
  const [releaseStoryIds, setReleaseStoryIds] = useState<string[]>([]);

  // 发布动作: the confirmation dialog holds the release being published plus the
  // guard result (blocked stories) from the dry-run preview.
  const [publishTarget, setPublishTarget] = useState<AgileRelease>();
  const [publishBlocked, setPublishBlocked] = useState<Array<{ storyId: string; title: string; reason: string }>>([]);
  const [publishReady, setPublishReady] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [publishEnvironment, setPublishEnvironment] = useState<"staging" | "production">("staging");
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [releaseProgressId, setReleaseProgressId] = useState("");
  const [releaseProgressOpen, setReleaseProgressOpen] = useState(false);
  const [releaseProgressError, setReleaseProgressError] = useState("");

  // new-project form
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  // new-sprint form — `sprintManageId` empty = create mode, otherwise the edited sprint.
  const [sprintManageId, setSprintManageId] = useState("");
  const [sprintName, setSprintName] = useState("");
  const [sprintGoal, setSprintGoal] = useState("");
  const [sprintStart, setSprintStart] = useState("");
  const [sprintEnd, setSprintEnd] = useState("");
  const [sprintFormStatus, setSprintFormStatus] = useState<SprintStatus>("planned");
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

  const selectedProject = projects.find((project) => project.id === projectId);
  const progressRelease = releases.find((release) => release.id === releaseProgressId);
  const selectedStoryWorkspace = workspaces.find((workspace) => workspace.id === storyWorkspace);
  const storyRequirementDraft = [
    storyDescription.trim(),
    storyCriteria.trim() ? `${locale === "en" ? "Current acceptance criteria" : "当前验收条件"}:\n${storyCriteria.trim()}` : "",
    storyDod.trim() ? `${locale === "en" ? "Current definition of done" : "当前完成定义"}:\n${storyDod.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  const loadProjects = useCallback(async () => {
    setError("");
    try {
      const result = await api.agileProjects();
      setProjects(result.projects);
      setProjectId((current) => current || result.projects[0]?.id || "");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadProjects")));
    } finally {
      setLoading(false);
    }
  }, [locale, t]);

  const loadProjectData = useCallback(async (id: string) => {
    try {
      const [storyResult, sprintResult, releaseResult] = await Promise.all([api.agileStories({ projectId: id }), api.sprints(id), api.releases(id)]);
      setStories(storyResult.stories);
      setSprints(sprintResult.sprints);
      setReleases(releaseResult.releases);
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadStories")));
    }
  }, [locale, t]);

  useEffect(() => {
    void loadProjects();
    void api.workspaces().then((result) => setWorkspaces(result.workspaces)).catch(() => undefined);
    void api.templates().then((result) => setTemplates(result.templates)).catch(() => undefined);
    void api.models().then(setModels).catch(() => undefined);
  }, [loadProjects]);
  useEffect(() => {
    setSelectedId("");
    setDetail(undefined);
    setReleaseDetailId("");
    setReleaseSummary(undefined);
    setReleaseRetrospective(undefined);
    // 发布管理 form is project-scoped; drop the draft when switching projects.
    setReleaseManageId("");
    setReleaseName("");
    setReleaseVersion("");
    setReleaseNotes("");
    setReleaseStatus("planned");
    setReleaseStoryIds([]);
    setPublishTarget(undefined);
    setPublishBlocked([]);
    setPublishReady(false);
    setPublishError("");
    setReleaseProgressId("");
    setReleaseProgressOpen(false);
    setReleaseProgressError("");
    if (projectId) void loadProjectData(projectId);
    else { setStories([]); setSprints([]); setReleases([]); }
  }, [projectId, loadProjectData]);

  const refreshReleases = useCallback(async () => {
    if (!projectId) return;
    const result = await api.releases(projectId);
    setReleases(result.releases);
  }, [projectId]);

  useEffect(() => {
    if (!releaseProgressOpen || !releaseProgressId || progressRelease?.deploy?.status !== "pending") return;
    let stopped = false;
    const refresh = async () => {
      try {
        await refreshReleases();
        if (!stopped) setReleaseProgressError("");
      } catch (cause) {
        if (!stopped) setReleaseProgressError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadStories")));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [releaseProgressOpen, releaseProgressId, progressRelease?.deploy?.status, refreshReleases, locale, t]);

  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let cancelled = false;
    void api.story(selectedId)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((cause) => { if (!cancelled) setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadStory"))); });
    return () => { cancelled = true; };
  }, [selectedId, locale, t]);

  // Sprint 4: 度量 panel data. Re-fetched when the panel opens or the sprint
  // picker changes; read-only and scoped to the current project.
  useEffect(() => {
    if (panel !== "metrics" || !projectId) return;
    let cancelled = false;
    setMetricsLoading(true);
    void api.agileMetrics({ projectId, sprintId: metricsSprintId || undefined })
      .then((result) => { if (!cancelled) setMetrics(result); })
      .catch((cause) => { if (!cancelled) setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadMetrics"))); })
      .finally(() => { if (!cancelled) setMetricsLoading(false); });
    return () => { cancelled = true; };
  }, [panel, projectId, metricsSprintId, locale, t]);

  // Sprint 4 core: 发布回顾 panel data. Read-only, owner-scoped; the picker
  // defaults to the first release of the project and refetches on switch.
  useEffect(() => {
    setReleaseSummary(undefined);
    setReleaseRetrospective(undefined);
    if (panel !== "release" || !projectId) return;
    const id = releaseDetailId || releases[0]?.id || "";
    if (!id) return;
    if (!releaseDetailId) setReleaseDetailId(id);
    let cancelled = false;
    setReleaseLoading(true);
    setReleaseExportNote("");
    void Promise.all([api.releaseSummary(id), api.releaseRetrospective(id)])
      .then(([summary, retrospective]) => {
        if (cancelled) return;
        setReleaseSummary(summary);
        setReleaseRetrospective(retrospective);
      })
      .catch((cause) => { if (!cancelled) setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadRelease"))); })
      .finally(() => { if (!cancelled) setReleaseLoading(false); });
    return () => { cancelled = true; };
  }, [panel, projectId, releaseDetailId, releases, locale, t]);

  const visibleStories = useMemo(
    () => stories.filter((story) => {
      if (sprintFilter === "all") return true;
      if (sprintFilter === "none") return story.sprintId === null;
      return story.sprintId === sprintFilter;
    }),
    [stories, sprintFilter],
  );
  const columns = useMemo(() => groupStoriesByColumn(visibleStories), [visibleStories]);
  const sprintLabel = useCallback((id: string | null) => sprints.find((sprint) => sprint.id === id)?.name ?? t("agile.unassigned"), [sprints, t]);
  const metricsView = useMemo(() => {
    if (!metrics) return undefined;
    return metricsSprintId
      ? metrics.sprints.find((sprint) => sprint.sprintId === metricsSprintId)
      : metrics.projects.find((project) => project.projectId === projectId);
  }, [metrics, metricsSprintId, projectId]);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("project");
    setError("");
    try {
      const project = await api.createAgileProject({ name: projectName.trim(), key: projectKey.trim() });
      setProjects((current) => [project, ...current]);
      setProjectId(project.id);
      setProjectName("");
      setProjectKey("");
      setPanel("none");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.createProject")));
    } finally {
      setBusy("");
    }
  };

  /**
   * 删除项目：服务端在一个事务里级联清理（story_runs → stories → sprints → releases → 项目），
   * 因此先做二次确认，确认文案里如实列出会一并删掉的数量（计数来自项目列表接口）。
   */
  const confirmDeleteProject = async (project: AgileProject) => {
    setBusy("delete-project");
    setError("");
    setNotice("");
    try {
      await api.agileDeleteProject(project.id);
      const result = await api.agileProjects();
      setProjects(result.projects);
      if (projectId === project.id) setProjectId(result.projects[0]?.id ?? "");
      setConfirmDeleteId("");
      setNotice(t("agile.manage.deleted", { name: project.name }));
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.deleteProject")));
    } finally {
      setBusy("");
    }
  };

  // 冲刺表单: create + edit share one form (`sprintManageId` decides POST vs PATCH),
  // mirroring 「发布管理」. Every field is sent, so clearing goal/dates sticks
  // (server: omitted = keep, `null`/`""` = clear).
  const resetSprintForm = () => {
    setSprintManageId("");
    setSprintName("");
    setSprintGoal("");
    setSprintStart("");
    setSprintEnd("");
    setSprintFormStatus("planned");
  };

  const closeSprintForm = () => {
    resetSprintForm();
    setPanel("none");
  };

  const editSprint = (sprint: AgileSprint) => {
    const values = sprintToFormValues(sprint);
    setSprintManageId(sprint.id);
    setSprintName(values.name);
    setSprintGoal(values.goal);
    setSprintStart(values.startDate);
    setSprintEnd(values.endDate);
    setSprintFormStatus(values.status);
    setPanel("sprint");
    setError("");
  };

  const saveSprint = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError(t("agile.error.selectProjectFirst")); return; }
    const built = buildSprintInput({ name: sprintName, goal: sprintGoal, startDate: sprintStart, endDate: sprintEnd, status: sprintFormStatus }, locale);
    if (!built.ok) { setError(built.message); return; }
    const editing = sprintManageId !== "";
    setBusy("sprint");
    setError("");
    try {
      if (editing) {
        const updated = await api.patchSprint(sprintManageId, built.input);
        setSprints((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        setNotice(t("agile.sprintForm.updated"));
      } else {
        const sprint = await api.createSprint({ projectId, ...built.input });
        setSprints((current) => [sprint, ...current]);
      }
      closeSprintForm();
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t(editing ? "agile.error.patchSprint" : "agile.error.createSprint"), locale));
    } finally {
      setBusy("");
    }
  };

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

  // 模板管理: create + delete owner-scoped saved model combinations ("模板").
  // Client validation mirrors the zod contract; the server is still the source
  // of truth, and a duplicate name surfaces its 409 as 「模板名称 … 已存在」.
  const createTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    const built = buildTemplateInput({
      name: templateName,
      developerModel: templateDeveloper,
      reviewerModel: templateReviewer,
      budgetTokens: templateBudgetTokens,
      budgetCostUsd: templateBudgetCost,
      budgetModelCalls: templateBudgetCalls,
      budgetDurationSeconds: templateBudgetSeconds,
      maxParallel: templateMaxParallel,
    }, locale);
    if (!built.ok) { setError(built.message); return; }
    setBusy("template");
    setError("");
    try {
      const template = await api.createTemplate({ ...built.input, maxParallel: built.input.maxParallel ?? null });
      setTemplates((current) => [template, ...current]);
      setTemplateName("");
      setTemplateDeveloper("");
      setTemplateReviewer("");
      setTemplateBudgetTokens("");
      setTemplateBudgetCost("");
      setTemplateBudgetCalls("");
      setTemplateBudgetSeconds("");
      setTemplateMaxParallel("");
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.createTemplate"), locale));
    } finally {
      setBusy("");
    }
  };

  const removeTemplate = async (template: ModelTemplate) => {
    if (!window.confirm(t("agile.template.deleteConfirm", { name: template.name }))) return;
    setBusy(`delete-template:${template.id}`);
    setError("");
    try {
      await api.deleteTemplate(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.deleteTemplate"), locale));
    } finally {
      setBusy("");
    }
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

  const patchStatus = async (story: AgileStory, status: StoryStatus) => {
    setBusy(`status:${story.id}`);
    setError("");
    try {
      const updated = await api.patchStory(story.id, { status });
      setStories((current) => current.map((item) => (item.id === story.id ? updated : item)));
      if (selectedId === story.id) setDetail((current) => (current ? { ...current, ...updated } : current));
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.patchStatus")));
    } finally {
      setBusy("");
    }
  };

  const submit = async (story: StoryDetail) => {
    const mode = config?.realRunsAvailable ? "real" : "demo";
    if (mode === "real" && !window.confirm(t("agile.detail.submitConfirm", { title: story.title }))) return;
    setBusy(`submit:${story.id}`);
    setError("");
    try {
      const result = await api.submitStory(story.id, { mode, workspaceId: story.workspaceId ?? undefined });
      setDetail(result.story);
      setStories((current) => current.map((item) => (item.id === result.story.id ? result.story : item)));
      setSelectedId(result.story.id);
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.submitStory")));
    } finally {
      setBusy("");
    }
  };

  const removeStory = async (story: AgileStory) => {
    if (!window.confirm(t("agile.detail.deleteConfirm", { title: story.title }))) return;
    setBusy(`delete:${story.id}`);
    try {
      await api.deleteStory(story.id);
      setStories((current) => current.filter((item) => item.id !== story.id));
      if (selectedId === story.id) { setSelectedId(""); setDetail(undefined); }
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.deleteStory")));
    } finally {
      setBusy("");
    }
  };

  const setSprintStatus = async (sprint: AgileSprint, status: AgileSprint["status"]) => {
    setBusy(`sprint:${sprint.id}`);
    try {
      const updated = await api.patchSprint(sprint.id, { status });
      setSprints((current) => current.map((item) => (item.id === sprint.id ? updated : item)));
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.patchSprint")));
    } finally {
      setBusy("");
    }
  };

  // 发布管理: create/edit a release and attach/detach project stories. No
  // drag-and-drop; membership is a checkbox list committed with the form.
  const resetReleaseForm = () => {
    setReleaseManageId("");
    setReleaseName("");
    setReleaseVersion("");
    setReleaseNotes("");
    setReleaseStatus("planned");
    setReleaseStoryIds([]);
  };

  const editRelease = (release: AgileRelease) => {
    setReleaseManageId(release.id);
    setReleaseName(release.name);
    setReleaseVersion(release.version);
    setReleaseNotes(release.notes);
    setReleaseStatus(release.status);
    setReleaseStoryIds([...release.storyIds]);
    setError("");
  };

  const saveRelease = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError(t("agile.error.selectProjectFirst")); return; }
    const built = buildReleaseInput({ name: releaseName, version: releaseVersion, notes: releaseNotes, status: releaseStatus, storyIds: releaseStoryIds }, locale);
    if (!built.ok) { setError(built.message); return; }
    const editing = releaseManageId !== "";
    setBusy("release");
    setError("");
    try {
      if (editing) {
        const updated = await api.patchRelease(releaseManageId, built.input);
        setReleases((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } else {
        const created = await api.createRelease({ projectId, ...built.input });
        setReleases((current) => [created, ...current]);
      }
      resetReleaseForm();
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t(editing ? "agile.error.updateRelease" : "agile.error.createRelease"), locale));
    } finally {
      setBusy("");
    }
  };

  const removeRelease = async (release: AgileRelease) => {
    if (!window.confirm(t("agile.releaseManage.deleteConfirm", { version: release.version, name: release.name }))) return;
    setBusy(`delete-release:${release.id}`);
    setError("");
    try {
      await api.deleteRelease(release.id);
      setReleases((current) => current.filter((item) => item.id !== release.id));
      if (releaseManageId === release.id) resetReleaseForm();
      if (releaseDetailId === release.id) { setReleaseDetailId(""); setReleaseSummary(undefined); setReleaseRetrospective(undefined); }
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.deleteRelease"), locale));
    } finally {
      setBusy("");
    }
  };

  const toggleReleaseStory = (storyId: string) => {
    setReleaseStoryIds((current) => (current.includes(storyId) ? current.filter((id) => id !== storyId) : [...current, storyId]));
  };

  // ------------------------------------------------- publish action (Sprint 5)
  const openPublish = async (release: AgileRelease) => {
    const targetEnvironment = release.deploy?.status === "ok" && release.deploy.environment === "staging" ? "production" : release.deploy?.environment === "production" ? "production" : "staging";
    setPublishTarget(release);
    setPublishBlocked([]);
    setPublishReady(false);
    setPublishNote("");
    setPublishEnvironment(targetEnvironment);
    setPublishError("");
    setPublishBusy(true);
    try {
      const preview = await api.publishRelease(release.id, { environment: targetEnvironment });
      setPublishTarget(preview.release);
      setPublishReady(true);
    } catch (cause) {
      const error = cause as { message?: string; body?: { blocked?: Array<{ storyId: string; title: string; reason: string }> } };
      setPublishBlocked(error.body?.blocked ?? []);
      setPublishError(localizeError(locale, error, t("agile.error.publishPreview")));
    } finally {
      setPublishBusy(false);
    }
  };

  const closePublish = () => {
    setPublishTarget(undefined);
    setPublishBlocked([]);
    setPublishReady(false);
    setPublishError("");
  };

  const openReleaseProgress = (release: AgileRelease) => {
    setReleaseProgressId(release.id);
    setReleaseProgressError("");
    setReleaseProgressOpen(true);
    void refreshReleases().catch((cause) => {
      setReleaseProgressError(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.loadStories")));
    });
  };

  const confirmPublish = async () => {
    if (!publishTarget) return;
    setPublishBusy(true);
    setPublishError("");
    try {
      const result = await api.publishRelease(publishTarget.id, {
        confirm: true,
        environment: publishEnvironment,
        // An existing deploy record means this confirm is a retry (failed or
        // timed-out attempt); the server still refuses a non-stale `pending` one.
        retry: publishTarget.deploy != null,
        ...(publishNote.trim() ? { note: publishNote.trim() } : {}),
      });
      setReleases((current) => current.map((item) => (item.id === result.release.id ? result.release : item)));
      setReleaseProgressId(result.release.id);
      setReleaseProgressError("");
      setReleaseProgressOpen(true);
      closePublish();
    } catch (cause) {
      const error = cause as { message?: string; body?: { blocked?: Array<{ storyId: string; title: string; reason: string }> } };
      setPublishBlocked(error.body?.blocked ?? []);
      setPublishError(localizeError(locale, error, t("agile.error.publish")));
    } finally {
      setPublishBusy(false);
    }
  };

  // ------------------------------------------------ Kanban blocked-management
  const blockStory = async (story: AgileStory) => {
    const reason = window.prompt(t("agile.detail.blockPrompt", { title: story.title }), "");
    if (reason === null) return;
    if (!reason.trim()) { setError(t("agile.detail.blockReasonRequired")); return; }
    setBusy(`block:${story.id}`);
    setError("");
    try {
      const updated = await api.blockStory(story.id, reason.trim());
      setStories((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDetail((current) => (current && current.id === updated.id ? updated : current));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.block"), locale));
    } finally {
      setBusy("");
    }
  };

  const unblockStory = async (story: AgileStory) => {
    setBusy(`unblock:${story.id}`);
    setError("");
    try {
      const updated = await api.unblockStory(story.id);
      setStories((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDetail((current) => (current && current.id === updated.id ? updated : current));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.unblock"), locale));
    } finally {
      setBusy("");
    }
  };

  // Explicit reopen of a story whose latest run is terminal failed/cancelled.
  // Never silently lifts a manual block or a parked run (the server 409s).
  const reopenStory = async (story: AgileStory) => {
    setBusy(`reopen:${story.id}`);
    setError("");
    try {
      const updated = await api.reopenStory(story.id);
      setStories((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDetail((current) => (current && current.id === updated.id ? updated : current));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, t("agile.error.reopen"), locale));
    } finally {
      setBusy("");
    }
  };

  // 「导出回顾 (JSON)」: downloads the retrospective payload and best-effort
  // copies it to the clipboard. No secrets are present in these datasets.
  const exportRetrospective = async () => {
    if (!releaseSummary || !releaseRetrospective) return;
    setReleaseExporting(true);
    setReleaseExportNote("");
    try {
      const json = releaseExportJson({ summary: releaseSummary, retrospective: releaseRetrospective });
      const filename = releaseExportFilename(releaseSummary);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(json);
          copied = true;
        }
      } catch {
        copied = false;
      }
      setReleaseExportNote(t(copied ? "agile.releaseExport.copied" : "agile.releaseExport.downloaded", { filename }));
    } catch (cause) {
      setReleaseExportNote(localizeError(locale, cause as { code?: string; message?: string }, t("agile.error.export")));
    } finally {
      setReleaseExporting(false);
    }
  };

  // 打开上方表单面板时滚到可见处：这些面板在按钮行下方，而「编辑」入口分布在
  // 故事列表 / 详情面板（页面中部到尾部），不滚动就会被当成"点了没反应"。
  useEffect(() => {
    if (panel !== "story" && panel !== "sprint" && panel !== "project") return;
    document.querySelector(".ws-forms")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [panel, storyManageId, sprintManageId]);

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">AGILE PLANNING</span>
          <h1>{t("nav.agile")}</h1>
          <p>{t("agile.subtitle")}</p>
        </div>
        <div className="ws-heading-actions">
          <button className={`button secondary ${panel === "manage" ? "active" : ""}`} onClick={() => { setPanel(panel === "manage" ? "none" : "manage"); setError(""); setNotice(""); setConfirmDeleteId(""); }}><FolderCog size={15} />{t("agile.manageProjects")}</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "project" ? "none" : "project"); setError(""); }}><Plus size={15} />{t("agile.newProject")}</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { if (panel === "sprint") { setPanel("none"); } else { resetSprintForm(); setPanel("sprint"); setError(""); } }}><Plus size={15} />{t("agile.newSprint")}</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { if (panel === "story") { setPanel("none"); } else { resetStoryForm(); setPanel("story"); setError(""); } }}><Plus size={15} />{t("agile.newStory")}</button>
          <button className={`button secondary ${panel === "templates" ? "active" : ""}`} onClick={() => { setPanel(panel === "templates" ? "none" : "templates"); setError(""); }}><LayoutTemplate size={15} />{t("agile.templates")}</button>
          <button className={`button secondary ${panel === "metrics" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "metrics" ? "none" : "metrics"); setError(""); }}><BarChart3 size={15} />{t("agile.metrics")}</button>
          <button className={`button secondary ${panel === "release" ? "active" : ""}`} disabled={!projectId || releases.length === 0} onClick={() => { setPanel(panel === "release" ? "none" : "release"); setError(""); }}><Rocket size={15} />{t("agile.releaseReview")}</button>
          <button className={`button secondary ${panel === "releases" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "releases" ? "none" : "releases"); setError(""); }}><Pencil size={15} />{t("agile.releaseManage")}</button>
        </div>
      </section>

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

      {panel === "manage" && (
        <section className="panel agile-metrics">
          <div className="panel-head"><div><span className="eyebrow">PROJECT MANAGEMENT</span><h3>{t("agile.manageProjects")}</h3></div><FolderCog size={15} /></div>
          <div className="agile-metrics-body">
            <p className="agile-hint">{t("agile.manage.hint")}</p>
            {projects.length === 0 ? (
              <div className="agile-hint">{t("agile.manage.empty")}</div>
            ) : (
              <div className="agile-release-list">
                {projects.map((project) => (
                  <div className="agile-manage-row" key={project.id}>
                    <main>
                      <div><b>{project.name}</b><code>{project.key}</code></div>
                      <span className="agile-hint">{projectContentsLabel(project, locale)}</span>
                      {confirmDeleteId === project.id && (
                        <span className="agile-manage-warning">{projectDeletionWarning(project, locale)}</span>
                      )}
                    </main>
                    <div className="agile-manage-actions">
                      {confirmDeleteId === project.id ? (
                        <>
                          <button type="button" className="button secondary" onClick={() => setConfirmDeleteId("")}>{t("agile.manage.cancel")}</button>
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy === "delete-project"}
                            onClick={() => void confirmDeleteProject(project)}
                          >
                            {busy === "delete-project" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                            {t("agile.manage.deleteConfirm")}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="button secondary" onClick={() => { setConfirmDeleteId(project.id); setError(""); }}>
                          <Trash2 size={15} />{t("agile.manage.delete")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}


      {error && <div className="form-error">{error}</div>}
      {notice && <div className="demo-notice">{notice}</div>}
      {loading && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("agile.loading")}</span></div>}
      {!loading && projects.length === 0 && (
        <div className="ws-empty"><ClipboardList size={26} /><strong>{t("agile.noProjects")}</strong><span>{t("agile.noProjectsHint")}</span></div>
      )}

      {projects.length > 0 && (
        <>
          <div className="agile-toolbar">
            <label>{t("agile.project")}
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}
              </select>
            </label>
            <label>{t("agile.sprint")}
              <select value={sprintFilter} onChange={(event) => setSprintFilter(event.target.value)}>
                <option value="all">{t("agile.all")}</option>
                <option value="none">{t("agile.unassigned")}</option>
                {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name} · {t(sprintStatusKey(sprint.status))}</option>)}
              </select>
            </label>
            {selectedProject?.description && <span className="agile-hint">{selectedProject.description}</span>}
          </div>

          <section className="panel agile-board">
            <div className="panel-head"><div><span className="eyebrow">SPRINT BOARD</span><h3>{t("agile.board.title")}</h3></div><ListChecks size={15} /></div>
            <div className="agile-columns">
              {columns.map((column) => (
                <div className="agile-column" key={column.id}>
                  <header><span>{t(boardColumnKey(column.id))}</span><em>{column.stories.length}{columnPoints(column) > 0 ? ` · ${t("agile.points", { count: columnPoints(column) })}` : ""}</em></header>
                  {column.stories.map((story) => (
                    <div key={story.id} className={`agile-card ${selectedId === story.id ? "selected" : ""}`}>
                      <button type="button" className="agile-card-main" onClick={() => setSelectedId(story.id)}>
                        <strong>{story.title}</strong>
                        <span className="agile-card-meta">
                          <em className={`agile-priority priority-${story.priority}`}>{t(priorityKey(story.priority))}</em>
                          <small>{estimateLabel(story.estimate, locale)}</small>
                        </span>
                        <small className="agile-card-sprint">{sprintLabel(story.sprintId)}</small>
                      </button>
                      {story.status === "blocked" && (
                        <span className="agile-blocked-badge" title={story.blockedReason ?? t("agile.blocked")}>
                          {story.blockedReason ? t("agile.blockedWithReason", { reason: story.blockedReason }) : t("agile.blocked")}
                        </span>
                      )}
                      <div className="agile-card-actions">
                        <button type="button" onClick={() => editStory(story)}>{t("common.edit")}</button>
                        {story.status !== "blocked"
                          ? <button type="button" disabled={busy === `block:${story.id}`} onClick={() => void blockStory(story)}>{t("agile.block")}</button>
                          : <button type="button" disabled={busy === `unblock:${story.id}`} onClick={() => void unblockStory(story)}>{t("agile.unblock")}</button>}
                      </div>
                    </div>
                  ))}
                  {column.stories.length === 0 && <div className="agile-column-empty">{t("agile.none")}</div>}
                </div>
              ))}
            </div>
          </section>

          <div className="agile-grid">
            <section className="panel">
              <div className="panel-head"><div><span className="eyebrow">STORY LIST</span><h3>{t("agile.storyList.title")}</h3></div><ClipboardList size={15} /></div>
              <div className="agile-story-list">
                {visibleStories.map((story, index) => (
                  <div className={`agile-story-row ${selectedId === story.id ? "selected" : ""}`} key={story.id}>
                    <button type="button" className="agile-story-main" onClick={() => setSelectedId(story.id)}>
                      <code>{storyReference(selectedProject?.key ?? "STORY", index)}</code>
                      <span><strong>{story.title}</strong><small>{t(storyStatusKey(story.status))} · {sprintLabel(story.sprintId)}</small></span>
                    </button>
                    <div className="agile-story-actions">
                      <button type="button" disabled={busy === `status:${story.id}`} onClick={() => editStory(story)}>{t("common.edit")}</button>
                      {story.status !== "ready" && <button type="button" disabled={busy === `status:${story.id}`} onClick={() => void patchStatus(story, "ready")}>{t("agile.markReady")}</button>}
                      <button type="button" className="danger" disabled={busy === `delete:${story.id}`} onClick={() => void removeStory(story)}><Trash2 size={12} /></button>
                    </div>
                  </div>
                ))}
                {visibleStories.length === 0 && <div className="ws-empty"><span>{t("agile.emptyFiltered")}</span></div>}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head"><div><span className="eyebrow">SPRINTS &amp; RELEASES</span><h3>{t("agile.sprintsReleases.title")}</h3></div><Rocket size={15} /></div>
              <div className="agile-sprint-list">
                {sprints.map((sprint) => (
                  <div className="agile-sprint-row" key={sprint.id}>
                    <span><strong>{sprint.name}</strong><small>{t(sprintStatusKey(sprint.status))}{sprint.goal ? ` · ${sprint.goal}` : ""}</small></span>
                    <div>
                      <button type="button" onClick={() => editSprint(sprint)}>{t("common.edit")}</button>
                      {sprint.status !== "active" && <button type="button" disabled={busy === `sprint:${sprint.id}`} onClick={() => void setSprintStatus(sprint, "active")}>{t("agile.sprint.start")}</button>}
                      {sprint.status === "active" && <button type="button" disabled={busy === `sprint:${sprint.id}`} onClick={() => void setSprintStatus(sprint, "closed")}>{t("agile.sprint.close")}</button>}
                    </div>
                  </div>
                ))}
                {sprints.length === 0 && <div className="agile-hint">{t("agile.sprint.empty")}</div>}
              </div>
              <div className="agile-release-list">
                {releases.map((release) => (
                  <div className="agile-release-row" key={release.id}>
                    <code>{release.version}</code>
                    <span>{release.name}</span>
                    <small>{t(releaseStatusKey(release.status))} · {t("agile.storyCount", { count: release.storyIds.length })}</small>
                    <button type="button" onClick={() => { setReleaseDetailId(release.id); setPanel("release"); setError(""); }}>{t("agile.review")}</button>
                  </div>
                ))}
                {releases.length === 0 && <div className="agile-hint">{t("agile.release.empty")}</div>}
              </div>
            </section>
          </div>
        </>
      )}


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

      {panel === "release" && (
        <section className="panel agile-metrics agile-release">
          <div className="panel-head"><div><span className="eyebrow">RELEASE SUMMARY</span><h3>{t("agile.releaseReview.title")}</h3></div><Rocket size={15} /></div>
          <div className="agile-metrics-body">
            <div className="agile-toolbar">
              <label>{t("agile.releaseReview.release")}
                <select value={releaseDetailId} onChange={(event) => setReleaseDetailId(event.target.value)}>
                  {releases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.name}</option>)}
                </select>
              </label>
              <button type="button" className="button secondary" disabled={!releaseSummary || !releaseRetrospective || releaseExporting} onClick={() => void exportRetrospective()}>
                {releaseExporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{t("agile.releaseReview.export")}
              </button>
              <button type="button" className="button secondary" disabled={!releaseSummary || !releaseRetrospective} onClick={() => { void navigator.clipboard?.writeText(releaseExportJson({ summary: releaseSummary!, retrospective: releaseRetrospective! })).then(() => setReleaseExportNote(t("agile.releaseReview.copiedClipboard"))).catch(() => setReleaseExportNote(t("agile.releaseReview.copyFailed"))); }}>
                <Copy size={15} />{t("common.copy")}
              </button>
              <span className="agile-hint">{t("agile.releaseReview.hint")}</span>
            </div>
            {releaseExportNote && <div className="agile-hint">{releaseExportNote}</div>}
            {releaseSummary && (
              <div className="agile-metrics-sprints">
                <h4>{t("agile.releaseReview.status")}</h4>
                <div className="agile-metrics-row">
                  <span>{t(releaseStatusKey(releaseSummary.status))}{releaseSummary.releasedAt ? ` · ${t("agile.releaseReview.releasedBy", { time: formatTime(releaseSummary.releasedAt, locale), name: releaseSummary.releasedBy ?? t("common.unknown") })}` : ` · ${t("agile.releaseReview.notReleased")}`}</span>
                  <strong>{releaseSummary.deploy ? (releaseSummary.deploy.detail ? t("agile.releaseReview.deployedDetail", { status: t(deployStatusKey(releaseSummary.deploy.status)), detail: releaseSummary.deploy.detail }) : t("agile.releaseReview.deployed", { status: t(deployStatusKey(releaseSummary.deploy.status)) })) : t("agile.releaseReview.noDeploy")}</strong>
                </div>
              </div>
            )}
            {releaseLoading && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>{t("agile.releaseReview.loading")}</span></div>}
            {!releaseLoading && releases.length === 0 && <div className="agile-hint">{t("agile.releaseReview.empty")}</div>}
            {!releaseLoading && releaseSummary && releaseRetrospective && (
              <>
                <div className="metrics-grid agile-metrics-grid">
                  <div className="metric"><span>{t("agile.metrics.completedStories")}</span><strong>{releaseSummary.totals.done}/{releaseSummary.totals.stories}</strong><small>{t("agile.releaseReview.notStarted", { count: releaseSummary.totals.notStarted })}</small></div>
                  <div className="metric"><span>{t("agile.releaseReview.inProgress")}</span><strong>{releaseSummary.totals.inProgress}</strong><small>{t("agile.releaseReview.inProgressHint")}</small></div>
                  <div className="metric"><span>{t("agile.releaseReview.blocked")}</span><strong>{releaseSummary.totals.blocked}</strong><small>{t("agile.releaseReview.linkedRuns", { count: releaseSummary.totals.runs })}</small></div>
                  <div className="metric"><span>{t("agile.metrics.costPerStory")}</span><strong>${releaseRetrospective.costPerCompletedStory.toFixed(3)}</strong><small>{t("agile.metrics.totalCost", { cost: releaseSummary.usage.cost.toFixed(3) })}</small></div>
                </div>
                <div className="agile-metrics-cols">
                  <div>
                    <h4>{t("agile.releaseReview.cycleAndRework")}</h4>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.cycleMedian")}</span><strong>{formatDuration(releaseRetrospective.cycleTime.medianSeconds, locale)}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.cycleP90")}</span><strong>{formatDuration(releaseRetrospective.cycleTime.p90Seconds, locale)}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.cycleSamples")}</span><strong>{releaseRetrospective.cycleTime.samples}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.reworkRate")}</span><strong>{(releaseRetrospective.rework.rate * 100).toFixed(0)}%</strong></div>
                  </div>
                  <div>
                    <h4>{t("agile.releaseReview.usage")}</h4>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.modelCalls")}</span><strong>{releaseSummary.usage.modelCalls}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.tokensInOut")}</span><strong>{releaseSummary.usage.inputTokens} / {releaseSummary.usage.outputTokens}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.cacheRead")}</span><strong>{releaseSummary.usage.cacheReadTokens}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.linkedRunsLabel")}</span><strong>{releaseSummary.usage.runs}</strong></div>
                  </div>
                  <div>
                    <h4>{t("agile.releaseReview.review")}</h4>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.findingsResolved")}</span><strong>{releaseRetrospective.reviewFindings.resolved}/{releaseRetrospective.reviewFindings.total}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.returnedEvents")}</span><strong>{releaseRetrospective.reviewTrend.reduce((count, point) => count + point.changesRequested, 0)}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.releaseReview.notConvergingRuns")}</span><strong>{releaseRetrospective.notConvergingRuns}</strong></div>
                    <div className="agile-metrics-row"><span>{t("agile.metrics.notConverging")}</span><strong>{releaseRetrospective.reviewFindings.notConverging}</strong></div>
                  </div>
                </div>

                <div className="agile-metrics-sprints">
                  <h4>{t("agile.releaseReview.storyResults")}</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>{t("agile.releaseReview.col.story")}</span><strong>{t("agile.releaseReview.col.status")}</strong><strong>{t("agile.releaseReview.col.runsRounds")}</strong><strong>{t("agile.releaseReview.col.findings")}</strong><strong>{t("agile.releaseReview.col.cost")}</strong></div>
                  {releaseSummary.stories.map((story) => (
                    <div className="agile-metrics-row" key={story.storyId}>
                      <span>{story.title}{story.acceptance ? ` · ${t("agile.releaseReview.accepted")}` : ""}{story.blockedReason ? ` · ${story.blockedReason}` : ""}</span>
                      <strong>{t(storyStatusKey(story.status))}</strong>
                      <strong>{story.runs}{story.latest ? ` · ${t("agile.releaseReview.roundOf", { round: story.latest.round, max: story.latest.maxRounds })}` : ""}</strong>
                      <strong>{story.findings.resolved}/{story.findings.total}</strong>
                      <strong>${story.cost.toFixed(4)}</strong>
                    </div>
                  ))}
                  {releaseSummary.stories.length === 0 && <div className="agile-hint">{t("agile.releaseReview.noStories")}</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>{t("agile.releaseReview.modelCombos")}</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>{t("agile.releaseReview.col.devReview")}</span><strong>{t("agile.releaseReview.col.runs")}</strong><strong>{t("agile.releaseReview.col.story")}</strong><strong /><strong /></div>
                  {releaseSummary.modelCombinations.map((combo) => (
                    <div className="agile-metrics-row" key={`${combo.developer.provider}::${combo.developer.model}|${combo.reviewer.provider}::${combo.reviewer.model}`}>
                      <span>{combo.developer.provider}:{combo.developer.model} / {combo.reviewer.provider}:{combo.reviewer.model}</span>
                      <strong>{combo.runs}</strong>
                      <strong>{combo.stories}</strong>
                      <strong />
                      <strong />
                    </div>
                  ))}
                  {releaseSummary.modelCombinations.length === 0 && <div className="agile-hint">{t("agile.releaseReview.noCombos")}</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>{t("agile.releaseReview.mergeDeploy")}</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>{t("agile.releaseReview.col.runs")}</span><strong>{t("agile.releaseReview.col.type")}</strong><strong>{t("agile.releaseReview.col.target")}</strong><strong>{t("agile.releaseReview.col.status")}</strong><strong>{t("agile.releaseReview.col.time")}</strong></div>
                  {releaseSummary.merges.map((merge) => (
                    <div className="agile-metrics-row" key={`merge-${merge.runId}`}>
                      <span title={merge.commit}>{merge.runId.slice(0, 12)}</span>
                      <strong>{t("agile.releaseReview.merge", { strategy: merge.strategy })}</strong>
                      <strong>{merge.targetBranch}</strong>
                      <strong>{merge.commit.slice(0, 7)}</strong>
                      <strong>{formatTime(merge.mergedAt, locale)}</strong>
                    </div>
                  ))}
                  {releaseSummary.deployments.map((deploy) => (
                    <div className="agile-metrics-row" key={`deploy-${deploy.runId}-${deploy.commit}`}>
                      <span title={deploy.commit}>{deploy.runId.slice(0, 12)}</span>
                      <strong>{t("agile.releaseReview.deploy", { kind: deploy.kind })}</strong>
                      <strong>{deploy.environment}</strong>
                      <strong>{deploy.status}{deploy.url ? ` · ${deploy.url}` : ""}</strong>
                      <strong>{formatTime(deploy.finishedAt ?? deploy.requestedAt, locale)}</strong>
                    </div>
                  ))}
                  {releaseSummary.merges.length === 0 && releaseSummary.deployments.length === 0 && <div className="agile-hint">{t("agile.releaseReview.noMergeDeploy")}</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>{t("agile.releaseReview.reviewTrend")}</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>{t("agile.releaseReview.col.story")}</span><strong>{t("agile.metrics.findingsResolved")}</strong><strong>{t("agile.releaseReview.col.returned")}</strong><strong>{t("agile.releaseReview.col.notConverging")}</strong><strong /></div>
                  {releaseRetrospective.reviewTrend.map((point) => (
                    <div className="agile-metrics-row" key={`trend-${point.storyId}`}>
                      <span>{point.title}</span>
                      <strong>{point.resolved}/{point.total}</strong>
                      <strong>{point.changesRequested}</strong>
                      <strong>{point.notConverging}</strong>
                      <strong />
                    </div>
                  ))}
                  {releaseRetrospective.reviewTrend.length === 0 && <div className="agile-hint">{t("agile.releaseReview.noReviewRecords")}</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>{t("agile.releaseReview.blockedStories", { count: releaseRetrospective.blockedStories.length })}</h4>
                  {releaseRetrospective.blockedStories.map((story) => (
                    <div className="agile-metrics-row" key={`blocked-${story.storyId}`}>
                      <span>{story.title}</span>
                      <strong>{story.state ? `${t(runStateKey(story.state))} · ` : ""}{story.reason}</strong>
                    </div>
                  ))}
                  {releaseRetrospective.blockedStories.length === 0 && <div className="agile-hint">{t("agile.releaseReview.noBlockedStories")}</div>}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {panel === "releases" && (
        <section className="panel agile-metrics agile-release-manage">
          <div className="panel-head"><div><span className="eyebrow">RELEASE MANAGEMENT</span><h3>{t("agile.releaseManage.title")}</h3></div><Pencil size={15} /></div>
          <div className="agile-metrics-body">
            <form className="ws-form" onSubmit={saveRelease}>
              <div className="ws-form-head">
                <div><span className="eyebrow">{releaseManageId ? "EDIT RELEASE" : "NEW RELEASE"}</span><h3>{t(releaseManageId ? "agile.releaseManage.edit" : "agile.releaseManage.new")}</h3></div>
                {releaseManageId && <button className="icon-button" type="button" onClick={resetReleaseForm}><X size={16} /></button>}
              </div>
              <p className="ws-form-help">{t("agile.releaseManage.help")}</p>
              <div className="agile-form-row">
                <label>{t("agile.releaseManage.version")}<input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="v1.2.0" /></label>
                <label>{t("agile.releaseManage.name")}<input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder={t("agile.releaseManage.namePlaceholder")} /></label>
              </div>
              <div className="agile-form-row">
                <label>{t("agile.releaseManage.status")}
                  <select value={releaseStatus} onChange={(event) => setReleaseStatus(event.target.value as ReleaseStatus)}>
                    {RELEASE_STATUSES.map((value) => <option key={value} value={value}>{t(releaseStatusKey(value))}</option>)}
                  </select>
                </label>
                <span className="agile-hint agile-release-picker-hint">{t("agile.releaseManage.pickerHint", { count: releaseStoryIds.length })}</span>
              </div>
              <label>{t("agile.releaseManage.notes")}<textarea rows={2} value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder={t("agile.releaseManage.notesPlaceholder")} /></label>
              <div className="agile-release-story-picker">
                {stories.map((story) => (
                  <label className="agile-check" key={story.id}>
                    <input type="checkbox" checked={releaseStoryIds.includes(story.id)} onChange={() => toggleReleaseStory(story.id)} />
                    <span>{story.title}<small>{t(storyStatusKey(story.status))}</small></span>
                  </label>
                ))}
                {stories.length === 0 && <div className="agile-hint">{t("agile.releaseManage.noStories")}</div>}
              </div>
              <div className="ws-form-actions">
                {releaseManageId && <button type="button" className="button secondary" onClick={resetReleaseForm}>{t("agile.releaseManage.cancelEdit")}</button>}
                <button type="submit" className="button primary" disabled={busy === "release" || !releaseName.trim() || !releaseVersion.trim()}>
                  {busy === "release" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t(releaseManageId ? "common.save" : "common.create")}
                </button>
              </div>
            </form>
            <div className="agile-manage-list">
              <h4>{t("agile.releaseManage.existing", { count: releases.length })}</h4>
              {releases.map((release) => {
                // A failed or timed-out deploy stays retryable even though the
                // release itself is already marked `released`.
                const deployAction = releaseDeployAction(release.deploy);
                return (
                <div className={`agile-release-row ${releaseManageId === release.id ? "selected" : ""}`} key={release.id}>
                  <code>{release.version}</code>
                  <span>{release.name}</span>
                  <small>{release.deploy ? t("agile.releaseManage.rowMetaDeploy", { status: t(releaseStatusKey(release.status)), count: release.storyIds.length, deploy: t(deployStatusKey(release.deploy.status)) }) : t("agile.releaseManage.rowMeta", { status: t(releaseStatusKey(release.status)), count: release.storyIds.length })}</small>
                  {release.deploy && <button type="button" onClick={() => openReleaseProgress(release)}><Activity size={12} />{t("release.progress.open")}</button>}
                  <button type="button" disabled={deployAction === "done" || deployAction === "waiting"} onClick={() => void openPublish(release)}><Rocket size={12} />{t(RELEASE_DEPLOY_ACTION_KEYS[deployAction])}</button>
                  <button type="button" disabled={release.status === "released"} onClick={() => editRelease(release)}><Pencil size={12} />{t("common.edit")}</button>
                  <button type="button" className="danger" disabled={busy === `delete-release:${release.id}`} onClick={() => void removeRelease(release)}><Trash2 size={12} />{t("common.delete")}</button>
                </div>
                );
              })}
              {releases.length === 0 && <div className="agile-hint">{t("agile.releaseManage.empty")}</div>}
            </div>
          </div>
        </section>
      )}

      {publishTarget && (
        <section className="panel agile-publish-confirm">
          <div className="panel-head">
            <div><span className="eyebrow">PUBLISH RELEASE</span><h3>{t("agile.publish.title", { version: publishTarget.version, name: publishTarget.name })}</h3></div>
            <button className="icon-button" type="button" onClick={closePublish}><X size={16} /></button>
          </div>
          <p className="ws-form-help">{t("agile.publish.help")}</p>
          {publishError && <div className="form-error">{publishError}</div>}
          {publishBlocked.length > 0 && (
            <div className="agile-blocked-list">
              <strong>{t("agile.publish.blockedTitle")}</strong>
              <ul>{publishBlocked.map((item) => <li key={item.storyId}>{item.title} — {item.reason}</li>)}</ul>
            </div>
          )}
          {publishBusy && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>{t("agile.publish.validating")}</span></div>}
          {!publishBusy && publishReady && <div className="agile-hint">{t(publishTarget.deploy?.status === "failed" || releaseDeployAction(publishTarget.deploy) === "retry" ? "agile.publish.retryHint" : "agile.publish.readyHint")}</div>}
          <label>{t("release.environment")}
            <select value={publishEnvironment} onChange={(event) => setPublishEnvironment(event.target.value === "production" ? "production" : "staging")} disabled={publishBusy}>
              <option value="staging" disabled={publishTarget.deploy?.status === "ok" && publishTarget.deploy.environment === "staging"}>{t("release.environment.staging")}</option>
              <option value="production">{t("release.environment.production")}</option>
            </select>
          </label>
          <label>{t("agile.publish.note")}<textarea rows={2} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} placeholder={t("agile.publish.notePlaceholder")} /></label>
          <div className="ws-form-actions">
            <button type="button" className="button secondary" onClick={closePublish}>{t("common.cancel")}</button>
            <button type="button" className="button primary" disabled={publishBusy || !publishReady} onClick={() => void confirmPublish()}>
              {publishBusy ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}{t(releaseDeployAction(publishTarget.deploy) === "retry" ? "agile.publish.confirmRetry" : releaseDeployAction(publishTarget.deploy) === "promote" ? "agile.publish.confirmProduction" : "agile.publish.confirm")}
            </button>
          </div>
        </section>
      )}

      <AgileReleaseProgressDialog
        open={releaseProgressOpen}
        release={progressRelease}
        error={releaseProgressError}
        onClose={() => setReleaseProgressOpen(false)}
      />

      {detail && (
        <section className="panel agile-detail">
          <div className="panel-head">
            <div><span className="eyebrow">STORY DETAIL</span><h3>{detail.title}</h3></div>
            <span className={`agile-status status-${detail.status}`}>{t(storyStatusKey(detail.status))}</span>
          </div>
          <div className="agile-detail-meta">
            <div><span>{t("agile.detail.priority")}</span><strong>{t(priorityKey(detail.priority))}</strong></div>
            <div><span>{t("agile.detail.estimate")}</span><strong>{estimateLabel(detail.estimate, locale)}</strong></div>
            <div><span>{t("agile.detail.sprint")}</span><strong>{sprintLabel(detail.sprintId)}</strong></div>
            <div><span>{t("agile.detail.workspace")}</span><strong>{workspaces.find((workspace) => workspace.id === detail.workspaceId)?.name ?? t("agile.notSpecified")}</strong></div>
          </div>
          {detail.description && <p className="agile-detail-text">{detail.description}</p>}
          <div className="agile-detail-lists">
            <div><h4>{t("agile.detail.criteria")}</h4>{detail.acceptanceCriteria.length ? <ol>{detail.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ol> : <em>{t("agile.detail.notFilled")}</em>}</div>
            <div><h4>{t("agile.detail.dod")}</h4>{detail.definitionOfDone.length ? <ul>{detail.definitionOfDone.map((item, index) => <li key={index}>{item}</li>)}</ul> : <em>{t("agile.detail.notFilled")}</em>}</div>
          </div>

          <div className="agile-detail-runs">
            <h4>{t("agile.detail.linkedRuns", { count: detail.runs.length })}</h4>
            {detail.runs.length === 0 && <div className="agile-hint">{t("agile.detail.noRuns")}</div>}
            {detail.runs.map((entry) => (
              <div className="agile-run-row" key={entry.runId}>
                <button type="button" onClick={() => onOpenRun(entry.runId)}><code>{entry.runId.slice(0, 12)}</code></button>
                <span className={`agile-run-state state-${entry.state}`}>{t(runStateKey(entry.state))}</span>
                <span>{t("agile.detail.round", { round: entry.round })}</span>
                <span>{t("agile.detail.findings", { resolved: entry.findings.resolved, total: entry.findings.total })}</span>
                <span>{t("agile.detail.checks", { passed: entry.checks.passed, total: entry.checks.passed + entry.checks.failed })}</span>
                <span>{t("agile.detail.cost", { cost: entry.cost.toFixed(4) })}</span>
                <small>{formatTime(entry.updatedAt, locale)}</small>
              </div>
            ))}
          </div>

          <div className="agile-detail-actions">
            <button type="button" className="button secondary" onClick={() => editStory(detail)}><Pencil size={15} />{t("common.edit")}</button>
            {detail.status !== "ready" && detail.status !== "blocked" && <button type="button" className="button secondary" disabled={busy === `status:${detail.id}`} onClick={() => void patchStatus(detail, "ready")}>{t("agile.markReady")}</button>}
            {detail.status !== "blocked"
              ? <button type="button" className="button secondary" disabled={busy === `block:${detail.id}`} onClick={() => void blockStory(detail)}>{t("agile.block")}</button>
              : <button type="button" className="button secondary" disabled={busy === `unblock:${detail.id}`} onClick={() => void unblockStory(detail)}>{t("agile.unblock")}</button>}
            {detail.status !== "blocked" && (detail.runs[0]?.state === "failed" || detail.runs[0]?.state === "cancelled") && (
              <button type="button" className="button secondary" disabled={busy === `reopen:${detail.id}`} onClick={() => void reopenStory(detail)}>
                {busy === `reopen:${detail.id}` ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("run.reopen")}
              </button>
            )}
            <button type="button" className="button primary" disabled={detail.status !== "ready" || busy === `submit:${detail.id}`} onClick={() => void submit(detail)}>
              {busy === `submit:${detail.id}` ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}{t("agile.detail.submit")}
            </button>
            <span className="agile-hint">
              {detail.status !== "ready"
                ? t("agile.detail.hintNotReady")
                : detail.runs[0]?.state === "failed" || detail.runs[0]?.state === "cancelled"
                  ? t("agile.detail.hintReopen")
                  : config?.realRunsAvailable
                    ? t("agile.detail.hintReal")
                    : t("agile.detail.hintDemo")}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
