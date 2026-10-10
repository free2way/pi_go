import { Bot, Eraser, LoaderCircle, MessageCircleMore, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { localizeError } from "../shared/i18n";
import type { PiAssistantMessage, PiAssistantPage } from "../shared/pi-assistant";
import type { ModelCatalogResponse, Run } from "../shared/types";
import { api } from "./api";
import { useT } from "./i18n";
import { buildRoleModelOptions, modelOptionText, preferredModelId } from "./model-options";
import { buildPiAssistantContext } from "./pi-assistant-context";

interface PiAssistantProps {
  page: PiAssistantPage;
  run?: Run;
}

interface DisplayMessage extends PiAssistantMessage {
  id: string;
  meta?: string;
}

function initialPromptKeys(page: PiAssistantPage, run?: Run) {
  if (page === "run") {
    if (run?.state === "failed") return ["piAssistant.quick.failure", "piAssistant.quick.next", "piAssistant.quick.retry"] as const;
    if (run?.state === "needs_human") return ["piAssistant.quick.decision", "piAssistant.quick.findings", "piAssistant.quick.next"] as const;
    return ["piAssistant.quick.status", "piAssistant.quick.next", "piAssistant.quick.findings"] as const;
  }
  if (page === "release-settings") return ["piAssistant.quick.release", "piAssistant.quick.promotion", "piAssistant.quick.releaseFailure"] as const;
  if (page === "workspaces") return ["piAssistant.quick.workspace", "piAssistant.quick.scm", "piAssistant.quick.next"] as const;
  if (page === "agile") return ["piAssistant.quick.requirement", "piAssistant.quick.sprint", "piAssistant.quick.next"] as const;
  if (page === "models") return ["piAssistant.quick.models", "piAssistant.quick.routing", "piAssistant.quick.next"] as const;
  return ["piAssistant.quick.page", "piAssistant.quick.next", "piAssistant.quick.help"] as const;
}

export function PiAssistant({ page, run }: PiAssistantProps) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogResponse>();
  const [modelId, setModelId] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => buildRoleModelOptions(catalog?.models, "developer", locale), [catalog?.models, locale]);
  const preferredId = useMemo(
    () => preferredModelId(catalog?.models, "developer", catalog?.defaultDeveloper),
    [catalog?.defaultDeveloper, catalog?.models],
  );
  const promptKeys = initialPromptKeys(page, run);

  useEffect(() => {
    setMessages([]);
    setSuggestions([]);
    setDraft("");
    setError("");
  }, [page, run?.id]);

  useEffect(() => {
    if (!open || catalog) return;
    let active = true;
    void api.models().then((next) => {
      if (active) setCatalog(next);
    }).catch((cause) => {
      if (active) setError(localizeError(locale, cause as { code?: string; message?: string }));
    });
    return () => { active = false; };
  }, [catalog, locale, open]);

  useEffect(() => {
    if (!options.some((option) => option.id === modelId && option.selectable)) setModelId(preferredId);
  }, [modelId, options, preferredId]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [busy, messages, open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const selected = options.find((option) => option.id === modelId && option.selectable);
  const pageLabel = run && page === "run" ? run.title : t(`piAssistant.page.${page}`);

  const ask = async (question: string) => {
    const content = question.trim();
    if (!content || !selected || busy) return;
    const prior = messages.slice(-8).map(({ role, content: messageContent }) => ({ role, content: messageContent }));
    const userMessage: DisplayMessage = { id: crypto.randomUUID(), role: "user", content };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setSuggestions([]);
    setBusy(true);
    setError("");
    try {
      const result = await api.askAssistant({
        message: content,
        context: buildPiAssistantContext(page, run),
        history: prior,
        model: { provider: selected.provider, model: selected.model },
      }, locale);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.answer,
        meta: t("piAssistant.meta", {
          provider: result.model.provider,
          model: result.model.model,
          seconds: (result.durationMs / 1_000).toFixed(1),
          tokens: result.usage.totalTokens,
        }),
      }]);
      setSuggestions(result.suggestedQuestions);
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }, t("piAssistant.failed")));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  return (
    <>
      <button
        type="button"
        className={`pi-assistant-fab ${open ? "is-open" : ""}`}
        aria-label={t("piAssistant.open")}
        aria-expanded={open}
        aria-controls="pi-assistant-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={20} /> : <MessageCircleMore size={21} />}
        {!open && <span>{t("piAssistant.shortLabel")}</span>}
      </button>

      {open && (
        <aside id="pi-assistant-panel" className="pi-assistant-panel" role="dialog" aria-modal="false" aria-labelledby="pi-assistant-title">
          <header className="pi-assistant-head">
            <div className="pi-assistant-mark"><Bot size={19} /></div>
            <div>
              <span className="eyebrow">PI · CONTEXT ASSISTANT</span>
              <h2 id="pi-assistant-title">{t("piAssistant.title")}</h2>
            </div>
            <button type="button" className="icon-button" aria-label={t("piAssistant.close")} onClick={() => setOpen(false)}><X size={17} /></button>
          </header>

          <div className="pi-assistant-context">
            <span><Sparkles size={13} />{t("piAssistant.context")}</span>
            <strong title={pageLabel}>{pageLabel}</strong>
            <em><ShieldCheck size={12} />{t("piAssistant.readOnly")}</em>
          </div>

          <div className="pi-assistant-model-row">
            <label htmlFor="pi-assistant-model">{t("piAssistant.model")}</label>
            <select id="pi-assistant-model" value={modelId} disabled={busy} onChange={(event) => setModelId(event.target.value)}>
              {!options.length && <option value="">{t("piAssistant.modelsLoading")}</option>}
              {options.map((option) => <option key={option.id} value={option.id} disabled={!option.selectable}>{modelOptionText(option)}</option>)}
            </select>
            {!!messages.length && <button type="button" className="pi-assistant-clear" disabled={busy} onClick={() => { setMessages([]); setSuggestions([]); setError(""); }}><Eraser size={13} />{t("piAssistant.clear")}</button>}
          </div>

          <div className="pi-assistant-thread" ref={scrollRef} aria-live="polite">
            {!messages.length && (
              <div className="pi-assistant-empty">
                <h3>{t("piAssistant.emptyTitle")}</h3>
                <p>{t("piAssistant.emptyBody")}</p>
                <div className="pi-assistant-prompts">
                  {promptKeys.map((key) => <button type="button" key={key} onClick={() => void ask(t(key))} disabled={!selected || busy}>{t(key)}</button>)}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`pi-assistant-message is-${message.role}`}>
                <span>{message.role === "assistant" ? "PI" : t("piAssistant.you")}</span>
                <p>{message.content}</p>
                {message.meta && <small>{message.meta}</small>}
              </article>
            ))}
            {busy && <div className="pi-assistant-thinking"><LoaderCircle className="spin" size={15} /><span>{t("piAssistant.thinking")}</span></div>}
            {error && <div className="form-error pi-assistant-error">{error}</div>}
            {!!suggestions.length && !busy && (
              <div className="pi-assistant-suggestions">
                {suggestions.map((question) => <button type="button" key={question} onClick={() => void ask(question)}>{question}</button>)}
              </div>
            )}
          </div>

          <form className="pi-assistant-composer" onSubmit={submit}>
            <textarea
              rows={3}
              value={draft}
              maxLength={2_000}
              disabled={busy}
              placeholder={t("piAssistant.placeholder")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (draft.trim()) void ask(draft);
                }
              }}
            />
            <div>
              <small>{t("piAssistant.confirmationHint")}</small>
              <button type="submit" className="pi-assistant-send" disabled={busy || !selected || !draft.trim()} aria-label={t("piAssistant.send")}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
              </button>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}
