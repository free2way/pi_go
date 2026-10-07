import { Check, ChevronDown, Copy, ExternalLink, History, Inbox, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Run, RunState } from "../shared/types";
import { localizeError } from "../shared/i18n";
import { api } from "./api";
import { useT } from "./i18n";
import { paginate } from "./history-view";
import {
  RUN_STATE_OPTIONS,
  copyTextForRun,
  formatHistoryTime,
  humanNoteKindLabel,
  humanNotesOf,
  requirementSummary,
  runStateLabel,
} from "./requirement-history";

const DEBOUNCE_MS = 300;

/**
 * 需求历史: searchable view over past runs. Search and state filtering are
 * server-side (`GET /api/runs?query=&state=`), debounced so typing does not
 * fire a request per keystroke.
 */
export function HistoryPage({ runs, onOpenRun }: {
  runs: Run[];
  onOpenRun: (id: string) => void;
}) {
  const { t, locale } = useT();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<"" | RunState>("");
  const [items, setItems] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
  /** 需求：需求历史按每 10 条分页（1-based；越界页码由 paginate 夹紧）。 */
  const [page, setPage] = useState(1);

  // 过滤条件变化时回到第 1 页，避免"筛完停在空页"。
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, state]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Refetch when the newest run changes so a freshly created run shows up here.
  const newest = runs[0];
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.runs({ query: debouncedQuery || undefined, state: state || undefined })
      .then((next) => {
        if (!active) return;
        setItems(next);
        setError("");
      })
      .catch((cause) => {
        if (active) setError(localizeError(locale, cause as { code?: string; message?: string }, t("history.loadFailed")));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [debouncedQuery, state, newest?.id, newest?.updatedAt]);

  const copy = async (run: Run) => {
    try {
      await navigator.clipboard.writeText(copyTextForRun(run));
      setCopiedId(run.id);
      window.setTimeout(() => setCopiedId((current) => (current === run.id ? undefined : current)), 1_600);
    } catch {
      setError(t("history.copyFailed"));
    }
  };

  const filtering = Boolean(debouncedQuery || state);
  // 需求：每 10 条一页（作用在已过滤列表上）。
  const paged = paginate(items, page);

  return (
    <section className="history-page">
      <div className="history-heading">
        <div>
          <span className="eyebrow">REQUIREMENT HISTORY</span>
          <h1>{t("nav.history")}</h1>
          <p>{t("history.subtitle")}</p>
        </div>
        <div className="history-count"><History size={15} />{t("history.count", { count: items.length })}</div>
      </div>

      <div className="history-toolbar">
        <label className="history-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("history.searchPlaceholder")}
            aria-label={t("history.searchAria")}
          />
          {query && <button type="button" className="history-clear" onClick={() => setQuery("")} aria-label={t("history.clearSearch")}><X size={13} /></button>}
        </label>
        <select className="history-state-filter" value={state} onChange={(event) => setState(event.target.value as "" | RunState)} aria-label={t("history.filterAria")}>
          <option value="">{t("history.allStates")}</option>
          {RUN_STATE_OPTIONS.map((option) => <option value={option} key={option}>{runStateLabel(option, locale)}</option>)}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="history-list">
        {loading && items.length === 0 && <div className="history-empty"><LoaderCircle className="spin" size={20} /><span>{t("history.loading")}</span></div>}
        {!loading && items.length === 0 && (
          <div className="history-empty">
            <Inbox size={22} />
            <span>{filtering ? t("history.emptyFiltered") : t("history.empty")}</span>
          </div>
        )}
        {paged.items.map((run) => {
          const expanded = expandedId === run.id;
          const notes = humanNotesOf(run);
          return (
            <article className={`history-row ${expanded ? "expanded" : ""}`} key={run.id}>
              <button type="button" className="history-row-head" onClick={() => setExpandedId(expanded ? undefined : run.id)} aria-expanded={expanded}>
                <time className="history-time">{formatHistoryTime(run.updatedAt, locale)}</time>
                <span className={`status-pill status-${run.state}`}><i />{runStateLabel(run.state, locale)}</span>
                <strong className="history-title">{run.title}</strong>
                <span className="history-summary">{requirementSummary(run.task)}</span>
                <ChevronDown size={15} className={expanded ? "history-chevron open" : "history-chevron"} />
              </button>
              {expanded && (
                <div className="history-detail">
                  <div className="history-detail-head">
                    <span className="eyebrow">FULL REQUIREMENT</span>
                    <div className="history-detail-actions">
                      <button type="button" className="button secondary" onClick={() => void copy(run)}>
                        {copiedId === run.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === run.id ? t("common.copied") : t("common.copy")}
                      </button>
                      <button type="button" className="button secondary" onClick={() => onOpenRun(run.id)}>
                        <ExternalLink size={13} />{t("history.openRun")}
                      </button>
                    </div>
                  </div>
                  <h4 className="history-detail-title">{run.title}</h4>
                  <pre className="history-task">{run.task}</pre>
                  <div className="history-notes">
                    <span className="eyebrow">HUMAN NOTES · {notes.length}</span>
                    {notes.length === 0 ? (
                      <p className="history-notes-empty">{t("history.noNotes")}</p>
                    ) : (
                      <ol className="history-note-list">
                        {notes.map((note, index) => (
                          <li key={`${note.at}-${note.kind}-${index}`}>
                            <div className="history-note-head">
                              <span className={`history-note-kind kind-${note.kind}`}>{humanNoteKindLabel(note.kind, locale)}</span>
                              <time>{formatHistoryTime(note.at, locale)}</time>
                              {note.by && <small>{note.by}</small>}
                            </div>
                            <p>{note.note}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {paged.pageCount > 1 && (
        <nav className="history-pager" aria-label={t("history.pagerAria")}>
          <button
            type="button"
            className="button secondary"
            disabled={paged.page <= 1}
            onClick={() => setPage(paged.page - 1)}
          >
            {t("history.prev")}
          </button>
          <span className="history-pager-info">
            {t("history.pageOf", { page: paged.page, pages: paged.pageCount })}
            <small>{t("history.pageRange", { from: paged.from, to: paged.to, total: paged.total })}</small>
          </span>
          <button
            type="button"
            className="button secondary"
            disabled={paged.page >= paged.pageCount}
            onClick={() => setPage(paged.page + 1)}
          >
            {t("history.next")}
          </button>
        </nav>
      )}
    </section>
  );
}
