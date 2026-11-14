import { ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, CornerDownLeft, MessagesSquare, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useT, type TFunction } from "../i18n";
import { chatCounts, chatMessageView, chatTabs, filterChatMessages, isReviewMessage, messageFindings, type ChatTab, type ReworkBranchDetail } from "../../shared/chat";
import type { ChatMessage, Run } from "../../shared/types";

import { EmptyPanel, formatClock } from "./display";

function participantName(participant: ChatMessage["from"], run: Run, t: TFunction) {
  if (participant === "developer") return run.developer.model;
  if (participant === "reviewer") return run.reviewer.model;
  return t(`chat.participant.${participant}`);
}

function participantInitials(participant: ChatMessage["from"]) {
  if (participant === "orchestrator") return "OR";
  if (participant === "developer") return "DEV";
  if (participant === "reviewer") return "REV";
  if (participant === "checks") return "CI";
  return "USR";
}

function ChatMessageItem({ message, run, expanded, onToggle, canJumpToRound, onJumpToRound }: {
  message: ChatMessage;
  run: Run;
  expanded: boolean;
  onToggle: (id: string, next: boolean) => void;
  canJumpToRound: boolean;
  onJumpToRound: (round: number) => void;
}) {
  const { t, locale } = useT();
  const [copied, setCopied] = useState(false);
  const view = useMemo(() => chatMessageView(message, expanded), [message, expanded]);
  const findings = useMemo(() => messageFindings(message), [message]);
  // Real review hand-offs persist their findings as a JSON body; once rendered
  // structurally that raw JSON is redundant (copy still yields the full body).
  const structuredOnly = findings.length > 0 && message.content.trim().startsWith("[");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard API can be unavailable (insecure origin / denied): keep the
      // message readable instead of surfacing a failure.
      setCopied(false);
    }
  };
  return (
    <article className={`chat-message chat-${message.channel} role-${message.role}`}>
      <span className="chat-avatar">{message.agent ? message.agent.slice(0, 2) : participantInitials(message.from)}</span>
      <div className="chat-bubble">
        <div className="chat-meta">
          <strong>{message.agent ?? participantName(message.from, run, t)}</strong>
          <ArrowRight size={11} />
          <span>{participantName(message.to, run, t)}</span>
          <em className={`chat-channel-tag tag-${message.channel}`}>{t(`chat.channel.${message.channel}`)}</em>
          <em className="chat-round">R{message.round}</em>
          <time>{formatClock(message.at, locale)}</time>
          <button type="button" className="chat-copy" title={t("chat.copyTitle")} onClick={() => void copy()}>
            {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? t("common.copied") : t("common.copy")}
          </button>
          {canJumpToRound && (
            <button type="button" className="chat-copy" title={t("chat.jumpTopologyTitle", { round: message.round })} onClick={() => onJumpToRound(message.round)}>
              <CornerDownLeft size={11} />{t("chat.jumpTopology")}
            </button>
          )}
        </div>
        {findings.length > 0 && (
          <div className="chat-findings">
            <div className="chat-findings-head">{t("chat.findingsCount", { count: findings.length })}</div>
            {findings.map((item, index) => (
              <article className={`chat-finding sev-${item.severity}`} key={item.id ?? index}>
                <div className="chat-finding-head">
                  <span className={`fsev fsev-${item.severity}`}>{item.severity}</span>
                  <strong>{item.title}</strong>
                  <code>{item.file ?? "—"}{item.line ? `:${item.line}` : ""}</code>
                </div>
                {item.requiredChange && <p><ArrowUpRight size={11} />{item.requiredChange}</p>}
              </article>
            ))}
          </div>
        )}
        {!structuredOnly && (view.monospace
          ? <pre className="chat-text chat-mono">{view.text}</pre>
          : <p className="chat-text">{view.text}</p>)}
        {!structuredOnly && view.collapsible && (
          <button type="button" className="chat-toggle" aria-expanded={view.expanded} onClick={() => onToggle(message.id, !view.expanded)}>
            <ChevronDown size={12} className={view.expanded ? "chat-toggle-open" : ""} />
            {view.expanded ? t("chat.collapse") : t("chat.expand", { size: (view.bytes / 1024).toFixed(1) })}
          </button>
        )}
      </div>
    </article>
  );
}

export function ReworkDetail({ detail, onJumpToChat, onClose }: {
  detail: ReworkBranchDetail;
  onJumpToChat: (round: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const severities = (["critical", "high", "medium", "low"] as const).filter((severity) => detail.summary.bySeverity[severity] > 0);
  const hidden = detail.summary.total - detail.summary.top.length;
  return (
    <aside className="rework-detail" role="dialog" aria-label={t("rework.aria", { round: detail.round })}>
      <div className="rework-detail-head">
        <strong>{t("rework.title", { round: detail.round })}</strong>
        <button type="button" className="rework-close" title={t("common.close")} onClick={onClose}><X size={13} /></button>
      </div>
      <p className="rework-reason">{detail.reason}</p>
      <div className="rework-summary">
        <span>{t("rework.total", { total: detail.summary.total })}</span>
        {severities.map((severity) => (
          <em key={severity} className={`fsev fsev-${severity}`}>{severity} {detail.summary.bySeverity[severity]}</em>
        ))}
      </div>
      {detail.summary.top.length > 0 ? (
        <ul className="rework-findings">
          {detail.summary.top.map((item, index) => (
            <li key={item.id ?? index}>
              <span className={`fsev fsev-${item.severity}`}>{item.severity}</span>
              <span className="rework-finding-title">{item.title}</span>
              <code>{item.file ?? "—"}{item.line ? `:${item.line}` : ""}</code>
            </li>
          ))}
        </ul>
      ) : <p className="rework-empty">{t("rework.empty")}</p>}
      {hidden > 0 && <p className="rework-more">{t("rework.more", { count: hidden })}</p>}
      <button type="button" className="button secondary" onClick={() => onJumpToChat(detail.round)}>
        <CornerDownLeft size={13} />{t("rework.jumpChat")}
      </button>
    </aside>
  );
}

export function ChatLog({ messages, run, activeTab, onTabChange, roundFilter, onClearRoundFilter, reworkRounds, onJumpToRound }: {
  messages: ChatMessage[];
  run: Run;
  activeTab: ChatTab;
  onTabChange: (tab: ChatTab) => void;
  roundFilter: number | null;
  onClearRoundFilter: () => void;
  reworkRounds: ReadonlySet<number>;
  onJumpToRound: (round: number) => void;
}) {
  const { t } = useT();
  const counts = useMemo(() => chatCounts(messages), [messages]);
  const visible = useMemo(() => {
    const filtered = filterChatMessages(messages, activeTab);
    return roundFilter === null ? filtered : filtered.filter((message) => message.round === roundFilter);
  }, [messages, activeTab, roundFilter]);
  // Explicit per-message overrides; review messages expand by default so their
  // structured findings and full prompt are visible without a click, while the
  // operator can still collapse them (or open a long non-review message).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggle = (id: string, next: boolean) => setOverrides((current) => ({ ...current, [id]: next }));
  return (
    <section className="panel chat-panel" id="chat-log">
      <div className="chat-head">
        <div className="chat-title">
          <span className="eyebrow">AGENT CONVERSATION</span>
          <h3><MessagesSquare size={15} />{t("chat.title")}</h3>
        </div>
        <div className="chat-tabs" role="tablist" aria-label={t("chat.filterAria")}>
          {roundFilter !== null && (
            <button type="button" className="chat-round-filter" title={t("chat.clearRoundFilter")} onClick={onClearRoundFilter}>
              {t("chat.onlyRound", { round: roundFilter })}<X size={11} />
            </button>
          )}
          {chatTabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : ""}
              key={tab.id}
              title={t(`chat.tab.${tab.id}.hint`)}
              onClick={() => onTabChange(tab.id)}
            >
              {t(`chat.tab.${tab.id}`)}<em>{counts[tab.id]}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="chat-body">
        {visible.length === 0 ? (
          <EmptyPanel icon={MessagesSquare} text={roundFilter !== null ? t("chat.emptyRound", { round: roundFilter }) : activeTab === "all" ? t("chat.emptyWaiting") : t("chat.emptyCategory")} />
        ) : (
          <div className="chat-stream">
            {visible.map((message) => (
              <ChatMessageItem
                key={message.id}
                message={message}
                run={run}
                expanded={overrides[message.id] ?? isReviewMessage(message)}
                onToggle={toggle}
                canJumpToRound={reworkRounds.has(message.round)}
                onJumpToRound={onJumpToRound}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
