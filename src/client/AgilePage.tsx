import { BarChart3, ClipboardList, Copy, Download, LayoutTemplate, ListChecks, LoaderCircle, Pencil, Plus, Rocket, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyModelTemplate, RELEASE_STATUSES, STORY_PRIORITIES, STORY_STATUSES, STORY_STATUS_LABELS, type AgileProject, type AgileRelease, type AgileSprint, type AgileStory, type ModelTemplate, type ReleaseDeployRecord, type ReleaseStatus, type StoryDetail, type StoryPriority, type StoryStatus } from "../shared/agile";
import type { AgileMetricsResponse, ReleaseRetrospective, ReleaseSummary } from "../shared/agile-metrics";
import type { ConfigStatus, ModelCatalogResponse, RunState, Workspace } from "../shared/types";
import { api } from "./api";
import { agileFormErrorMessage, buildReleaseInput, buildTemplateInput, parseModelSelection } from "./agile-forms";
import { columnPoints, estimateLabel, groupStoriesByColumn, priorityLabel, releaseExportFilename, releaseExportJson, splitLines, storyReference } from "./agile-view";

const runStateLabels: Record<RunState, string> = {
  queued: "排队中",
  preparing: "准备中",
  developing: "开发中",
  checking: "检查中",
  reviewing: "审核中",
  completed: "已完成",
  needs_human: "需要人工",
  failed: "失败",
  cancelled: "已取消",
};

const sprintStatusLabels: Record<AgileSprint["status"], string> = { planned: "已计划", active: "进行中", closed: "已关闭" };
const releaseStatusLabels: Record<AgileRelease["status"], string> = { planned: "已计划", in_progress: "进行中", released: "已发布", cancelled: "已取消" };
const deployStatusLabels: Record<ReleaseDeployRecord["status"], string> = {
  not_configured: "未配置部署钩子",
  unsupported: "部署钩子类型不支持",
  ok: "部署已触发",
  failed: "部署失败",
};

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

/** Compact human duration for cycle times (seconds in). */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)} 天`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分`;
  return `${Math.round(seconds)} 秒`;
}

function parseModel(value: string): { provider: string; model: string } | undefined {
  return parseModelSelection(value);
}

/** Sprint 3 batch 1: project/story planning on top of the existing run engine. */
export function AgilePage({ config, onOpenRun }: { config?: ConfigStatus; onOpenRun: (runId: string) => void }) {
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
  const [panel, setPanel] = useState<"none" | "project" | "sprint" | "story" | "metrics" | "release" | "templates" | "releases">("none");
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
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState("");

  // new-project form
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  // new-sprint form
  const [sprintName, setSprintName] = useState("");
  const [sprintGoal, setSprintGoal] = useState("");
  // new-story form
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

  const loadProjects = useCallback(async () => {
    setError("");
    try {
      const result = await api.agileProjects();
      setProjects(result.projects);
      setProjectId((current) => current || result.projects[0]?.id || "");
    } catch (cause) {
      setError((cause as Error).message || "加载项目失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProjectData = useCallback(async (id: string) => {
    try {
      const [storyResult, sprintResult, releaseResult] = await Promise.all([api.agileStories({ projectId: id }), api.sprints(id), api.releases(id)]);
      setStories(storyResult.stories);
      setSprints(sprintResult.sprints);
      setReleases(releaseResult.releases);
    } catch (cause) {
      setError((cause as Error).message || "加载故事失败");
    }
  }, []);

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
    if (projectId) void loadProjectData(projectId);
    else { setStories([]); setSprints([]); setReleases([]); }
  }, [projectId, loadProjectData]);

  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let cancelled = false;
    void api.story(selectedId)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((cause) => { if (!cancelled) setError((cause as Error).message || "加载故事详情失败"); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Sprint 4: 度量 panel data. Re-fetched when the panel opens or the sprint
  // picker changes; read-only and scoped to the current project.
  useEffect(() => {
    if (panel !== "metrics" || !projectId) return;
    let cancelled = false;
    setMetricsLoading(true);
    void api.agileMetrics({ projectId, sprintId: metricsSprintId || undefined })
      .then((result) => { if (!cancelled) setMetrics(result); })
      .catch((cause) => { if (!cancelled) setError((cause as Error).message || "加载度量失败"); })
      .finally(() => { if (!cancelled) setMetricsLoading(false); });
    return () => { cancelled = true; };
  }, [panel, projectId, metricsSprintId]);

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
      .catch((cause) => { if (!cancelled) setError((cause as Error).message || "加载发布汇总失败"); })
      .finally(() => { if (!cancelled) setReleaseLoading(false); });
    return () => { cancelled = true; };
  }, [panel, projectId, releaseDetailId, releases]);

  const visibleStories = useMemo(
    () => stories.filter((story) => {
      if (sprintFilter === "all") return true;
      if (sprintFilter === "none") return story.sprintId === null;
      return story.sprintId === sprintFilter;
    }),
    [stories, sprintFilter],
  );
  const columns = useMemo(() => groupStoriesByColumn(visibleStories), [visibleStories]);
  const sprintLabel = useCallback((id: string | null) => sprints.find((sprint) => sprint.id === id)?.name ?? "未分配", [sprints]);
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
      setError((cause as Error).message || "创建项目失败");
    } finally {
      setBusy("");
    }
  };

  const createSprint = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError("请先创建或选择项目"); return; }
    setBusy("sprint");
    setError("");
    try {
      const sprint = await api.createSprint({ projectId, name: sprintName.trim(), goal: sprintGoal.trim() });
      setSprints((current) => [sprint, ...current]);
      setSprintName("");
      setSprintGoal("");
      setPanel("none");
    } catch (cause) {
      setError((cause as Error).message || "创建冲刺失败");
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
    });
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
      setError(agileFormErrorMessage(cause, "创建模板失败"));
    } finally {
      setBusy("");
    }
  };

  const removeTemplate = async (template: ModelTemplate) => {
    if (!window.confirm(`删除模板「${template.name}」？已使用该模板的故事不受影响。`)) return;
    setBusy(`delete-template:${template.id}`);
    setError("");
    try {
      await api.deleteTemplate(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, "删除模板失败"));
    } finally {
      setBusy("");
    }
  };

  const createStory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError("请先创建或选择项目"); return; }
    setBusy("story");
    setError("");
    const budgetGiven = [budgetTokens, budgetCost, budgetCalls, budgetSeconds].some((value) => value.trim() !== "");
    try {
      const story = await api.createStory({
        projectId,
        title: storyTitle.trim(),
        description: storyDescription.trim(),
        acceptanceCriteria: splitLines(storyCriteria),
        definitionOfDone: splitLines(storyDod),
        priority: storyPriority,
        estimate: storyEstimate ? Number(storyEstimate) : null,
        sprintId: storySprint || null,
        workspaceId: storyWorkspace || null,
        developerModel: parseModel(storyDeveloper) ?? null,
        reviewerModel: parseModel(storyReviewer) ?? null,
        ...(budgetGiven
          ? { budget: { maxTokens: Number(budgetTokens) || 0, maxCostUsd: Number(budgetCost) || 0, maxModelCalls: Number(budgetCalls) || 0, maxDurationSeconds: Number(budgetSeconds) || 0 } }
          : {}),
        ...(storyMaxParallel.trim() ? { maxParallel: Number(storyMaxParallel) } : {}),
      });
      setStories((current) => [story, ...current]);
      setStoryTitle("");
      setStoryDescription("");
      setStoryCriteria("");
      setStoryDod("");
      setStoryEstimate("");
      setStoryMaxParallel("");
      setBudgetTokens("");
      setBudgetCost("");
      setBudgetCalls("");
      setBudgetSeconds("");
      setPanel("none");
      setSelectedId(story.id);
    } catch (cause) {
      setError((cause as Error).message || "创建故事失败");
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
      setError((cause as Error).message || "更新状态失败");
    } finally {
      setBusy("");
    }
  };

  const submit = async (story: StoryDetail) => {
    const mode = config?.realRunsAvailable ? "real" : "demo";
    if (mode === "real" && !window.confirm(`将故事「${story.title}」提交为真实运行？\n\n任务文本会包含描述、验收标准与完成定义，检查命令来自所选工作区。`)) return;
    setBusy(`submit:${story.id}`);
    setError("");
    try {
      const result = await api.submitStory(story.id, { mode, workspaceId: story.workspaceId ?? undefined });
      setDetail(result.story);
      setStories((current) => current.map((item) => (item.id === result.story.id ? result.story : item)));
      setSelectedId(result.story.id);
    } catch (cause) {
      setError((cause as Error).message || "提交为运行失败");
    } finally {
      setBusy("");
    }
  };

  const removeStory = async (story: AgileStory) => {
    if (!window.confirm(`删除故事「${story.title}」？已链接的运行不会被删除，只会解除关联。`)) return;
    setBusy(`delete:${story.id}`);
    try {
      await api.deleteStory(story.id);
      setStories((current) => current.filter((item) => item.id !== story.id));
      if (selectedId === story.id) { setSelectedId(""); setDetail(undefined); }
    } catch (cause) {
      setError((cause as Error).message || "删除故事失败");
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
      setError((cause as Error).message || "更新冲刺失败");
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
    if (!projectId) { setError("请先创建或选择项目"); return; }
    const built = buildReleaseInput({ name: releaseName, version: releaseVersion, notes: releaseNotes, status: releaseStatus, storyIds: releaseStoryIds });
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
      setError(agileFormErrorMessage(cause, editing ? "更新发布失败" : "创建发布失败"));
    } finally {
      setBusy("");
    }
  };

  const removeRelease = async (release: AgileRelease) => {
    if (!window.confirm(`删除发布「${release.version} · ${release.name}」？已关联的故事不会被删除，只会解除关联。`)) return;
    setBusy(`delete-release:${release.id}`);
    setError("");
    try {
      await api.deleteRelease(release.id);
      setReleases((current) => current.filter((item) => item.id !== release.id));
      if (releaseManageId === release.id) resetReleaseForm();
      if (releaseDetailId === release.id) { setReleaseDetailId(""); setReleaseSummary(undefined); setReleaseRetrospective(undefined); }
    } catch (cause) {
      setError(agileFormErrorMessage(cause, "删除发布失败"));
    } finally {
      setBusy("");
    }
  };

  const toggleReleaseStory = (storyId: string) => {
    setReleaseStoryIds((current) => (current.includes(storyId) ? current.filter((id) => id !== storyId) : [...current, storyId]));
  };

  // ------------------------------------------------- publish action (Sprint 5)
  const openPublish = async (release: AgileRelease) => {
    setPublishTarget(release);
    setPublishBlocked([]);
    setPublishReady(false);
    setPublishNote("");
    setPublishError("");
    setPublishBusy(true);
    try {
      const preview = await api.publishRelease(release.id, {});
      setPublishTarget(preview.release);
      setPublishReady(true);
    } catch (cause) {
      const error = cause as { message?: string; body?: { blocked?: Array<{ storyId: string; title: string; reason: string }> } };
      setPublishBlocked(error.body?.blocked ?? []);
      setPublishError(error.message || "无法发布");
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

  const confirmPublish = async () => {
    if (!publishTarget) return;
    setPublishBusy(true);
    setPublishError("");
    try {
      const result = await api.publishRelease(publishTarget.id, { confirm: true, ...(publishNote.trim() ? { note: publishNote.trim() } : {}) });
      setReleases((current) => current.map((item) => (item.id === result.release.id ? result.release : item)));
      closePublish();
    } catch (cause) {
      const error = cause as { message?: string; body?: { blocked?: Array<{ storyId: string; title: string; reason: string }> } };
      setPublishBlocked(error.body?.blocked ?? []);
      setPublishError(error.message || "发布失败");
    } finally {
      setPublishBusy(false);
    }
  };

  // ------------------------------------------------ Kanban blocked-management
  const blockStory = async (story: AgileStory) => {
    const reason = window.prompt(`标记「${story.title}」为阻塞，请填写原因：`, "");
    if (reason === null) return;
    if (!reason.trim()) { setError("标记阻塞需要填写原因"); return; }
    setBusy(`block:${story.id}`);
    setError("");
    try {
      const updated = await api.blockStory(story.id, reason.trim());
      setStories((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDetail((current) => (current && current.id === updated.id ? updated : current));
    } catch (cause) {
      setError(agileFormErrorMessage(cause, "标记阻塞失败"));
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
      setError(agileFormErrorMessage(cause, "解除阻塞失败"));
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
      setError(agileFormErrorMessage(cause, "重新打开失败"));
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
      setReleaseExportNote(copied ? `已下载 ${filename}，并已复制到剪贴板` : `已下载 ${filename}`);
    } catch (cause) {
      setReleaseExportNote((cause as Error).message || "导出失败");
    } finally {
      setReleaseExporting(false);
    }
  };

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">AGILE PLANNING</span>
          <h1>敏捷</h1>
          <p>以项目、用户故事与冲刺组织需求，并把一个「就绪」的故事提交为运行。运行仍是唯一的执行单元：一条故事可以关联多次运行（修复 / 重试），故事状态由最近一次运行自动回写。</p>
        </div>
        <div className="ws-heading-actions">
          <button className="button secondary" onClick={() => { setPanel(panel === "project" ? "none" : "project"); setError(""); }}><Plus size={15} />新建项目</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { setPanel(panel === "sprint" ? "none" : "sprint"); setError(""); }}><Plus size={15} />新建冲刺</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { setPanel(panel === "story" ? "none" : "story"); setError(""); }}><Plus size={15} />新建故事</button>
          <button className={`button secondary ${panel === "templates" ? "active" : ""}`} onClick={() => { setPanel(panel === "templates" ? "none" : "templates"); setError(""); }}><LayoutTemplate size={15} />模板管理</button>
          <button className={`button secondary ${panel === "metrics" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "metrics" ? "none" : "metrics"); setError(""); }}><BarChart3 size={15} />度量</button>
          <button className={`button secondary ${panel === "release" ? "active" : ""}`} disabled={!projectId || releases.length === 0} onClick={() => { setPanel(panel === "release" ? "none" : "release"); setError(""); }}><Rocket size={15} />发布回顾</button>
          <button className={`button secondary ${panel === "releases" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "releases" ? "none" : "releases"); setError(""); }}><Pencil size={15} />发布管理</button>
        </div>
      </section>

      <div className="ws-forms">
        {panel === "project" && (
          <form className="ws-form" onSubmit={createProject}>
            <div className="ws-form-head"><div><span className="eyebrow">NEW PROJECT</span><h3>新建项目</h3></div><button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button></div>
            <p className="ws-form-help">项目用于分组故事。前缀是故事编号的短标识（2–10 位，字母开头，如 <code>AUTH</code>），同一用户下不可重复。</p>
            <label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="认证服务" autoFocus /></label>
            <label>项目前缀<input value={projectKey} onChange={(event) => setProjectKey(event.target.value.toUpperCase())} placeholder="AUTH" /></label>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
              <button type="submit" className="button primary" disabled={busy === "project" || !projectName.trim() || projectKey.trim().length < 2}>
                {busy === "project" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建
              </button>
            </div>
          </form>
        )}
        {panel === "sprint" && (
          <form className="ws-form" onSubmit={createSprint}>
            <div className="ws-form-head"><div><span className="eyebrow">NEW SPRINT</span><h3>新建冲刺</h3></div><button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button></div>
            <p className="ws-form-help">冲刺属于当前项目；故事通过「分配冲刺」加入，未分配的故事留在待办。</p>
            <label>冲刺名称<input value={sprintName} onChange={(event) => setSprintName(event.target.value)} placeholder="Sprint 1" autoFocus /></label>
            <label>冲刺目标<input value={sprintGoal} onChange={(event) => setSprintGoal(event.target.value)} placeholder="完成登录限流与并发刷新" /></label>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
              <button type="submit" className="button primary" disabled={busy === "sprint" || !sprintName.trim()}>
                {busy === "sprint" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建
              </button>
            </div>
          </form>
        )}
        {panel === "story" && (
          <form className="ws-form" onSubmit={createStory}>
            <div className="ws-form-head"><div><span className="eyebrow">NEW STORY</span><h3>新建用户故事</h3></div><button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button></div>
            <label>标题<input value={storyTitle} onChange={(event) => setStoryTitle(event.target.value)} placeholder="实现登录限流" autoFocus /></label>
            <label>描述<textarea rows={3} value={storyDescription} onChange={(event) => setStoryDescription(event.target.value)} placeholder="要解决的问题与背景" /></label>
            <label>验收标准（每行一条）<textarea rows={3} value={storyCriteria} onChange={(event) => setStoryCriteria(event.target.value)} placeholder={"超过阈值返回 429\n并发刷新只触发一次"} /></label>
            <label>完成定义（每行一条）<textarea rows={2} value={storyDod} onChange={(event) => setStoryDod(event.target.value)} placeholder={"单元测试通过\n无新增 lint 问题"} /></label>
            <div className="agile-form-row">
              <label>优先级
                <select value={storyPriority} onChange={(event) => setStoryPriority(event.target.value as StoryPriority)}>
                  {STORY_PRIORITIES.map((value) => <option key={value} value={value}>{priorityLabel(value)}</option>)}
                </select>
              </label>
              <label>估算（点）
                <select value={storyEstimate} onChange={(event) => setStoryEstimate(event.target.value)}>
                  <option value="">未估算</option>
                  {[1, 2, 3, 5, 8, 13].map((value) => <option key={value} value={value}>{estimateLabel(value)}</option>)}
                </select>
              </label>
            </div>
            <div className="agile-form-row">
              <label>工作区
                <select value={storyWorkspace} onChange={(event) => setStoryWorkspace(event.target.value)}>
                  <option value="">未指定</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
              <label>冲刺
                <select value={storySprint} onChange={(event) => setStorySprint(event.target.value)}>
                  <option value="">未分配（待办）</option>
                  {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
                </select>
              </label>
            </div>
            <div className="agile-form-row">
              <label>模板
                <select value={storyTemplate} onChange={(event) => applyStoryTemplate(event.target.value)}>
                  <option value="">不使用</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name} · {template.developerModel.model} / {template.reviewerModel.model}</option>
                  ))}
                </select>
              </label>
              <label>最大并行
                <input inputMode="numeric" value={storyMaxParallel} onChange={(event) => setStoryMaxParallel(event.target.value)} placeholder="默认" />
              </label>
            </div>
            <div className="agile-form-row">
              <label>开发模型
                <select value={storyDeveloper} onChange={(event) => setStoryDeveloper(event.target.value)}>
                  <option value="">默认</option>
                  {(models?.models ?? []).filter((entry) => entry.roles.includes("developer")).map((entry) => (
                    <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                  ))}
                </select>
              </label>
              <label>审核模型
                <select value={storyReviewer} onChange={(event) => setStoryReviewer(event.target.value)}>
                  <option value="">默认</option>
                  {(models?.models ?? []).filter((entry) => entry.roles.includes("reviewer")).map((entry) => (
                    <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="agile-form-row agile-budget-row">
              <label>预算 Token<input inputMode="numeric" value={budgetTokens} onChange={(event) => setBudgetTokens(event.target.value)} placeholder="不限" /></label>
              <label>预算成本（$）<input inputMode="decimal" value={budgetCost} onChange={(event) => setBudgetCost(event.target.value)} placeholder="不限" /></label>
              <label>模型调用<input inputMode="numeric" value={budgetCalls} onChange={(event) => setBudgetCalls(event.target.value)} placeholder="不限" /></label>
              <label>时长（秒）<input inputMode="numeric" value={budgetSeconds} onChange={(event) => setBudgetSeconds(event.target.value)} placeholder="不限" /></label>
            </div>
            <div className="ws-form-actions">
              <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
              <button type="submit" className="button primary" disabled={busy === "story" || storyTitle.trim().length < 2}>
                {busy === "story" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建故事
              </button>
            </div>
          </form>
        )}
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>正在加载敏捷数据…</span></div>}
      {!loading && projects.length === 0 && (
        <div className="ws-empty"><ClipboardList size={26} /><strong>还没有项目</strong><span>先新建一个项目，再在其中创建用户故事与冲刺。</span></div>
      )}

      {projects.length > 0 && (
        <>
          <div className="agile-toolbar">
            <label>项目
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}
              </select>
            </label>
            <label>冲刺
              <select value={sprintFilter} onChange={(event) => setSprintFilter(event.target.value)}>
                <option value="all">全部</option>
                <option value="none">未分配</option>
                {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}（{sprintStatusLabels[sprint.status]}）</option>)}
              </select>
            </label>
            {selectedProject?.description && <span className="agile-hint">{selectedProject.description}</span>}
          </div>

          <section className="panel agile-board">
            <div className="panel-head"><div><span className="eyebrow">SPRINT BOARD</span><h3>Sprint 看板</h3></div><ListChecks size={15} /></div>
            <div className="agile-columns">
              {columns.map((column) => (
                <div className="agile-column" key={column.id}>
                  <header><span>{column.label}</span><em>{column.stories.length}{columnPoints(column) > 0 ? ` · ${columnPoints(column)} 点` : ""}</em></header>
                  {column.stories.map((story) => (
                    <div key={story.id} className={`agile-card ${selectedId === story.id ? "selected" : ""}`}>
                      <button type="button" className="agile-card-main" onClick={() => setSelectedId(story.id)}>
                        <strong>{story.title}</strong>
                        <span className="agile-card-meta">
                          <em className={`agile-priority priority-${story.priority}`}>{priorityLabel(story.priority)}</em>
                          <small>{estimateLabel(story.estimate)}</small>
                        </span>
                        <small className="agile-card-sprint">{sprintLabel(story.sprintId)}</small>
                      </button>
                      {story.status === "blocked" && (
                        <span className="agile-blocked-badge" title={story.blockedReason ?? "阻塞"}>
                          阻塞{story.blockedReason ? `：${story.blockedReason}` : ""}
                        </span>
                      )}
                      <div className="agile-card-actions">
                        {story.status !== "blocked"
                          ? <button type="button" disabled={busy === `block:${story.id}`} onClick={() => void blockStory(story)}>标记阻塞</button>
                          : <button type="button" disabled={busy === `unblock:${story.id}`} onClick={() => void unblockStory(story)}>解除阻塞</button>}
                      </div>
                    </div>
                  ))}
                  {column.stories.length === 0 && <div className="agile-column-empty">暂无</div>}
                </div>
              ))}
            </div>
          </section>

          <div className="agile-grid">
            <section className="panel">
              <div className="panel-head"><div><span className="eyebrow">STORY LIST</span><h3>故事列表</h3></div><ClipboardList size={15} /></div>
              <div className="agile-story-list">
                {visibleStories.map((story, index) => (
                  <div className={`agile-story-row ${selectedId === story.id ? "selected" : ""}`} key={story.id}>
                    <button type="button" className="agile-story-main" onClick={() => setSelectedId(story.id)}>
                      <code>{storyReference(selectedProject?.key ?? "STORY", index)}</code>
                      <span><strong>{story.title}</strong><small>{STORY_STATUS_LABELS[story.status]} · {sprintLabel(story.sprintId)}</small></span>
                    </button>
                    <div className="agile-story-actions">
                      {story.status !== "ready" && <button type="button" disabled={busy === `status:${story.id}`} onClick={() => void patchStatus(story, "ready")}>标为就绪</button>}
                      <button type="button" className="danger" disabled={busy === `delete:${story.id}`} onClick={() => void removeStory(story)}><Trash2 size={12} /></button>
                    </div>
                  </div>
                ))}
                {visibleStories.length === 0 && <div className="ws-empty"><span>当前筛选下没有故事。</span></div>}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head"><div><span className="eyebrow">SPRINTS &amp; RELEASES</span><h3>冲刺与发布</h3></div><Rocket size={15} /></div>
              <div className="agile-sprint-list">
                {sprints.map((sprint) => (
                  <div className="agile-sprint-row" key={sprint.id}>
                    <span><strong>{sprint.name}</strong><small>{sprintStatusLabels[sprint.status]}{sprint.goal ? ` · ${sprint.goal}` : ""}</small></span>
                    <div>
                      {sprint.status !== "active" && <button type="button" disabled={busy === `sprint:${sprint.id}`} onClick={() => void setSprintStatus(sprint, "active")}>开始</button>}
                      {sprint.status === "active" && <button type="button" disabled={busy === `sprint:${sprint.id}`} onClick={() => void setSprintStatus(sprint, "closed")}>关闭</button>}
                    </div>
                  </div>
                ))}
                {sprints.length === 0 && <div className="agile-hint">还没有冲刺；故事默认留在待办。</div>}
              </div>
              <div className="agile-release-list">
                {releases.map((release) => (
                  <div className="agile-release-row" key={release.id}>
                    <code>{release.version}</code>
                    <span>{release.name}</span>
                    <small>{releaseStatusLabels[release.status]} · {release.storyIds.length} 个故事</small>
                    <button type="button" onClick={() => { setReleaseDetailId(release.id); setPanel("release"); setError(""); }}>回顾</button>
                  </div>
                ))}
                {releases.length === 0 && <div className="agile-hint">还没有发布记录。</div>}
              </div>
            </section>
          </div>
        </>
      )}

      {panel === "templates" && (
        <section className="panel agile-metrics agile-templates">
          <div className="panel-head"><div><span className="eyebrow">MODEL TEMPLATES</span><h3>模板管理</h3></div><LayoutTemplate size={15} /></div>
          <div className="agile-metrics-body">
            <form className="ws-form" onSubmit={createTemplate}>
              <div className="ws-form-head"><div><span className="eyebrow">NEW TEMPLATE</span><h3>新建模板</h3></div></div>
              <p className="ws-form-help">模板保存一组「开发模型 + 审核模型」，可选附带预算与并行度；在<strong>新建故事</strong>时选择即可一键填充。模板属于当前账号，同名不可重复。</p>
              <label>模板名称<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="快速组合" autoFocus /></label>
              <div className="agile-form-row">
                <label>开发模型
                  <select value={templateDeveloper} onChange={(event) => setTemplateDeveloper(event.target.value)}>
                    <option value="">请选择</option>
                    {(models?.models ?? []).filter((entry) => entry.roles.includes("developer")).map((entry) => (
                      <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                    ))}
                  </select>
                </label>
                <label>审核模型
                  <select value={templateReviewer} onChange={(event) => setTemplateReviewer(event.target.value)}>
                    <option value="">请选择</option>
                    {(models?.models ?? []).filter((entry) => entry.roles.includes("reviewer")).map((entry) => (
                      <option key={`${entry.provider}::${entry.model}`} value={`${entry.provider}::${entry.model}`}>{entry.label} · {entry.model}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="agile-form-row agile-budget-row">
                <label>预算 Token<input inputMode="numeric" value={templateBudgetTokens} onChange={(event) => setTemplateBudgetTokens(event.target.value)} placeholder="不限" /></label>
                <label>预算成本（$）<input inputMode="decimal" value={templateBudgetCost} onChange={(event) => setTemplateBudgetCost(event.target.value)} placeholder="不限" /></label>
                <label>模型调用<input inputMode="numeric" value={templateBudgetCalls} onChange={(event) => setTemplateBudgetCalls(event.target.value)} placeholder="不限" /></label>
                <label>时长（秒）<input inputMode="numeric" value={templateBudgetSeconds} onChange={(event) => setTemplateBudgetSeconds(event.target.value)} placeholder="不限" /></label>
              </div>
              <div className="agile-form-row">
                <label>最大并行<input inputMode="numeric" value={templateMaxParallel} onChange={(event) => setTemplateMaxParallel(event.target.value)} placeholder="默认（1–32）" /></label>
                <span />
              </div>
              <div className="ws-form-actions">
                <button type="submit" className="button primary" disabled={busy === "template" || !templateName.trim() || !templateDeveloper || !templateReviewer}>
                  {busy === "template" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建模板
                </button>
              </div>
            </form>
            <div className="agile-manage-list">
              <h4>已有模板（{templates.length}）</h4>
              {templates.map((template) => (
                <div className="agile-release-row" key={template.id}>
                  <span>{template.name}</span>
                  <code>{template.developerModel.provider}:{template.developerModel.model} / {template.reviewerModel.provider}:{template.reviewerModel.model}</code>
                  <small>{template.budget ? `预算 ${template.budget.maxCostUsd} · ${template.budget.maxTokens} tok` : "无预算"}{template.maxParallel !== null ? ` · 并行 ${template.maxParallel}` : ""}</small>
                  <button type="button" className="danger" disabled={busy === `delete-template:${template.id}`} onClick={() => void removeTemplate(template)}><Trash2 size={12} />删除</button>
                </div>
              ))}
              {templates.length === 0 && <div className="agile-hint">还没有模板。创建后可在「新建故事」的模板下拉中选用，它会自动填入开发/审核模型与预算。</div>}
            </div>
          </div>
        </section>
      )}

      {panel === "metrics" && (
        <section className="panel agile-metrics">
          <div className="panel-head"><div><span className="eyebrow">SPRINT METRICS</span><h3>度量</h3></div><BarChart3 size={15} /></div>
          <div className="agile-metrics-body">
            <div className="agile-toolbar">
              <label>冲刺
                <select value={metricsSprintId} onChange={(event) => setMetricsSprintId(event.target.value)}>
                  <option value="">项目汇总</option>
                  {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
                </select>
              </label>
              <span className="agile-hint">只读聚合：完成故事的成本/周期、返工率、审核发现与运行结果。</span>
            </div>
            {metricsLoading && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>正在计算度量…</span></div>}
            {!metricsLoading && !metricsView && <div className="agile-hint">该范围下还没有故事。</div>}
            {!metricsLoading && metricsView && (
              <>
                <div className="metrics-grid agile-metrics-grid">
                  <div className="metric"><span>完成故事</span><strong>{metricsView.stories.completed}/{metricsView.stories.total}</strong><small>完成 = 已验收</small></div>
                  <div className="metric"><span>返工率</span><strong>{(metricsView.rework.rate * 100).toFixed(0)}%</strong><small>{metricsView.rework.reworked}/{metricsView.rework.completed} 有返修</small></div>
                  <div className="metric"><span>成本 / 完成故事</span><strong>${metricsView.costPerCompletedStory.toFixed(3)}</strong><small>合计 ${metricsView.usage.cost.toFixed(3)}</small></div>
                  <div className="metric"><span>周期 中位 / P90</span><strong>{formatDuration(metricsView.cycleTime.medianSeconds)} / {formatDuration(metricsView.cycleTime.p90Seconds)}</strong><small>{metricsView.cycleTime.samples} 个样本</small></div>
                </div>
                <div className="agile-metrics-cols">
                  <div>
                    <h4>故事状态</h4>
                    {STORY_STATUSES.map((status) => (
                      <div className="agile-metrics-row" key={status}><span>{STORY_STATUS_LABELS[status]}</span><strong>{metricsView.stories.byStatus[status]}</strong></div>
                    ))}
                  </div>
                  <div>
                    <h4>运行结果</h4>
                    <div className="agile-metrics-row"><span>已完成</span><strong>{metricsView.runOutcomes.completed}</strong></div>
                    <div className="agile-metrics-row"><span>需要人工</span><strong>{metricsView.runOutcomes.needs_human}</strong></div>
                    <div className="agile-metrics-row"><span>已取消</span><strong>{metricsView.runOutcomes.cancelled}</strong></div>
                    <div className="agile-metrics-row"><span>失败</span><strong>{metricsView.runOutcomes.failed}</strong></div>
                  </div>
                  <div>
                    <h4>用量与审核</h4>
                    <div className="agile-metrics-row"><span>模型调用</span><strong>{metricsView.usage.modelCalls}</strong></div>
                    <div className="agile-metrics-row"><span>Token 输入/输出</span><strong>{metricsView.usage.inputTokens} / {metricsView.usage.outputTokens}</strong></div>
                    <div className="agile-metrics-row"><span>缓存读取</span><strong>{metricsView.usage.cacheReadTokens}</strong></div>
                    <div className="agile-metrics-row"><span>发现 已解决/合计</span><strong>{metricsView.reviewFindings.resolved}/{metricsView.reviewFindings.total}</strong></div>
                    <div className="agile-metrics-row"><span>未收敛事件</span><strong>{metricsView.reviewFindings.notConverging}</strong></div>
                  </div>
                </div>
                {!metricsSprintId && metrics && metrics.sprints.length > 1 && (
                  <div className="agile-metrics-sprints">
                    <h4>各冲刺</h4>
                    <div className="agile-metrics-row agile-metrics-head"><span>冲刺</span><strong>完成/总数</strong><strong>周期中位</strong><strong>返工率</strong><strong>成本</strong></div>
                    {metrics.sprints.map((sprint) => (
                      <button type="button" className="agile-metrics-row" key={sprint.sprintId} onClick={() => setMetricsSprintId(sprint.sprintId)}>
                        <span>{sprint.name}</span>
                        <strong>{sprint.stories.completed}/{sprint.stories.total}</strong>
                        <strong>{formatDuration(sprint.cycleTime.medianSeconds)}</strong>
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
          <div className="panel-head"><div><span className="eyebrow">RELEASE SUMMARY</span><h3>发布回顾</h3></div><Rocket size={15} /></div>
          <div className="agile-metrics-body">
            <div className="agile-toolbar">
              <label>发布
                <select value={releaseDetailId} onChange={(event) => setReleaseDetailId(event.target.value)}>
                  {releases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.name}</option>)}
                </select>
              </label>
              <button type="button" className="button secondary" disabled={!releaseSummary || !releaseRetrospective || releaseExporting} onClick={() => void exportRetrospective()}>
                {releaseExporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出回顾 (JSON)
              </button>
              <button type="button" className="button secondary" disabled={!releaseSummary || !releaseRetrospective} onClick={() => { void navigator.clipboard?.writeText(releaseExportJson({ summary: releaseSummary!, retrospective: releaseRetrospective! })).then(() => setReleaseExportNote("已复制回顾 JSON 到剪贴板")).catch(() => setReleaseExportNote("复制失败，请使用导出按钮")); }}>
                <Copy size={15} />复制
              </button>
              <span className="agile-hint">只读汇总：故事结果、成本/Token、模型组合、合并与部署记录，以及周期/返工回顾。</span>
            </div>
            {releaseExportNote && <div className="agile-hint">{releaseExportNote}</div>}
            {releaseSummary && (
              <div className="agile-metrics-sprints">
                <h4>发布状态</h4>
                <div className="agile-metrics-row">
                  <span>{releaseStatusLabels[releaseSummary.status]}{releaseSummary.releasedAt ? ` · ${formatTime(releaseSummary.releasedAt)} 由 ${releaseSummary.releasedBy ?? "未知"}` : " · 尚未发布"}</span>
                  <strong>{releaseSummary.deploy ? `部署 ${deployStatusLabels[releaseSummary.deploy.status]}${releaseSummary.deploy.detail ? `（${releaseSummary.deploy.detail}）` : ""}` : "无部署记录"}</strong>
                </div>
              </div>
            )}
            {releaseLoading && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>正在计算发布汇总…</span></div>}
            {!releaseLoading && releases.length === 0 && <div className="agile-hint">当前项目还没有发布记录。</div>}
            {!releaseLoading && releaseSummary && releaseRetrospective && (
              <>
                <div className="metrics-grid agile-metrics-grid">
                  <div className="metric"><span>完成故事</span><strong>{releaseSummary.totals.done}/{releaseSummary.totals.stories}</strong><small>未开始 {releaseSummary.totals.notStarted}</small></div>
                  <div className="metric"><span>进行中</span><strong>{releaseSummary.totals.inProgress}</strong><small>开发 / 审核 / 待验收</small></div>
                  <div className="metric"><span>阻塞</span><strong>{releaseSummary.totals.blocked}</strong><small>关联运行 {releaseSummary.totals.runs}</small></div>
                  <div className="metric"><span>成本 / 完成故事</span><strong>${releaseRetrospective.costPerCompletedStory.toFixed(3)}</strong><small>合计 ${releaseSummary.usage.cost.toFixed(3)}</small></div>
                </div>
                <div className="agile-metrics-cols">
                  <div>
                    <h4>周期与返工</h4>
                    <div className="agile-metrics-row"><span>周期 中位</span><strong>{formatDuration(releaseRetrospective.cycleTime.medianSeconds)}</strong></div>
                    <div className="agile-metrics-row"><span>周期 P90</span><strong>{formatDuration(releaseRetrospective.cycleTime.p90Seconds)}</strong></div>
                    <div className="agile-metrics-row"><span>周期样本</span><strong>{releaseRetrospective.cycleTime.samples}</strong></div>
                    <div className="agile-metrics-row"><span>返工率</span><strong>{(releaseRetrospective.rework.rate * 100).toFixed(0)}%</strong></div>
                  </div>
                  <div>
                    <h4>用量</h4>
                    <div className="agile-metrics-row"><span>模型调用</span><strong>{releaseSummary.usage.modelCalls}</strong></div>
                    <div className="agile-metrics-row"><span>Token 输入/输出</span><strong>{releaseSummary.usage.inputTokens} / {releaseSummary.usage.outputTokens}</strong></div>
                    <div className="agile-metrics-row"><span>缓存读取</span><strong>{releaseSummary.usage.cacheReadTokens}</strong></div>
                    <div className="agile-metrics-row"><span>关联运行</span><strong>{releaseSummary.usage.runs}</strong></div>
                  </div>
                  <div>
                    <h4>审核</h4>
                    <div className="agile-metrics-row"><span>发现 已解决/合计</span><strong>{releaseRetrospective.reviewFindings.resolved}/{releaseRetrospective.reviewFindings.total}</strong></div>
                    <div className="agile-metrics-row"><span>退回事件</span><strong>{releaseRetrospective.reviewTrend.reduce((count, point) => count + point.changesRequested, 0)}</strong></div>
                    <div className="agile-metrics-row"><span>未收敛运行</span><strong>{releaseRetrospective.notConvergingRuns}</strong></div>
                    <div className="agile-metrics-row"><span>未收敛事件</span><strong>{releaseRetrospective.reviewFindings.notConverging}</strong></div>
                  </div>
                </div>

                <div className="agile-metrics-sprints">
                  <h4>故事结果</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>故事</span><strong>状态</strong><strong>运行/轮次</strong><strong>发现</strong><strong>成本</strong></div>
                  {releaseSummary.stories.map((story) => (
                    <div className="agile-metrics-row" key={story.storyId}>
                      <span>{story.title}{story.acceptance ? " · 已验收" : ""}{story.blockedReason ? ` · ${story.blockedReason}` : ""}</span>
                      <strong>{STORY_STATUS_LABELS[story.status]}</strong>
                      <strong>{story.runs}{story.latest ? ` · 第 ${story.latest.round}/${story.latest.maxRounds} 轮` : ""}</strong>
                      <strong>{story.findings.resolved}/{story.findings.total}</strong>
                      <strong>${story.cost.toFixed(4)}</strong>
                    </div>
                  ))}
                  {releaseSummary.stories.length === 0 && <div className="agile-hint">该发布还没有关联故事。</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>模型组合</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>开发 / 审核</span><strong>运行</strong><strong>故事</strong><strong /><strong /></div>
                  {releaseSummary.modelCombinations.map((combo) => (
                    <div className="agile-metrics-row" key={`${combo.developer.provider}::${combo.developer.model}|${combo.reviewer.provider}::${combo.reviewer.model}`}>
                      <span>{combo.developer.provider}:{combo.developer.model} / {combo.reviewer.provider}:{combo.reviewer.model}</span>
                      <strong>{combo.runs}</strong>
                      <strong>{combo.stories}</strong>
                      <strong />
                      <strong />
                    </div>
                  ))}
                  {releaseSummary.modelCombinations.length === 0 && <div className="agile-hint">还没有关联运行的模型组合。</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>合并与部署</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>运行</span><strong>类型</strong><strong>目标</strong><strong>状态</strong><strong>时间</strong></div>
                  {releaseSummary.merges.map((merge) => (
                    <div className="agile-metrics-row" key={`merge-${merge.runId}`}>
                      <span title={merge.commit}>{merge.runId.slice(0, 12)}</span>
                      <strong>合并 ({merge.strategy})</strong>
                      <strong>{merge.targetBranch}</strong>
                      <strong>{merge.commit.slice(0, 7)}</strong>
                      <strong>{formatTime(merge.mergedAt)}</strong>
                    </div>
                  ))}
                  {releaseSummary.deployments.map((deploy) => (
                    <div className="agile-metrics-row" key={`deploy-${deploy.runId}-${deploy.commit}`}>
                      <span title={deploy.commit}>{deploy.runId.slice(0, 12)}</span>
                      <strong>部署 ({deploy.kind})</strong>
                      <strong>{deploy.environment}</strong>
                      <strong>{deploy.status}{deploy.url ? ` · ${deploy.url}` : ""}</strong>
                      <strong>{formatTime(deploy.finishedAt ?? deploy.requestedAt)}</strong>
                    </div>
                  ))}
                  {releaseSummary.merges.length === 0 && releaseSummary.deployments.length === 0 && <div className="agile-hint">没有合并或部署记录。</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>审核趋势</h4>
                  <div className="agile-metrics-row agile-metrics-head"><span>故事</span><strong>发现 已解决/合计</strong><strong>退回</strong><strong>未收敛</strong><strong /></div>
                  {releaseRetrospective.reviewTrend.map((point) => (
                    <div className="agile-metrics-row" key={`trend-${point.storyId}`}>
                      <span>{point.title}</span>
                      <strong>{point.resolved}/{point.total}</strong>
                      <strong>{point.changesRequested}</strong>
                      <strong>{point.notConverging}</strong>
                      <strong />
                    </div>
                  ))}
                  {releaseRetrospective.reviewTrend.length === 0 && <div className="agile-hint">没有可统计的审核记录。</div>}
                </div>

                <div className="agile-metrics-sprints">
                  <h4>阻塞故事（{releaseRetrospective.blockedStories.length}）</h4>
                  {releaseRetrospective.blockedStories.map((story) => (
                    <div className="agile-metrics-row" key={`blocked-${story.storyId}`}>
                      <span>{story.title}</span>
                      <strong>{story.state ? `${runStateLabels[story.state]} · ` : ""}{story.reason}</strong>
                    </div>
                  ))}
                  {releaseRetrospective.blockedStories.length === 0 && <div className="agile-hint">没有阻塞故事。</div>}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {panel === "releases" && (
        <section className="panel agile-metrics agile-release-manage">
          <div className="panel-head"><div><span className="eyebrow">RELEASE MANAGEMENT</span><h3>发布管理</h3></div><Pencil size={15} /></div>
          <div className="agile-metrics-body">
            <form className="ws-form" onSubmit={saveRelease}>
              <div className="ws-form-head">
                <div><span className="eyebrow">{releaseManageId ? "EDIT RELEASE" : "NEW RELEASE"}</span><h3>{releaseManageId ? "编辑发布" : "新建发布"}</h3></div>
                {releaseManageId && <button className="icon-button" type="button" onClick={resetReleaseForm}><X size={16} /></button>}
              </div>
              <p className="ws-form-help">发布把一组故事归入同一个交付版本；「发布回顾」会汇总这些故事的运行结果、成本与合并记录。关联关系可随时调整，不会改动故事本身。</p>
              <div className="agile-form-row">
                <label>版本号<input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="v1.2.0" /></label>
                <label>发布名称<input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder="结账体验" /></label>
              </div>
              <div className="agile-form-row">
                <label>状态
                  <select value={releaseStatus} onChange={(event) => setReleaseStatus(event.target.value as ReleaseStatus)}>
                    {RELEASE_STATUSES.map((value) => <option key={value} value={value}>{releaseStatusLabels[value]}</option>)}
                  </select>
                </label>
                <span className="agile-hint agile-release-picker-hint">勾选下方故事即加入发布，取消勾选即移出；{releaseStoryIds.length} 个已关联。</span>
              </div>
              <label>备注<textarea rows={2} value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder="本次发布的范围与注意事项" /></label>
              <div className="agile-release-story-picker">
                {stories.map((story) => (
                  <label className="agile-check" key={story.id}>
                    <input type="checkbox" checked={releaseStoryIds.includes(story.id)} onChange={() => toggleReleaseStory(story.id)} />
                    <span>{story.title}<small>{STORY_STATUS_LABELS[story.status]}</small></span>
                  </label>
                ))}
                {stories.length === 0 && <div className="agile-hint">当前项目还没有故事。</div>}
              </div>
              <div className="ws-form-actions">
                {releaseManageId && <button type="button" className="button secondary" onClick={resetReleaseForm}>取消编辑</button>}
                <button type="submit" className="button primary" disabled={busy === "release" || !releaseName.trim() || !releaseVersion.trim()}>
                  {busy === "release" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{releaseManageId ? "保存" : "创建"}
                </button>
              </div>
            </form>
            <div className="agile-manage-list">
              <h4>已有发布（{releases.length}）</h4>
              {releases.map((release) => (
                <div className={`agile-release-row ${releaseManageId === release.id ? "selected" : ""}`} key={release.id}>
                  <code>{release.version}</code>
                  <span>{release.name}</span>
                  <small>{releaseStatusLabels[release.status]} · {release.storyIds.length} 个故事{release.deploy ? ` · 部署 ${deployStatusLabels[release.deploy.status]}` : ""}</small>
                  <button type="button" disabled={release.status === "released"} onClick={() => void openPublish(release)}><Rocket size={12} />{release.status === "released" ? "已发布" : "发布"}</button>
                  <button type="button" disabled={release.status === "released"} onClick={() => editRelease(release)}><Pencil size={12} />编辑</button>
                  <button type="button" className="danger" disabled={busy === `delete-release:${release.id}`} onClick={() => void removeRelease(release)}><Trash2 size={12} />删除</button>
                </div>
              ))}
              {releases.length === 0 && <div className="agile-hint">还没有发布记录。填写上方表单创建第一个发布。</div>}
            </div>
          </div>
        </section>
      )}

      {publishTarget && (
        <section className="panel agile-publish-confirm">
          <div className="panel-head">
            <div><span className="eyebrow">PUBLISH RELEASE</span><h3>发布「{publishTarget.version} · {publishTarget.name}」</h3></div>
            <button className="icon-button" type="button" onClick={closePublish}><X size={16} /></button>
          </div>
          <p className="ws-form-help">发布将把该版本标记为「已发布」且不可再编辑。若配置了 <code>PI_POST_MERGE_DEPLOY_HOOK</code>，确认后会立即触发部署钩子；失败也会如实记录，不会静默跳过。</p>
          {publishError && <div className="form-error">{publishError}</div>}
          {publishBlocked.length > 0 && (
            <div className="agile-blocked-list">
              <strong>以下故事仍处于阻塞，需先解除阻塞：</strong>
              <ul>{publishBlocked.map((item) => <li key={item.storyId}>{item.title} — {item.reason}</li>)}</ul>
            </div>
          )}
          {publishBusy && <div className="ws-empty"><LoaderCircle className="spin" size={18} /><span>正在校验发布…</span></div>}
          {!publishBusy && publishReady && <div className="agile-hint">发布前校验通过，可确认发布。</div>}
          <label>发布备注<textarea rows={2} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} placeholder="本次发布说明（可选）" /></label>
          <div className="ws-form-actions">
            <button type="button" className="button secondary" onClick={closePublish}>取消</button>
            <button type="button" className="button primary" disabled={publishBusy || !publishReady} onClick={() => void confirmPublish()}>
              {publishBusy ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}确认发布
            </button>
          </div>
        </section>
      )}

      {detail && (
        <section className="panel agile-detail">
          <div className="panel-head">
            <div><span className="eyebrow">STORY DETAIL</span><h3>{detail.title}</h3></div>
            <span className={`agile-status status-${detail.status}`}>{STORY_STATUS_LABELS[detail.status]}</span>
          </div>
          <div className="agile-detail-meta">
            <div><span>优先级</span><strong>{priorityLabel(detail.priority)}</strong></div>
            <div><span>估算</span><strong>{estimateLabel(detail.estimate)}</strong></div>
            <div><span>冲刺</span><strong>{sprintLabel(detail.sprintId)}</strong></div>
            <div><span>工作区</span><strong>{workspaces.find((workspace) => workspace.id === detail.workspaceId)?.name ?? "未指定"}</strong></div>
          </div>
          {detail.description && <p className="agile-detail-text">{detail.description}</p>}
          <div className="agile-detail-lists">
            <div><h4>验收标准</h4>{detail.acceptanceCriteria.length ? <ol>{detail.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ol> : <em>未填写</em>}</div>
            <div><h4>完成定义</h4>{detail.definitionOfDone.length ? <ul>{detail.definitionOfDone.map((item, index) => <li key={index}>{item}</li>)}</ul> : <em>未填写</em>}</div>
          </div>

          <div className="agile-detail-runs">
            <h4>关联运行（{detail.runs.length}）</h4>
            {detail.runs.length === 0 && <div className="agile-hint">还没有关联运行。将故事标为「就绪」后可提交为运行。</div>}
            {detail.runs.map((entry) => (
              <div className="agile-run-row" key={entry.runId}>
                <button type="button" onClick={() => onOpenRun(entry.runId)}><code>{entry.runId.slice(0, 12)}</code></button>
                <span className={`agile-run-state state-${entry.state}`}>{runStateLabels[entry.state]}</span>
                <span>第 {entry.round} 轮</span>
                <span>意见 {entry.findings.resolved}/{entry.findings.total}</span>
                <span>检查 {entry.checks.passed}/{entry.checks.passed + entry.checks.failed}</span>
                <span>成本 ${entry.cost.toFixed(4)}</span>
                <small>{formatTime(entry.updatedAt)}</small>
              </div>
            ))}
          </div>

          <div className="agile-detail-actions">
            {detail.status !== "ready" && detail.status !== "blocked" && <button type="button" className="button secondary" disabled={busy === `status:${detail.id}`} onClick={() => void patchStatus(detail, "ready")}>标为就绪</button>}
            {detail.status !== "blocked"
              ? <button type="button" className="button secondary" disabled={busy === `block:${detail.id}`} onClick={() => void blockStory(detail)}>标记阻塞</button>
              : <button type="button" className="button secondary" disabled={busy === `unblock:${detail.id}`} onClick={() => void unblockStory(detail)}>解除阻塞</button>}
            {detail.status !== "blocked" && (detail.runs[0]?.state === "failed" || detail.runs[0]?.state === "cancelled") && (
              <button type="button" className="button secondary" disabled={busy === `reopen:${detail.id}`} onClick={() => void reopenStory(detail)}>
                {busy === `reopen:${detail.id}` ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}重新打开
              </button>
            )}
            <button type="button" className="button primary" disabled={detail.status !== "ready" || busy === `submit:${detail.id}`} onClick={() => void submit(detail)}>
              {busy === `submit:${detail.id}` ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}提交为运行
            </button>
            <span className="agile-hint">
              {detail.status !== "ready"
                ? "只有「就绪」状态的故事可以提交为运行。"
                : detail.runs[0]?.state === "failed" || detail.runs[0]?.state === "cancelled"
                  ? "最近一次运行已失败/取消，故事已回到「就绪」，可直接重新提交，或点「重新打开」记录一次显式重开。"
                  : config?.realRunsAvailable
                    ? "将以真实运行执行，检查命令来自所选工作区。"
                    : "真实执行未启用（缺少模型 Key），将以演示模式提交。"}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
