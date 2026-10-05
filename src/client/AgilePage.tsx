import { ClipboardList, ListChecks, LoaderCircle, Plus, Rocket, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { STORY_PRIORITIES, STORY_STATUS_LABELS, type AgileProject, type AgileRelease, type AgileSprint, type AgileStory, type StoryDetail, type StoryPriority, type StoryStatus } from "../shared/agile";
import type { ConfigStatus, RunState, Workspace } from "../shared/types";
import { api } from "./api";
import { columnPoints, estimateLabel, groupStoriesByColumn, priorityLabel, splitLines, storyReference } from "./agile-view";

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

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

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
  const [panel, setPanel] = useState<"none" | "project" | "sprint" | "story">("none");

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

  useEffect(() => { void loadProjects(); void api.workspaces().then((result) => setWorkspaces(result.workspaces)).catch(() => undefined); }, [loadProjects]);
  useEffect(() => {
    setSelectedId("");
    setDetail(undefined);
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

  const createStory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId) { setError("请先创建或选择项目"); return; }
    setBusy("story");
    setError("");
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
      });
      setStories((current) => [story, ...current]);
      setStoryTitle("");
      setStoryDescription("");
      setStoryCriteria("");
      setStoryDod("");
      setStoryEstimate("");
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
                    <button type="button" key={story.id} className={`agile-card ${selectedId === story.id ? "selected" : ""}`} onClick={() => setSelectedId(story.id)}>
                      <strong>{story.title}</strong>
                      <span className="agile-card-meta">
                        <em className={`agile-priority priority-${story.priority}`}>{priorityLabel(story.priority)}</em>
                        <small>{estimateLabel(story.estimate)}</small>
                      </span>
                      <small className="agile-card-sprint">{sprintLabel(story.sprintId)}</small>
                    </button>
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
                  </div>
                ))}
                {releases.length === 0 && <div className="agile-hint">还没有发布记录。</div>}
              </div>
            </section>
          </div>
        </>
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
            {detail.status !== "ready" && <button type="button" className="button secondary" disabled={busy === `status:${detail.id}`} onClick={() => void patchStatus(detail, "ready")}>标为就绪</button>}
            <button type="button" className="button primary" disabled={detail.status !== "ready" || busy === `submit:${detail.id}`} onClick={() => void submit(detail)}>
              {busy === `submit:${detail.id}` ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}提交为运行
            </button>
            <span className="agile-hint">
              {detail.status !== "ready"
                ? "只有「就绪」状态的故事可以提交为运行。"
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
