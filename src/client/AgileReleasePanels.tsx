import { Activity, Copy, Download, LoaderCircle, Pencil, Plus, Rocket, Trash2, X } from "lucide-react";
import { runStateKey } from "./requirement-history";
import { RELEASE_STATUSES, type ReleaseStatus } from "../shared/agile";
import { RELEASE_DEPLOY_ACTION_KEYS, releaseDeployAction, releaseExportJson, storyStatusKey } from "./agile-view";
import { releaseStatusKey, formatTime, deployStatusKey, formatDuration } from "./agile-format";
import { AgileReleaseProgressDialog } from "./AgileReleaseProgressDialog";
import type { AgilePageState } from "./useAgilePage";

export function AgileReleasePanels({ state }: { state: AgilePageState["releases"] }) {
  const {
    panel, t, releaseDetailId, setReleaseDetailId, releases, releaseSummary, releaseRetrospective,
    releaseExporting, exportRetrospective, setReleaseExportNote, releaseExportNote, locale,
    releaseLoading, saveRelease, releaseManageId, resetReleaseForm, releaseVersion, setReleaseVersion,
    releaseName, setReleaseName, releaseStatus, setReleaseStatus, releaseStoryIds, releaseNotes,
    setReleaseNotes, stories, toggleReleaseStory, busy, openReleaseProgress, openPublish, editRelease,
    removeRelease, publishTarget, closePublish, publishError, publishBlocked, publishBusy, publishReady,
    publishEnvironment, setPublishEnvironment, publishNote, setPublishNote, confirmPublish,
    releaseProgressOpen, progressRelease, releaseProgressError, setReleaseProgressOpen,
  } = state;

  return (
    <>
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
    </>
  );
}
