/**
 * 决策审计 (docs/26 §8.2) — read-only panel for the redacted decision-audit
 * projection of one run.
 *
 * Purely presentational: it fetches `GET /api/runs/:runId/decisions` (owner
 * scoped server-side), maps each row through the pure `decisions-view.ts`
 * helpers, and renders. It never mutates anything and never shows the outbound
 * payload, a credential or the raw `stateManifest`.
 *
 * When the deployment has not enabled the engine — or enabled it without a
 * resolvable credential — the panel explains why there may be no decisions,
 * reusing the models & credentials page wording (no new phrasing).
 */

import { LoaderCircle, Scale } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DecisionAuditProjection } from "../shared/decision-audit";
import { localizeError } from "../shared/i18n";
import type { Run } from "../shared/types";
import { api } from "./api";
import { decisionCardView, decisionEngineNotice } from "./decisions-view";
import { useT } from "./i18n";
import type { ModelsPageConfig } from "./ModelsPage";

export function DecisionsPanel({ run, config }: { run: Run; config?: ModelsPageConfig }) {
  const { t, locale } = useT();
  const [decisions, setDecisions] = useState<DecisionAuditProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await api.decisions(run.id);
      setDecisions(body.decisions ?? []);
    } catch (cause) {
      setDecisions([]);
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setLoading(false);
    }
  }, [run.id, locale]);

  useEffect(() => { void load(); }, [load]);

  // Only rendered when the deployment reports a decision plane — the same gate
  // the models page uses. `health` separates "not enabled" from "no credential".
  const engineStatus = config?.decisionEngine;
  const notice = decisionEngineNotice(engineStatus, locale);
  const cards = decisions.map((projection) => ({ projection, view: decisionCardView(projection, locale) }));

  return (
    <div className="decisions-panel">
      <div className="decisions-head">
        <div>
          <span className="eyebrow">DECISION AUDIT</span>
          <p>{t("decisions.subtitle")}</p>
        </div>
        <span className="decisions-readonly">{t("decisions.readonly")}</span>
      </div>

      {engineStatus && (
        <div className="decisions-engine">
          <span className={`model-verify ${notice.health === "ready" ? "ok" : "warn"}`} title={notice.hint}>{notice.state}</span>
          {notice.health !== "ready" && <span className="decisions-notice">{notice.hint}</span>}
        </div>
      )}

      {loading && <div className="ws-empty"><LoaderCircle className="spin" size={20} /><span>{t("decisions.loading")}</span></div>}

      {!loading && error && (
        <div className="form-error">
          {t("decisions.loadFailed")} {error}
          <button className="button" type="button" onClick={() => void load()}>{t("common.retry")}</button>
        </div>
      )}

      {!loading && !error && cards.length === 0 && (
        <div className="empty-panel"><Scale size={22} /><span>{t("decisions.empty")}</span></div>
      )}

      {!loading && !error && cards.length > 0 && (
        <>
          <div className="decisions-count">{t("decisions.count", { count: cards.length })}</div>
          <div className="decisions-list">
            {cards.map(({ projection, view }) => (
              <article className="decisions-card" key={projection.evaluationId}>
                <div className="decisions-card-head">
                  <span className={`model-verify ${view.status.tone}`}>{view.status.label}</span>
                  <span className="decisions-tag">{view.kindLabel}</span>
                  <span className="decisions-tag">{view.modeLabel}</span>
                  <time className="decisions-time">{view.createdAt}</time>
                </div>

                <div className="decisions-meta">
                  <span><em>{t("decisions.provider")}</em><code>{view.provider}</code></span>
                  <span>
                    <em>{t("decisions.model")}</em>
                    <code className={view.model.drifted ? "is-drift" : ""} title={view.model.drifted ? t("decisions.modelDrift") : undefined}>{view.model.text}</code>
                  </span>
                  <span><em>{t("decisions.policyVersion")}</em><code>{view.policyVersion}</code></span>
                  <span><em>{t("decisions.stateHash")}</em><code title={view.stateHash}>{view.stateHashShort}</code></span>
                  <span><em>{t("decisions.questionSchemaHash")}</em><code title={view.questionSchemaHash}>{view.questionSchemaHashShort}</code></span>
                  <span><em>{t("decisions.latency")}</em><strong>{view.latencyLabel}</strong></span>
                  {view.tokensLabel && <span><em>Tokens</em><strong>{view.tokensLabel}</strong></span>}
                  <span>
                    <em>{t("decisions.cost")}</em>
                    <strong className={view.costKind === "unknown" ? "is-unknown" : ""}>{view.costLabel}</strong>
                  </span>
                  {view.manifestLabel && <span><em>state</em><code>{view.manifestLabel}</code></span>}
                </div>

                {view.appliedOutcome && (
                  <div className="decisions-line"><em>{t("decisions.appliedOutcome")}</em><code>{view.appliedOutcome}</code></div>
                )}
                {(view.fallbackReason || view.detail) && (
                  <div className="decisions-line is-warn">
                    {view.fallbackReason && <><em>{t("decisions.fallbackReason")}</em><code>{view.fallbackReason}</code></>}
                    {view.detail && <span>{view.detail}</span>}
                  </div>
                )}

                <div className="decisions-answers">
                  <div className="decisions-answers-title">{t("decisions.answers", { count: view.answers.length })}</div>
                  {view.answers.length === 0 ? (
                    <div className="budget-empty">{t("decisions.noAnswers")}</div>
                  ) : (
                    <>
                      <div className="decisions-answers-head">
                        <span>{t("decisions.answerQuestion")}</span>
                        <span>{t("decisions.answerType")}</span>
                        <span>{t("decisions.answerValue")}</span>
                        <span>{t("decisions.answerMetrics")}</span>
                      </div>
                      {view.answers.map((answer, index) => (
                        <div className="decisions-answers-row" key={`${answer.fullQuestionId}-${index}`}>
                          <code title={answer.fullQuestionId}>{answer.questionId}</code>
                          <span>{answer.typeLabel}</span>
                          <span>{answer.value}</span>
                          <span>{answer.metrics.map((metric) => `${metric.label} ${metric.value}`).join(" · ")}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
