import { useCallback, useEffect, useMemo, useState } from "react";
import { localizeError } from "../shared/i18n";
import { useT } from "./i18n";
import {
  type AgileProject,
  type AgileRelease,
  type AgileSprint,
  type AgileStory,
  type ModelTemplate,
  type ReleaseStatus,
  type SprintStatus,
  type StoryDetail,
  type StoryStatus,
} from "../shared/agile";
import type { AgileMetricsResponse, ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import type { ModelCatalogResponse, Workspace } from "../shared/types";
import { api } from "./api";
import { agileFormErrorMessage, buildReleaseInput, buildSprintInput, buildTemplateInput, sprintToFormValues } from "./agile-forms";
import { groupStoriesByColumn, releaseExportFilename, releaseExportJson } from "./agile-view";
import type { ConfigStatus } from "../shared/types";
import { useAgileStoryForm } from "./useAgileStoryForm";

export function useAgilePage(config?: ConfigStatus) {
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

  const {
    saveStory, storyManageId, storyTitle, setStoryTitle, setStoryDescription, setStoryCriteria,
    setStoryDod, storyDescription, storyCriteria, storyDod, storyPriority, setStoryPriority,
    storyEstimate, setStoryEstimate, storyWorkspace, setStoryWorkspace, storySprint, setStorySprint,
    storyTemplate, storyMaxParallel, setStoryMaxParallel, storyDeveloper, setStoryDeveloper,
    storyReviewer, setStoryReviewer, budgetTokens, setBudgetTokens, budgetCost, setBudgetCost,
    budgetCalls, setBudgetCalls, budgetSeconds, setBudgetSeconds, storyRequirementDraft,
    selectedStoryWorkspace, applyStoryTemplate, resetStoryForm, closeStoryForm, editStory,
  } = useAgileStoryForm({
    projectId, locale, t, templates, workspaces, setPanel, setError, setNotice,
    setBusy, setStories, setDetail, setSelectedId,
  });

  const selectedProject = projects.find((project) => project.id === projectId);
  const progressRelease = releases.find((release) => release.id === releaseProgressId);

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

  return {
    header: {
      t, panel, setPanel, setError, setNotice, setConfirmDeleteId, projectId, resetSprintForm,
      resetStoryForm, releases,
    },
    forms: {
      panel, createProject, t, setPanel, projectName, setProjectName, projectKey, setProjectKey, busy,
      saveSprint, sprintManageId, closeSprintForm, sprintName, setSprintName, sprintGoal, setSprintGoal,
      sprintStart, setSprintStart, sprintEnd, setSprintEnd, sprintFormStatus, setSprintFormStatus,
      saveStory, storyManageId, closeStoryForm, storyTitle, setStoryTitle, storyRequirementDraft,
      models, selectedProject, selectedStoryWorkspace, setStoryDescription, locale, setStoryCriteria,
      setStoryDod, storyDescription, storyCriteria, storyDod, storyPriority, setStoryPriority,
      storyEstimate, setStoryEstimate, storyWorkspace, setStoryWorkspace, workspaces, storySprint,
      setStorySprint, sprints, storyTemplate, applyStoryTemplate, templates, storyMaxParallel,
      setStoryMaxParallel, storyDeveloper, setStoryDeveloper, storyReviewer, setStoryReviewer,
      budgetTokens, setBudgetTokens, budgetCost, setBudgetCost, budgetCalls, setBudgetCalls,
      budgetSeconds, setBudgetSeconds,
    },
    board: {
      panel, t, projects, locale, confirmDeleteId, setConfirmDeleteId, busy, confirmDeleteProject,
      setError, error, notice, loading, projectId, setProjectId, sprintFilter, setSprintFilter, sprints,
      selectedProject, columns, selectedId, setSelectedId, sprintLabel, editStory, blockStory,
      unblockStory, visibleStories, patchStatus, removeStory, editSprint, setSprintStatus, releases,
      setReleaseDetailId, setPanel,
    },
    insights: {
      panel, t, createTemplate, templateName, setTemplateName, templateDeveloper, setTemplateDeveloper,
      models, templateReviewer, setTemplateReviewer, templateBudgetTokens, setTemplateBudgetTokens,
      templateBudgetCost, setTemplateBudgetCost, templateBudgetCalls, setTemplateBudgetCalls,
      templateBudgetSeconds, setTemplateBudgetSeconds, templateMaxParallel, setTemplateMaxParallel,
      busy, templates, removeTemplate, metricsSprintId, setMetricsSprintId, sprints, metricsLoading,
      metricsView, locale, metrics,
    },
    releases: {
      panel, t, releaseDetailId, setReleaseDetailId, releases, releaseSummary, releaseRetrospective,
      releaseExporting, exportRetrospective, setReleaseExportNote, releaseExportNote, locale,
      releaseLoading, saveRelease, releaseManageId, resetReleaseForm, releaseVersion, setReleaseVersion,
      releaseName, setReleaseName, releaseStatus, setReleaseStatus, releaseStoryIds, releaseNotes,
      setReleaseNotes, stories, toggleReleaseStory, busy, openReleaseProgress, openPublish, editRelease,
      removeRelease, publishTarget, closePublish, publishError, publishBlocked, publishBusy,
      publishReady, publishEnvironment, setPublishEnvironment, publishNote, setPublishNote,
      confirmPublish, releaseProgressOpen, progressRelease, releaseProgressError,
      setReleaseProgressOpen,
    },
    detail: {
      detail, t, locale, sprintLabel, workspaces, editStory, busy, patchStatus, blockStory,
      unblockStory, reopenStory, submit,
    },
  };
}

export type AgilePageState = ReturnType<typeof useAgilePage>;
