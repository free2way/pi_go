import { LoaderCircle, Pencil, Rocket, RotateCcw } from "lucide-react";
import { runStateKey } from "./requirement-history";
import { estimateLabel, priorityKey, storyStatusKey } from "./agile-view";
import { formatTime } from "./agile-format";
import type { ConfigStatus } from "../shared/types";
import type { AgilePageState } from "./useAgilePage";

export function AgileStoryDetail({ state, config, onOpenRun }: { state: AgilePageState["detail"]; config?: ConfigStatus; onOpenRun: (runId: string) => void }) {
  const {
    detail, t, locale, sprintLabel, workspaces, editStory, busy, patchStatus, blockStory, unblockStory,
    reopenStory, submit,
  } = state;

  return (
    <>
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
    </>
  );
}
