import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle, Play, RotateCcw, ShieldCheck, Square, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { localizeError } from "../../shared/i18n";
import { useT } from "../i18n";
import { describeMergeRestore, mergeRestoreFields } from "../../shared/merge";
import { findingFingerprint } from "../../shared/finding-fingerprint";
import type { DecisionBrief } from "../../shared/decision-brief";
import type { CurrentUser, Run, RunEvent } from "../../shared/types";
import { api } from "../api";
import { decisionBriefHeadingKey, decisionBriefTone, decisionGateDetail, decisionRecommendationNote, decisionStopMessage, gateNavTarget, groupRemainingByAc, decisionGateKeys, decisionRemainingGroupKey } from "../decision-brief-view";
import { mergeOptionState } from "../merge-option";

import type { RunDetailTab } from "./RunDetailPanels";

/**
 * 决策摘要 (docs/22 §2): a first-screen card on the run detail that answers the
 * single question a parked run raises — accept or continue? Purely presentational:
 * every status/verdict comes from the server's shared pure function.
 */
export function DecisionBriefCard({
  brief,
  run,
  open,
  onToggle,
  onOpenFinding,
  onOpenTab,
}: {
  brief: DecisionBrief;
  run: Run;
  open: boolean;
  onToggle: () => void;
  onOpenFinding: (key: string) => void;
  onOpenTab: (tab: RunDetailTab) => void;
}) {
  const { t, locale } = useT();
  const findingsByKey = useMemo(
    () => new Map(run.findings.map((finding) => [finding.fingerprint ?? findingFingerprint(finding), finding])),
    [run.findings],
  );
  const groups = groupRemainingByAc(brief.remaining);
  const tone = decisionBriefTone(brief);
  const stop = brief.stopReason;
  // docs/24-i18n.md §9: the brief carries both languages, so the code-generated
  // judgement text follows the UI language without a refetch.
  const stopMessage = decisionStopMessage(stop, locale);
  const recommendationNote = decisionRecommendationNote(brief, locale);

  return (
    <section className={`decision-brief decision-brief-${tone}`} id="decision-brief">
      <button type="button" className="decision-brief-head" aria-expanded={open} onClick={onToggle}>
        <div className="decision-brief-title">
          <span className="eyebrow">DECISION BRIEF</span>
          <h3>{t(decisionBriefHeadingKey(brief))}</h3>
        </div>
        <div className="decision-stop">
          <em>{stop.code}</em>
          {stopMessage ? <span>{stopMessage}</span> : null}
        </div>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open ? (
        <div className="decision-body">
          <div className="decision-gates">
            {brief.gates.map((gate) => {
              const target = gateNavTarget(gate);
              return (
                <div className={`decision-gate decision-gate-${gate.status}`} key={gate.id}>
                  <span className="decision-gate-light" />
                  <strong>{t(decisionGateKeys[gate.id])}</strong>
                  <small>{decisionGateDetail(gate, locale)}</small>
                  {gate.status !== "green" ? (
                    <button
                      type="button"
                      className="decision-gate-link"
                      onClick={() => {
                        if (target.key) onOpenFinding(target.key);
                        else onOpenTab(target.tab);
                      }}
                    >
                      {t("decision.locate")}<ArrowRight size={12} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {groups.length > 0 ? (
            <div className="decision-remaining">
              {groups.map((group) => {
                const groupKey = decisionRemainingGroupKey(group.kind);
                const label = group.ac ?? (groupKey ? t(groupKey) : group.kind);
                return (
                <div className="decision-group" key={label}>
                  <span className="decision-group-label">{label}</span>
                  {group.items.map((item) => {
                    const finding = findingsByKey.get(item.key);
                    return (
                      <button type="button" className="decision-finding" key={item.key} title={t("decision.locateFindingTitle")} onClick={() => onOpenFinding(item.key)}>
                        <span className={`decision-sev decision-sev-${item.severity}`}>{item.severity}</span>
                        <span className="decision-finding-title">{finding?.title ?? item.key}</span>
                        {item.streak > 0 ? <em>{t("decision.streak", { count: item.streak })}</em> : null}
                        {!item.evidenceOk ? <em className="decision-suspect">{t("decision.suspected")}</em> : null}
                      </button>
                    );
                  })}
                </div>
                );
              })}
            </div>
          ) : null}
          <div className="decision-reco">
            <p><ShieldCheck size={14} />{recommendationNote}</p>
            <span className="decision-advisory">{t("decision.advisory")}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function HumanInterventionPanel({ run, events, user, onUpdated }: { run: Run; events: RunEvent[]; user?: CurrentUser; onUpdated: (run: Run) => void }) {
  const { t, locale } = useT();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"" | "resume" | "review" | "terminate" | "continue" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const [mergeNotice, setMergeNotice] = useState("");
  // A2: admin-only merge on accept; the server enforces the admin check, and the
  // UI mirrors it so a non-admin is never offered an action that can only 403.
  const mergeOption = mergeOptionState(user, locale);
  const [mergeIntoWorkspace, setMergeIntoWorkspace] = useState(false);
  // Convergence guardrail: the operator can narrow the continued round to the
  // blocking (critical/high) findings so medium/low notes no longer loop.
  const [reviewScope, setReviewScope] = useState<"all" | "blocking">(run.reviewScope === "blocking" ? "blocking" : "all");
  const unresolved = run.findings.filter((item) => !item.resolved).length;
  // R: the latest merge failure's restore state, so the line survives a reload
  // (the worker records `run.merge_failed` with `restored`/`restoreError`).
  const eventNotice = useMemo(() => {
    const failure = [...events].reverse().find((event) => event.type === "run.merge_failed");
    return failure
      ? describeMergeRestore(mergeRestoreFields({ restored: failure.meta?.restored, restoreError: failure.meta?.restoreError }), locale)
      : undefined;
  }, [events, locale]);
  const restoreNotice = mergeNotice || eventNotice;
  const restoreFailed = restoreNotice?.startsWith(t("merge.restoreFailed")) ?? false;

  // If the merge option is (or becomes) unavailable, never send a stale `true`.
  useEffect(() => {
    if (mergeOption.disabled) setMergeIntoWorkspace(false);
  }, [mergeOption.disabled]);

  const act = async (kind: "resume" | "review" | "terminate" | "continue" | "approve" | "reject") => {
    setError("");
    setMergeNotice("");
    if (kind === "terminate" && !window.confirm(t("human.terminateConfirm", { title: run.title }))) return;
    if (kind === "reject" && !window.confirm(t("human.rejectConfirm", { title: run.title }))) return;
    if (kind === "approve" && !window.confirm(
      `${unresolved > 0 ? t("human.approveConfirmOpen", { title: run.title, count: unresolved }) : t("human.approveConfirmOk", { title: run.title })}${mergeIntoWorkspace ? t("human.approveMergeSuffix") : t("human.approveNoMergeSuffix")}`,
    )) return;
    setBusy(kind);
    try {
      if (kind === "resume") {
        onUpdated(await api.resumeRun(run.id, { instruction: instruction.trim() || undefined }));
      } else if (kind === "review") {
        onUpdated(await api.retryReviewRun(run.id));
      } else if (kind === "continue") {
        // "继续开发" never warns: it sends the run back for another round.
        onUpdated(await api.approveRun(run.id, { mode: "continue", note: instruction.trim() || undefined, reviewScope }));
      } else if (kind === "approve") {
        onUpdated(await api.approveRun(run.id, {
          mode: "accept",
          note: instruction.trim() || undefined,
          acknowledgeOpenFindings: unresolved > 0,
          mergeIntoWorkspace,
        }));
      } else if (kind === "reject") {
        onUpdated(await api.rejectRun(run.id, { reason: instruction.trim() || undefined }));
      } else {
        onUpdated(await api.cancelRun(run.id));
      }
    } catch (cause) {
      const failure = cause as Error & { code?: string; body?: Record<string, unknown> };
      setError(localizeError(locale, failure, failure.message));
      // R: surface the workspace-restore state even before the event list refreshes.
      const immediate = describeMergeRestore(mergeRestoreFields({ restored: failure.body?.restored, restoreError: failure.body?.restoreError }), locale);
      if (immediate) setMergeNotice(immediate);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="human-panel">
      <div className="human-panel-head">
        <div><span className="eyebrow">HUMAN IN THE LOOP</span><h3>{t("human.title")}</h3></div>
        <span className="human-reason">{run.summary}</span>
      </div>
      <p className="human-hint">{t("human.hint", { count: unresolved })}</p>
      <label>{t("human.instruction")}
        <textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t("human.instructionPlaceholder")} disabled={Boolean(busy)} />
      </label>
      {mergeOption.show && (
        <label className="merge-option" title={mergeOption.hint || undefined}>
          <input type="checkbox" checked={mergeIntoWorkspace} onChange={(event) => setMergeIntoWorkspace(event.target.checked)} disabled={Boolean(busy) || mergeOption.disabled} />
          {t("human.mergeOption")}
        </label>
      )}
      {mergeOption.disabled && mergeOption.hint && <div className="merge-option-hint">{mergeOption.hint}</div>}
      <label className="review-scope-option">{t("human.reviewScope")}
        <select value={reviewScope} onChange={(event) => setReviewScope(event.target.value === "blocking" ? "blocking" : "all")} disabled={Boolean(busy)}>
          <option value="all">{t("human.scopeAll")}</option>
          <option value="blocking">{t("human.scopeBlocking")}</option>
        </select>
      </label>
      {restoreNotice && <div className={`merge-notice ${restoreFailed ? "merge-notice-warn" : ""}`}>{restoreNotice}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="human-actions">
        <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act("approve")}>
          {busy === "approve" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}{t("decision.accept")}
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("continue")}>
          {busy === "continue" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{t("decision.rework")}
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("resume")}>
          {busy === "resume" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("human.resume")}
        </button>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void act("review")}>
          {busy === "review" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{t("human.retryReview")}
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("reject")}>
          {busy === "reject" ? <LoaderCircle className="spin" size={15} /> : <XCircle size={15} />}{t("human.reject")}
        </button>
        <button type="button" className="button danger-text" disabled={Boolean(busy)} onClick={() => void act("terminate")}>
          {busy === "terminate" ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}{t("human.terminate")}
        </button>
      </div>
    </section>
  );
}
