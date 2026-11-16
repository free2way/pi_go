import { FolderCog, ClipboardList, ListChecks, LoaderCircle, Rocket, Trash2 } from "lucide-react";
import { boardColumnKey, columnPoints, estimateLabel, priorityKey, storyReference, storyStatusKey, projectContentsLabel, projectDeletionWarning } from "./agile-view";
import { sprintStatusKey, releaseStatusKey } from "./agile-format";
import type { AgilePageState } from "./useAgilePage";

export function AgileBoard({ state }: { state: AgilePageState["board"] }) {
  const {
    panel, t, projects, locale, confirmDeleteId, setConfirmDeleteId, busy, confirmDeleteProject,
    setError, error, notice, loading, projectId, setProjectId, sprintFilter, setSprintFilter, sprints,
    selectedProject, columns, selectedId, setSelectedId, sprintLabel, editStory, blockStory,
    unblockStory, visibleStories, patchStatus, removeStory, editSprint, setSprintStatus, releases,
    setReleaseDetailId, setPanel,
  } = state;

  return (
    <>
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
    </>
  );
}
