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
import { DEFAULT_LOCALE, intlLocale, t, type Locale } from "../shared/i18n";
import { api } from "./api";
import { useT } from "./i18n";

const namePattern = /^[A-Za-z0-9._-]{1,80}$/;

/** Same rules as the server/worker `isValidWorkspaceName`. */
function isValidName(value: string): boolean {
  return namePattern.test(value) && value !== "." && value !== "..";
}

function describeError(cause: unknown, locale: Locale = DEFAULT_LOCALE): string {
  const error = cause as { code?: string; message?: string };
  switch (error.code) {
    case "WORKSPACE_EXISTS":
      return t(locale, "workspace.error.WORKSPACE_EXISTS");
    case "WORKSPACE_NOT_FOUND":
      return t(locale, "workspace.error.WORKSPACE_NOT_FOUND");
    case "WORKSPACE_OUTSIDE_ROOT":
      return t(locale, "workspace.error.WORKSPACE_OUTSIDE_ROOT");
    case "WORKSPACE_INVALID": {
      const raw = error.message || "";
      if (raw.includes("does not exist")) return t(locale, "workspace.error.WORKSPACE_INVALID_DIR_MISSING");
      if (raw.includes("Not a Git repository")) return t(locale, "workspace.error.WORKSPACE_INVALID_NOT_GIT");
      if (raw.includes("Invalid workspace name")) return t(locale, "workspace.error.WORKSPACE_INVALID_NAME");
      if (raw.includes("Invalid workspace path")) return t(locale, "workspace.error.WORKSPACE_INVALID_PATH");
      return t(locale, "workspace.error.WORKSPACE_INVALID");
    }
    case "WORKSPACES_DISABLED":
      return t(locale, "workspace.error.WORKSPACES_DISABLED");
    case "WORKSPACE_READ_ONLY":
      return t(locale, "workspace.error.WORKSPACE_READ_ONLY");
    default:
      return error.message || t(locale, "workspace.error.generic");
  }
}

const formatTime = (date: string | null, locale: Locale = DEFAULT_LOCALE) =>
  date
    ? new Intl.DateTimeFormat(intlLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date))
    : "—";

const statusKeys = {
  active: "workspace.status.active",
  invalid: "workspace.status.invalid",
  unregistered: "workspace.status.unregistered",
} as const satisfies Record<Workspace["status"], string>;

export function WorkspacesPage({ config, runs, onOpenCredentials }: {
  config?: ConfigStatus;
  runs: Run[];
  onOpenCredentials: () => void;
}) {
  const { t, locale } = useT();
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
      setLoadError(describeError(cause, locale));
    } finally {
      setLoading(false);
    }
  }, [locale]);

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
      setFormError(describeError(cause, locale));
    } finally {
      setSubmitting(false);
    }
  };

  const submitClone = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = cloneName.trim();
    if (!isValidName(name)) {
      setFormError(t("workspace.invalidName"));
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
      setFormError(describeError(cause, locale));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = createName.trim();
    if (!isValidName(name)) {
      setFormError(t("workspace.invalidName"));
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
      setFormError(describeError(cause, locale));
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
      window.alert(t("workspace.refreshFailed", { message: describeError(cause, locale) }));
      await load();
    } finally {
      setPendingId("");
    }
  };

  const unregister = async (workspace: Workspace) => {
    if (!window.confirm(t("workspace.unregisterConfirm", { name: workspace.name }))) return;
    setPendingId(workspace.id);
    try {
      await api.unregisterWorkspace(workspace.id);
      await load();
    } catch (cause) {
      window.alert(t("workspace.unregisterFailed", { message: describeError(cause, locale) }));
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
      setFormError(describeError(cause, locale));
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">SERVER WORKSPACES</span>
          <h1>{t("nav.workspaces")}</h1>
          <p>{t("workspace.subtitle")}</p>
        </div>
        <div className="ws-heading-actions">
          <button className="button secondary" onClick={() => { setPanel(panel === "create" ? "none" : "create"); setFormError(""); }}><FolderPlus size={15} />{t("workspace.newDir")}</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "register" ? "none" : "register"); setFormError(""); }}><Plus size={15} />{t("workspace.registerExisting")}</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "clone" ? "none" : "clone"); setFormError(""); }}><GitBranch size={15} />{t("workspace.clone")}</button>
        </div>
      </section>

      <div className={`ws-strip ${config?.realRunsAvailable ? "is-ready" : ""}`}>
        {config?.realRunsAvailable ? <Check size={14} /> : <AlertTriangle size={14} />}
        <div>
          <strong>{config?.realRunsAvailable ? t("config.realReady") : t("workspace.noKey")}</strong>
          <span>{config?.realRunsAvailable ? t("workspace.readyHint") : t("workspace.noKeyHint")}</span>
        </div>
        {!config?.realRunsAvailable && <button type="button" onClick={onOpenCredentials}>{t("workspace.configureKey")}</button>}
      </div>

      {panel !== "none" && (
        <div className="ws-forms">
          {panel === "create" && (
            <form className="ws-form" onSubmit={submitCreate}>
              <div className="ws-form-head">
                <div><span className="eyebrow">NEW WORKSPACE DIRECTORY</span><h3>{t("workspace.newDir")}</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">
                {t("workspace.createHelp1")}<code>PI_WORKSPACE_ROOT/projects</code>{t("workspace.createHelp2")}<code>/workspace/projects</code>{t("workspace.createHelp3")}<strong>{t("workspace.createHelpStrong")}</strong>{t("workspace.createHelp4")}
              </p>
              <label>{t("workspace.name")}
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="my-new-repo" autoFocus />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>{t("common.cancel")}</button>
                <button type="submit" className="button primary" disabled={submitting || !createName.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}{t("workspace.createAndRegister")}
                </button>
              </div>
            </form>
          )}
          {panel === "register" && (
            <form className="ws-form" onSubmit={submitRegister}>
              <div className="ws-form-head">
                <div><span className="eyebrow">REGISTER EXISTING</span><h3>{t("workspace.registerExisting")}</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">{t("workspace.registerHelp")}</p>
              <label>{t("workspace.relativePath")}
                <input value={relativePath} onChange={(event) => setRelativePath(event.target.value)} placeholder="my-repo" autoFocus />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>{t("common.cancel")}</button>
                <button type="submit" className="button primary" disabled={submitting || !relativePath.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t("workspace.registerAction")}
                </button>
              </div>
            </form>
          )}
          {panel === "clone" && (
            <form className="ws-form" onSubmit={submitClone}>
              <div className="ws-form-head">
                <div><span className="eyebrow">CLONE FROM GIT</span><h3>{t("workspace.clone")}</h3></div>
                <button className="icon-button" type="button" onClick={() => setPanel("none")}><X size={16} /></button>
              </div>
              <p className="ws-form-help">{t("workspace.cloneHelp")}</p>
              <label>Git URL
                <input value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/org/repo.git" autoFocus />
              </label>
              <label>{t("workspace.name")}
                <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="my-repo" />
              </label>
              {formError && <div className="form-error">{formError}</div>}
              <div className="ws-form-actions">
                <button type="button" className="button secondary" onClick={() => setPanel("none")}>{t("common.cancel")}</button>
                <button type="submit" className="button primary" disabled={submitting || !cloneUrl.trim() || !cloneName.trim()}>
                  {submitting ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}{t("workspace.cloneAndRegister")}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      {loading ? (
        <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("workspace.loading")}</span></div>
      ) : workspaces.length === 0 ? (
        <div className="ws-empty">
          <FolderGit2 size={26} />
          <strong>{t("workspace.empty")}</strong>
          <span>{t("workspace.emptyHint")}</span>
        </div>
      ) : (
        <div className="ws-grid">
          {workspaces.map((workspace) => {
            const readOnly = workspace.permission === "read";
            return (
            <article className="ws-card" key={workspace.id}>
              <header className="ws-card-head">
                <div className={`ws-icon ws-icon-${workspace.status}`}><FolderGit2 size={16} /></div>
                <div className="ws-title">
                  <strong>{workspace.name}</strong>
                  <span>{workspace.nodeId} · {workspace.rootPath}</span>
                </div>
                {readOnly && <span className="ws-permission" title={t("workspace.readOnlyTitle")}>{t("workspace.readOnly")}</span>}
                <span className={`ws-status ws-status-${workspace.status}`}>{t(statusKeys[workspace.status])}</span>
              </header>

              <div className="ws-meta">
                <div><span>{t("workspace.branch")}</span><strong>{workspace.git?.branch || workspace.defaultBranch || "—"}</strong></div>
                <div><span>HEAD</span><strong>{workspace.git?.head ? workspace.git.head.slice(0, 7) : "—"}</strong></div>
                <div><span>{t("workspace.worktree")}</span><strong className={workspace.git?.dirty ? "warn" : ""}>{workspace.git ? (workspace.git.dirty ? t("workspace.dirty") : t("workspace.clean")) : "—"}</strong></div>
                <div><span>{t("workspace.linkedRuns")}</span><strong>{runCountFor(workspace) || "—"}</strong></div>
                <div><span>{t("workspace.lastChecked")}</span><strong>{formatTime(workspace.lastCheckedAt, locale)}</strong></div>
              </div>

              {workspace.repositoryUrl && <div className="ws-repo"><GitBranch size={11} />{workspace.repositoryUrl}</div>}
              <div className="ws-checks">
                {workspace.defaultChecks.length > 0
                  ? workspace.defaultChecks.map((command) => <code key={command}>{command}</code>)
                  : <em>{t("workspace.noDefaultChecks")}</em>}
              </div>
              {workspace.git?.dirty && <div className="ws-dirty-note"><AlertTriangle size={11} />{t("workspace.dirtyNote")}</div>}
              {workspace.status === "invalid" && <div className="ws-dirty-note">{t("workspace.invalidNote")}</div>}

              {!readOnly && editingId === workspace.id && (
                <div className="ws-editor">
                  <label>{t("workspace.defaultChecks")}
                    <textarea rows={3} value={editChecks} onChange={(event) => setEditChecks(event.target.value)} placeholder="npm test" />
                  </label>
                  <label>{t("workspace.defaultBranch")}
                    <input value={editBranch} onChange={(event) => setEditBranch(event.target.value)} placeholder="main" />
                  </label>
                  {formError && <div className="form-error">{formError}</div>}
                  <div className="ws-editor-actions">
                    <button type="button" className="button secondary" onClick={() => setEditingId("")}>{t("common.cancel")}</button>
                    <button type="button" className="button primary" disabled={savingEdit} onClick={() => void saveEdit(workspace)}>
                      {savingEdit ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("common.save")}
                    </button>
                  </div>
                </div>
              )}

              <footer className="ws-actions">
                <button type="button" disabled={readOnly || pendingId === workspace.id} title={readOnly ? t("workspace.roRefresh") : undefined} onClick={() => void refresh(workspace)}>
                  {pendingId === workspace.id ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}{t("workspace.refresh")}
                </button>
                <button type="button" disabled={readOnly} title={readOnly ? t("workspace.roEditChecks") : undefined} onClick={() => startEdit(workspace)}><SlidersHorizontal size={13} />{t("workspace.editChecks")}</button>
                <button type="button" className="danger" disabled={readOnly || pendingId === workspace.id} title={readOnly ? t("workspace.roUnregister") : undefined} onClick={() => void unregister(workspace)}><Trash2 size={13} />{t("workspace.unregister")}</button>
              </footer>
            </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
