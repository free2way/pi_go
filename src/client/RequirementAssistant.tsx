import { CheckCircle2, CircleHelp, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { localizeError } from "../shared/i18n";
import type { RequirementRefineInput, RequirementRefinement } from "../shared/requirement-assistant";
import type { ModelCatalogResponse } from "../shared/types";
import { api } from "./api";
import { useT } from "./i18n";
import { buildRoleModelOptions, modelOptionText, preferredModelId } from "./model-options";

interface RequirementAssistantProps {
  draft: string;
  title?: string;
  models?: ModelCatalogResponse;
  context: NonNullable<RequirementRefineInput["context"]>;
  onApply: (refinement: RequirementRefinement) => void;
}

function ResultSection({ title, children, empty }: { title: string; children: ReactNode; empty?: boolean }) {
  if (empty) return null;
  return (
    <section className="requirement-assistant-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function BulletList({ values }: { values: string[] }) {
  return <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>;
}

/** Optional, tool-free Pi preprocessor. It never creates a story/run or executes suggested checks. */
export function RequirementAssistant({ draft, title, models, context, onApply }: RequirementAssistantProps) {
  const { t, locale } = useT();
  const options = useMemo(() => buildRoleModelOptions(models?.models, "developer", locale), [locale, models?.models]);
  const preferredId = useMemo(
    () => preferredModelId(models?.models, "developer", models?.defaultDeveloper),
    [models?.defaultDeveloper, models?.models],
  );
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RequirementRefinement>();

  useEffect(() => {
    if (!options.some((option) => option.id === modelId && option.selectable)) setModelId(preferredId);
  }, [modelId, options, preferredId]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, open]);

  const selected = options.find((option) => option.id === modelId && option.selectable);
  const draftReady = draft.trim().length >= 10;
  const unavailable = options.every((option) => !option.selectable);
  const openAssistant = () => {
    setResult(undefined);
    setError("");
    setOpen(true);
  };
  const refine = async () => {
    if (!selected || !draftReady) return;
    setBusy(true);
    setError("");
    try {
      const refinement = await api.refineRequirement({
        draft: draft.trim(),
        title: title?.trim() || undefined,
        context,
        model: { provider: selected.provider, model: selected.model },
      }, locale);
      setResult(refinement);
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="requirement-assistant-trigger"
        onClick={openAssistant}
        disabled={!draftReady || unavailable}
        title={!draftReady ? t("requirementAssistant.emptyDraft") : unavailable ? t("requirementAssistant.unavailable") : undefined}
      >
        <Sparkles size={14} />
        {t("requirementAssistant.trigger")}
      </button>
      {open && (
        <div className="requirement-assistant-backdrop" onMouseDown={() => { if (!busy) setOpen(false); }}>
          <aside
            className="requirement-assistant-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="requirement-assistant-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="requirement-assistant-head">
              <div>
                <span className="eyebrow">PI · REQUIREMENT SPEC</span>
                <h2 id="requirement-assistant-title">{t("requirementAssistant.title")}</h2>
                <p>{t("requirementAssistant.subtitle")}</p>
              </div>
              <button type="button" className="icon-button" aria-label={t("requirementAssistant.close")} onClick={() => setOpen(false)} disabled={busy}>
                <X size={18} />
              </button>
            </header>

            <div className="requirement-assistant-controls">
              <label>
                {t("requirementAssistant.model")}
                <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={busy}>
                  {options.map((option) => (
                    <option key={option.id} value={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="button primary" onClick={() => void refine()} disabled={busy || !selected || !draftReady}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {t(busy ? "requirementAssistant.running" : "requirementAssistant.run")}
              </button>
            </div>

            {error && <div className="form-error requirement-assistant-error">{error}</div>}
            {result && (
              <div className="requirement-assistant-result">
                <div className="requirement-assistant-result-head">
                  <div>
                    <span className={`requirement-readiness is-${result.spec.readiness}`}>
                      {result.spec.readiness === "ready" ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}
                      {t(result.spec.readiness === "ready" ? "requirementAssistant.ready" : "requirementAssistant.needsClarification")}
                    </span>
                    <h3>{result.spec.title}</h3>
                  </div>
                  <small>{t("requirementAssistant.meta", {
                    provider: result.model.provider,
                    model: result.model.model,
                    seconds: (result.durationMs / 1_000).toFixed(1),
                  })}</small>
                </div>

                <ResultSection title={t("requirementAssistant.objective")}>
                  <p>{result.spec.objective}</p>
                </ResultSection>
                <ResultSection title={t("requirementAssistant.scope")} empty={!result.spec.inScope.length && !result.spec.outOfScope.length}>
                  <div className="requirement-scope-grid">
                    {!!result.spec.inScope.length && <div><strong>{t("requirementAssistant.inScope")}</strong><BulletList values={result.spec.inScope} /></div>}
                    {!!result.spec.outOfScope.length && <div><strong>{t("requirementAssistant.outOfScope")}</strong><BulletList values={result.spec.outOfScope} /></div>}
                  </div>
                </ResultSection>
                <ResultSection title={t("requirementAssistant.constraints")} empty={!result.spec.constraints.length}>
                  <BulletList values={result.spec.constraints} />
                </ResultSection>
                <ResultSection title={t("requirementAssistant.acceptance")} empty={!result.spec.acceptanceCriteria.length}>
                  <ol className="requirement-criteria">
                    {result.spec.acceptanceCriteria.map((criterion) => (
                      <li key={criterion.id}><code>{criterion.id}</code><span>{criterion.statement}</span><em>{criterion.verification}</em></li>
                    ))}
                  </ol>
                </ResultSection>
                <ResultSection title={t("requirementAssistant.dod")} empty={!result.spec.definitionOfDone.length}>
                  <BulletList values={result.spec.definitionOfDone} />
                </ResultSection>
                <ResultSection title={t("requirementAssistant.assumptions")} empty={!result.spec.assumptions.length}>
                  <BulletList values={result.spec.assumptions} />
                </ResultSection>
                <ResultSection title={t("requirementAssistant.risks")} empty={!result.spec.risks.length}>
                  <BulletList values={result.spec.risks} />
                </ResultSection>
                <ResultSection title={t("requirementAssistant.questions")} empty={!result.spec.openQuestions.length}>
                  <BulletList values={result.spec.openQuestions} />
                </ResultSection>
                <ResultSection title={t("requirementAssistant.checks")} empty={!result.spec.suggestedChecks.length}>
                  <div className="requirement-checks">
                    {result.spec.suggestedChecks.map((check) => <code key={check}>{check}</code>)}
                    <small>{t("requirementAssistant.checksHint")}</small>
                  </div>
                </ResultSection>
              </div>
            )}

            <footer className="requirement-assistant-actions">
              <button type="button" className="button secondary" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</button>
              <button
                type="button"
                className="button primary"
                disabled={!result || busy}
                onClick={() => {
                  if (!result) return;
                  onApply(result);
                  setOpen(false);
                }}
              >
                <CheckCircle2 size={15} />{t("requirementAssistant.apply")}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
