import {
  AlertTriangle,
  Check,
  FolderGit2,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConfigStatus, Run, Workspace } from "../shared/types";
import { api } from "./api";

const namePattern = /^[A-Za-z0-9._-]{1,80}$/;

/** Same rules as the server/worker `isValidWorkspaceName`. */
function isValidName(value: string): boolean {
  return namePattern.test(value) && value !== "." && value !== "..";
}

function describeError(cause: unknown): string {
  const code = (cause as { code?: string }).code;
  switch (code) {
    case "WORKSPACE_EXISTS":
      return "同名工作区或目录已存在。若目录中已有其他内容，PiGO 不会覆盖；请换一个名称，或用「注册已有目录」登记它。";
    case "WORKSPACE_NOT_FOUND":
      return "工作区不存在，可能已被解除注册。";
    case "WORKSPACE_OUTSIDE_ROOT":
      return "路径越界：只能使用受控根目录内的相对路径，符号链接同样不允许指向根目录之外。";
    case "WORKSPACE_INVALID": {
      const raw = (cause as Error).message || "";
      if (raw.includes("does not exist")) return "目录不存在：请确认相对路径正确，且位于受控项目根目录内。";
      if (raw.includes("Not a Git repository")) return "该目录不是有效的 Git 仓库（缺少 .git）。";
      if (raw.includes("Invalid workspace name")) return "名称不合法：只能包含字母、数字、点、连字符和下划线（1–80 个字符）。";
      if (raw.includes("Invalid workspace path")) return "路径不合法：只允许受控项目根目录内的相对路径，不允许 ../ 或绝对路径。";
      return raw || "目录校验失败：需要受控项目根目录内有效的 Git 仓库。";
    }
    case "WORKSPACES_DISABLED":
      return "服务器未启用工作区功能（PI_WORKSPACES_ENABLED=false）。";
    default:
      return (cause as Error).message || "操作失败，请稍后重试。";
  }
}

const formatTime = (date: string | null) =>
  date
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date))
    : "—";

const statusLabel: Record<Workspace["status"], string> = {
  active: "已就绪",
  invalid: "校验失败",
  unregistered: "已解除注册",
};

export function WorkspacesPage({ config, runs, onOpenCredentials }: {
  config?: ConfigStatus;
  runs: Run[];
  onOpenCredentials: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<"none" | "register" | "clone" | "create">("none");
  const [relativePath, setRelativePath] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [createName, setCreateName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editChecks, setEditChecks] = useState("");
  const [editBranch, setEditBranch] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const result = await api.workspaces();
      setWorkspaces(result.workspaces);
    } catch (cause) {
      setLoadError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runCountFor = (workspace: Workspace) =>
    runs.filter((item) => item.mode === "real" && (item.repository === workspace.rootPath || item.repository.endsWith(`/${workspace.rootPath}`) || item.repository === workspace.name)).length;

  const submitRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await api.registerWorkspace({ relativePath: relativePath.trim() });
      setRelativePath("");
      setPanel("none");
      await load();
    } catch (cause) {
      setFormError(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const submitClone = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = cloneName.trim();
    if (!isValidName(name)) {
      setFormError("名称只能包含字母、数字、点、连字符与下划线（1–80 个字符）。");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      await api.cloneWorkspace({ url: cloneUrl.trim(), name });
      setCloneUrl("");
      setCloneName("");
      setPanel("none");
      await load();
    } catch (cause) {
      setFormError(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = createName.trim();
    if (!isValidName(name)) {
      setFormError("名称只能包含字母、数字、点、连字符与下划线（1–80 个字符）。");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      await api.createWorkspace({ name });
      setCreateName("");
      setPanel("none");
      await load();
    } catch (cause) {
      setFormError(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const refresh = async (workspace: Workspace) => {
    setPendingId(workspace.id);
    try {
      const updated = await api.refreshWorkspace(workspace.id);
      setWorkspaces((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      window.alert(`刷新失败：${describeError(cause)}`);
      await load();
    } finally {
      setPendingId("");
    }
  };

  const unregister = async (workspace: Workspace) => {
    if (!window.confirm(`解除注册「${workspace.name}」？\n\n只解除注册：源代码目录、历史任务与制品都会保留，稍后可以重新注册。`)) return;
    setPendingId(workspace.id);
    try {
      await api.unregisterWorkspace(workspace.id);
      await load();
    } catch (cause) {
      window.alert(`解除注册失败：${describeError(cause)}`);
    } finally {
      setPendingId("");
    }
  };

  const startEdit = (workspace: Workspace) => {
    setEditingId(workspace.id);
    setEditChecks(workspace.defaultChecks.join("\n"));
    setEditBranch(workspace.defaultBranch || workspace.git?.branch || "");
    setFormError("");
  };

  const saveEdit = async (workspace: Workspace) => {
    setSavingEdit(true);
    try {
      const updated = await api.patchWorkspace(workspace.id, {
        defaultChecks: editChecks.split("\n").map((line) => line.trim()).filter(Boolean),
        ...(editBranch.trim() ? { defaultBranch: editBranch.trim() } : {}),
      });
      setWorkspaces((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId("");
    } catch (cause) {
      setFormError(describeError(cause));
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">SERVER WORKSPACES</span>
          <h1>工作区</h1>
          <p>在 Worker 主机的受控根目录中新建工作区目录、注册已有 Git 仓库，或从 Git URL 克隆到服务器。真实任务将在隔离的 worktree 中执行，不会改动源目录。</p>
        </div>
        <div className="ws-heading-actions">
          <button className="button secondary" onClick={() => { setPanel(panel === "create" ? "none" : "create"); setFormError(""); }}><FolderPlus size={15} />新建工作区目录</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "register" ? "none" : "register"); setFormError(""); }}><Plus size={15} />注册已有目录</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "clone" ? "none" : "clone"); setFormError(""); }}><GitBranch size={15} />从 Git 克隆</button>
        </div>
      </section>

      <div className={`ws-strip ${config?.realRunsAvailable ? "is-ready" : ""}`}>
        {config?.realRunsAvailable ? <Check size={14} /> : <AlertTriangle size={14} />}
        <div>
          <strong>{config?.realRunsAvailable ? "真实执行已启用" : "尚未配置模型 Key"}</strong>
          <span>{config?.realRunsAvailable ? "工作区可以直接用于创建真实任务。" : "浏览、注册与刷新工作区不需要 Key；仅真实任务执行需要配置个人模型 Key。"}</span>
        </div>
        {!config?.realRunsAvailable && <button type="button" onClick={onOpenCredentials}>配置个人 Key</button>}
      </div>

      {panel !== "none" && (
        <div className="ws-forms">
          {panel === "create" && (
            <form className="ws-form" onSubmit={submitCreate}>
              <div className="ws-form-head">
                <div><span className="eyebrow">NEW WORKSPACE DIRECTORY</span><h3>新建工作区目录</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">
                在 Worker 主机的受控项目根目录（<code>PI_WORKSPACE_ROOT/projects</code>，容器内默认为 <code>/workspace/projects</code>）下创建目录并初始化为空的 Git 仓库，然后自动注册为工作区。<strong>目录建在 Worker 主机上，不是你本机的目录。</strong>同名目录已存在且含其他内容时会报错，不会覆盖。新建的是空仓库，需先推入或提交至少一次代码后才能用于真实任务。
              </p>
              <label>工作区名称
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="my-new-repo" autoFocus />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
                <button type="submit" className="button primary" disabled={submitting || !createName.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}创建并注册
                </button>
              </div>
            </form>
          )}
          {panel === "register" && (
            <form className="ws-form" onSubmit={submitRegister}>
              <div className="ws-form-head">
                <div><span className="eyebrow">REGISTER EXISTING</span><h3>注册已有目录</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">相对受控项目根目录（PI_WORKSPACE_ROOT/projects）的路径。只登记引用：不复制、不 checkout、不修改源仓库。</p>
              <label>相对路径
                <input value={relativePath} onChange={(event) => setRelativePath(event.target.value)} placeholder="my-repo" autoFocus />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
                <button type="submit" className="button primary" disabled={submitting || !relativePath.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}注册工作区
                </button>
              </div>
            </form>
          )}
          {panel === "clone" && (
            <form className="ws-form" onSubmit={submitClone}>
              <div className="ws-form-head">
                <div><span className="eyebrow">CLONE FROM GIT</span><h3>从 Git 克隆</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">支持 HTTPS 与 SSH 地址。克隆到服务器受控根目录并注册为工作区；URL 中的凭据不会以明文保存。</p>
              <label>Git URL
                <input value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/org/repo.git" autoFocus />
              </label>
              <label>工作区名称
                <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="my-repo" />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>取消</button>
                <button type="submit" className="button primary" disabled={submitting || !cloneUrl.trim() || !cloneName.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}克隆并注册
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      {loading ? (
        <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>正在加载工作区…</span></div>
      ) : workspaces.length === 0 ? (
        <div className="ws-empty">
          <FolderGit2 size={26} />
          <strong>还没有注册工作区</strong>
          <span>在 Worker 主机上新建一个工作区目录，或注册已有仓库 / 从 Git URL 克隆。</span>
        </div>
      ) : (
        <div className="ws-grid">
          {workspaces.map((workspace) => (
            <article className="ws-card" key={workspace.id}>
              <header className="ws-card-head">
                <div className={`ws-icon ws-icon-${workspace.status}`}><FolderGit2 size={16} /></div>
                <div className="ws-title">
                  <strong>{workspace.name}</strong>
                  <span>{workspace.nodeId} · {workspace.rootPath}</span>
                </div>
                <span className={`ws-status ws-status-${workspace.status}`}>{statusLabel[workspace.status]}</span>
              </header>

              <div className="ws-meta">
                <div><span>分支</span><strong>{workspace.git?.branch || workspace.defaultBranch || "—"}</strong></div>
                <div><span>HEAD</span><strong>{workspace.git?.head ? workspace.git.head.slice(0, 7) : "—"}</strong></div>
                <div><span>工作树</span><strong className={workspace.git?.dirty ? "warn" : ""}>{workspace.git ? (workspace.git.dirty ? "有未提交修改" : "干净") : "—"}</strong></div>
                <div><span>关联任务</span><strong>{runCountFor(workspace) || "—"}</strong></div>
                <div><span>最近检查</span><strong>{formatTime(workspace.lastCheckedAt)}</strong></div>
              </div>

              {workspace.repositoryUrl && <div className="ws-repo"><GitBranch size={11} />{workspace.repositoryUrl}</div>}
              <div className="ws-checks">
                {workspace.defaultChecks.length > 0
                  ? workspace.defaultChecks.map((command) => <code key={command}>{command}</code>)
                  : <em>未配置默认检查命令</em>}
              </div>
              {workspace.git?.dirty && <div className="ws-dirty-note"><AlertTriangle size={11} />存在未提交修改；创建真实任务前建议先提交或清理，避免混入待审核的 Diff。</div>}
              {workspace.status === "invalid" && <div className="ws-dirty-note">路径校验失败：目录可能已移动或不再是 Git 仓库。可尝试“刷新 Git 状态”，或解除注册后重新注册。</div>}

              {editingId === workspace.id && (
                <div className="ws-editor">
                  <label>默认检查命令（每行一个）
                    <textarea rows={3} value={editChecks} onChange={(event) => setEditChecks(event.target.value)} placeholder="npm test" />
                  </label>
                  <label>默认分支
                    <input value={editBranch} onChange={(event) => setEditBranch(event.target.value)} placeholder="main" />
                  </label>
                  {formError && <div className="form-error">{formError}</div>}
                  <div className="ws-editor-actions">
                    <button type="button" className="button secondary" onClick={() => setEditingId("")}>取消</button>
                    <button type="button" className="button primary" disabled={savingEdit} onClick={() => void saveEdit(workspace)}>
                      {savingEdit ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存
                    </button>
                  </div>
                </div>
              )}

              <footer className="ws-actions">
                <button type="button" disabled={pendingId === workspace.id} onClick={() => void refresh(workspace)}>
                  {pendingId === workspace.id ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}刷新 Git 状态
                </button>
                <button type="button" onClick={() => startEdit(workspace)}><SlidersHorizontal size={13} />默认检查</button>
                <button type="button" className="danger" disabled={pendingId === workspace.id} onClick={() => void unregister(workspace)}><Trash2 size={13} />解除注册</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
