import { Check, ChevronDown, Copy, ExternalLink, History, Inbox, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Run, RunState } from "../shared/types";
import { api } from "./api";
import {
  RUN_STATE_OPTIONS,
  copyTextForRun,
  formatHistoryTime,
  humanNoteKindLabel,
  humanNotesOf,
  requirementSummary,
  runStateLabels,
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
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<"" | RunState>("");
  const [items, setItems] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();

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
        if (active) setError((cause as Error).message || "加载需求历史失败。");
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
      setError("复制失败，请展开后手动选择文本复制。");
    }
  };

  const filtering = Boolean(debouncedQuery || state);

  return (
    <section className="history-page">
      <div className="history-heading">
        <div>
          <span className="eyebrow">REQUIREMENT HISTORY</span>
          <h1>需求历史</h1>
          <p>搜索过去任务里写下的详细需求，展开查看全文、人工备注，并可一键复制复用。</p>
        </div>
        <div className="history-count"><History size={15} />{items.length} 条记录</div>
      </div>

      <div className="history-toolbar">
        <label className="history-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、需求正文或人工备注…"
            aria-label="搜索需求历史"
          />
          {query && <button type="button" className="history-clear" onClick={() => setQuery("")} aria-label="清空搜索"><X size={13} /></button>}
        </label>
        <select className="history-state-filter" value={state} onChange={(event) => setState(event.target.value as "" | RunState)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          {RUN_STATE_OPTIONS.map((option) => <option value={option} key={option}>{runStateLabels[option]}</option>)}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="history-list">
        {loading && items.length === 0 && <div className="history-empty"><LoaderCircle className="spin" size={20} /><span>正在加载需求历史…</span></div>}
        {!loading && items.length === 0 && (
          <div className="history-empty">
            <Inbox size={22} />
            <span>{filtering ? "没有匹配的需求，换个关键词或状态试试。" : "还没有任务需求记录。"}</span>
          </div>
        )}
        {items.map((run) => {
          const expanded = expandedId === run.id;
          const notes = humanNotesOf(run);
          return (
            <article className={`history-row ${expanded ? "expanded" : ""}`} key={run.id}>
              <button type="button" className="history-row-head" onClick={() => setExpandedId(expanded ? undefined : run.id)} aria-expanded={expanded}>
                <time className="history-time">{formatHistoryTime(run.updatedAt)}</time>
                <span className={`status-pill status-${run.state}`}><i />{runStateLabels[run.state]}</span>
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
                        {copiedId === run.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === run.id ? "已复制" : "复制"}
                      </button>
                      <button type="button" className="button secondary" onClick={() => onOpenRun(run.id)}>
                        <ExternalLink size={13} />打开任务
                      </button>
                    </div>
                  </div>
                  <h4 className="history-detail-title">{run.title}</h4>
                  <pre className="history-task">{run.task}</pre>
                  <div className="history-notes">
                    <span className="eyebrow">HUMAN NOTES · {notes.length}</span>
                    {notes.length === 0 ? (
                      <p className="history-notes-empty">暂无人工备注（审批备注、恢复指令或拒绝原因会保存在这里）。</p>
                    ) : (
                      <ol className="history-note-list">
                        {notes.map((note, index) => (
                          <li key={`${note.at}-${note.kind}-${index}`}>
                            <div className="history-note-head">
                              <span className={`history-note-kind kind-${note.kind}`}>{humanNoteKindLabel(note.kind)}</span>
                              <time>{formatHistoryTime(note.at)}</time>
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
    </section>
  );
}
