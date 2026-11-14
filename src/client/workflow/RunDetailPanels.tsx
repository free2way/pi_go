import { Activity, ArrowUpRight, Bot, Check, CircleDot, Copy, Download, FileCode2, GitPullRequestArrow, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { localizeError } from "../../shared/i18n";
import { useT } from "../i18n";
import { roleCostDisplay, roleCostLabel, roleDisplayName, totalUnpricedCalls } from "../budget-roles-view";
import { findingFingerprint } from "../../shared/finding-fingerprint";
import type { Finding, Run, RunArtifact, RunEvent, RunRoleUsage } from "../../shared/types";
import { api } from "../api";
import { deferredNonBlockingNotice } from "../run-events";

import { EmptyPanel, compactNumber, formatClock } from "./display";

export type RunDetailTab = "activity" | "agents" | "review" | "diff" | "checks" | "budget" | "decisions" | "artifacts";

export function ActivityPanel({ events }: { events: RunEvent[] }) {
  const { t } = useT();
  // Chat entries have their own transcript panel; the activity feed stays a
  // pure orchestration timeline instead of duplicating every chat message.
  const activity = events.filter((event) => event.type !== "chat.message");
  if (!activity.length) return <EmptyPanel icon={Activity} text={t("activity.empty")} />;
  return (
    <div className="timeline">
      {[...activity].reverse().map((event) => (
        <div className={`timeline-item source-${event.source}`} key={event.seq}>
          <span className="timeline-dot" />
          <div className="timeline-content">
            <div><strong>{event.message}</strong><time>{formatClock(event.at)}</time></div>
            <span>{event.source} · {event.type}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ReviewPanel({ findings, highlightKey }: { findings: Finding[]; highlightKey?: string | null }) {
  const { t } = useT();
  // 决策摘要: scroll the target finding into view when a red gate item links here.
  useEffect(() => {
    if (!highlightKey) return;
    document.getElementById(`finding-${highlightKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightKey]);
  if (!findings.length) return <EmptyPanel icon={ShieldCheck} text={t("review.empty")} />;
  return (
    <div className="finding-list">
      {findings.map((item) => {
        const key = item.fingerprint ?? findingFingerprint(item);
        return (
          <article id={`finding-${key}`} className={`finding finding-${item.severity}${key === highlightKey ? " finding-flagged" : ""}`} key={item.id}>
            <div className="finding-head">
              <span>{item.severity}</span>
              {item.resolved && <em><Check size={12} />{t("review.resolved")}</em>}
            </div>
            <h4>{item.title}</h4>
            <code>{item.file}:{item.line}</code>
            <p>{item.evidence}</p>
            <div className="required-change"><ArrowUpRight size={13} />{item.requiredChange}</div>
          </article>
        );
      })}
    </div>
  );
}

export function SubAgentsPanel({ run }: { run: Run }) {
  const { t } = useT();
  if (!run.plan) return <EmptyPanel icon={Bot} text={t("agents.empty")} />;
  return (
    <div className="agent-plan">
      <div className="agent-plan-summary"><span>{run.plan.complexity} · {run.plan.strategy}</span><p>{run.plan.rationale}</p></div>
      {run.plan.tasks.map((task, index) => (
        <article className={`subagent-row subagent-${task.status}`} key={task.id}>
          <span className="subagent-index">{String(index + 1).padStart(2, "0")}</span>
          <div>
            {task.name && <span className="subagent-codename">{task.name}</span>}
            <strong>{task.title}</strong>
            <p>{task.summary || task.description}</p>
            {task.files.length > 0 && <code>{task.files.join(" · ")}</code>}
          </div>
          <em>{task.status}</em>
        </article>
      ))}
    </div>
  );
}

export function DiffPanel({ run, artifacts, mergeRequestConfigured }: { run: Run; artifacts: RunArtifact[]; mergeRequestConfigured?: boolean }) {
  const { t, locale } = useT();
  const diffArtifact = artifacts.find((artifact) => artifact.artifactId === "diff");
  // A1: the export route always resolves the authoritative patch (artifact,
  // inline diff, or a worker regeneration), so it is preferred over the raw
  // artifact download.
  const exportUrl = api.runPatchUrl(run.id);
  const [mrState, setMrState] = useState<"" | "busy" | "done" | "error">("");
  const [mrMessage, setMrMessage] = useState("");
  const createMergeRequest = async () => {
    setMrState("busy");
    setMrMessage("");
    try {
      const result = await api.createMergeRequest(run.id);
      setMrState("done");
      setMrMessage(result.mergeRequest.url ? t("diff.mrCreatedWithUrl", { url: result.mergeRequest.url }) : t("diff.mrCreated"));
    } catch (cause) {
      setMrState("error");
      setMrMessage(localizeError(locale, cause as { code?: string; message?: string }));
    }
  };
  return (
    <div className="diff-panel">
      <div className="artifact-bar">
        {diffArtifact ? (
          <a className="button secondary" href={api.artifactDownloadUrl(run.id, "diff")} download>
            <Download size={14} />{t("diff.download")}
            <em>{diffArtifact.bytes} bytes · {diffArtifact.sha256?.slice(0, 12)}</em>
          </a>
        ) : null}
        {diffArtifact || run.diff ? (
          <a className="button secondary" href={exportUrl} download>
            <Download size={14} />{t("diff.exportPatch")}
          </a>
        ) : null}
        {mergeRequestConfigured ? (
          <button type="button" className="button secondary" disabled={mrState === "busy"} onClick={() => void createMergeRequest()}>
            {mrState === "busy" ? <LoaderCircle className="spin" size={14} /> : <GitPullRequestArrow size={14} />}{t("diff.createMr")}
          </button>
        ) : null}
        {diffArtifact?.baseSha ? <code className="artifact-base">base {diffArtifact.baseSha.slice(0, 10)}</code> : null}
        <span className="artifact-hint">{t("diff.previewHint")}</span>
      </div>
      {mrMessage ? <div className={mrState === "error" ? "form-error" : "artifact-hint"}>{mrMessage}</div> : null}
      {run.diff ? (
        <pre className="diff-view">{run.diff.split("\n").map((line, index) => (
          <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""} key={`${index}-${line}`}>{line}{"\n"}</span>
        ))}</pre>
      ) : <EmptyPanel icon={FileCode2} text={t("diff.empty")} />}
    </div>
  );
}

/**
 * B2: durable record of what was accepted — findings split, diff identity,
 * checks summary and usage, with a copy button for the full JSON.
 */
export function AcceptancePanel({ run }: { run: Run }) {
  const { t, locale } = useT();
  const [copied, setCopied] = useState(false);
  const snapshot = run.acceptance;
  if (!snapshot) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="panel acceptance-panel">
      <div className="panel-head">
        <div><span className="eyebrow">ACCEPTANCE SNAPSHOT</span><h3>{t("acceptance.title")}</h3></div>
        <button type="button" className="button secondary" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("common.copied") : t("acceptance.copyJson")}
        </button>
      </div>
      <div className="acceptance-grid">
        <div><span>{t("acceptance.acceptedBy")}</span><strong>{snapshot.acceptedBy}</strong><small>{formatClock(snapshot.acceptedAt, locale)}</small></div>
        <div><span>{t("acceptance.findings")}</span><strong>{snapshot.findings.resolved.count} / {snapshot.findings.remaining.count}</strong><small>{t(snapshot.acknowledgedOpenFindings ? "acceptance.acknowledged" : "acceptance.noOpenFindings")}</small></div>
        <div><span>{t("acceptance.checks")}</span><strong>{t("acceptance.checksValue", { passed: snapshot.checks.passed, failed: snapshot.checks.failed })}</strong><small>{t("acceptance.checksTotal", { total: snapshot.checks.total })}</small></div>
        <div><span>{t("acceptance.diff")}</span><strong>{snapshot.diff.sha256 ? snapshot.diff.sha256.slice(0, 12) : t("common.unknown")}</strong><small>{snapshot.diff.bytes === null ? t("acceptance.bytesUnknown") : `${snapshot.diff.bytes} bytes`}</small></div>
        <div><span>{t("acceptance.usage")}</span><strong>{t("acceptance.usageValue", { calls: snapshot.usage.modelCalls, cost: snapshot.usage.estimatedCost.toFixed(3) })}</strong><small>{t("acceptance.usageTokens", { input: compactNumber(snapshot.usage.inputTokens), output: compactNumber(snapshot.usage.outputTokens) })}</small></div>
        <div><span>{t("acceptance.note")}</span><strong>{snapshot.note ?? t("acceptance.none")}</strong><small>{run.merge ? t("acceptance.merged", { commit: run.merge.commit.slice(0, 10), branch: run.merge.targetBranch }) : t("acceptance.notMerged")}</small></div>
      </div>
    </section>
  );
}

/**
 * A one-line run-detail notice for `review.nonblocking_deferred`: under
 * `reviewScope: "blocking"` the worker accepted a round whose only remaining
 * findings were medium/low. The findings stay on the run and in the acceptance
 * snapshot's "remaining" list; this line makes the deferral explicit.
 */
export function DeferredNonBlockingNotice({ events }: { events: RunEvent[] }) {
  const { t, locale } = useT();
  const notice = useMemo(() => deferredNonBlockingNotice(events), [events]);
  if (!notice) return null;
  const ids = notice.ids.slice(0, 8).join(locale === "en" ? ", " : "、");
  const [open, close] = locale === "en" ? [" (", ")"] : ["（", "）"];
  return (
    <div className="review-scope-note">
      {t("review.deferred", { round: notice.round, count: notice.count })}
      {notice.ids.length > 0 ? `${open}${ids}${notice.ids.length > 8 ? "…" : ""}${close}` : ""}
    </div>
  );
}


export function ChecksPanel({ run }: { run: Run }) {
  const { t } = useT();
  return (
    <div className="check-list">
      {run.checks.map((check) => (
        <div className="check-row" key={check.id}>
          <span className={`check-icon check-${check.status}`}>
            {check.status === "passed" ? <Check size={14} /> : check.status === "running" ? <LoaderCircle className="spin" size={14} /> : <CircleDot size={14} />}
          </span>
          <div><strong>{check.name}</strong><code>{check.command}</code></div>
          <span className="check-exit" title={t("checks.exitCodeTitle")}>{check.exitCode === undefined ? "exit —" : `exit ${check.exitCode}`}</span>
          <span>{check.durationMs ? `${(check.durationMs / 1000).toFixed(1)}s` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** GAP-04: per-run budget limits vs. current spend, remaining calls/cost. */
export function BudgetPanel({ run }: { run: Run }) {
  const { t, locale } = useT();
  const budget = run.budget;
  const usedTokens = run.usage.totalTokens ?? run.usage.inputTokens + run.usage.outputTokens;
  const usedCost = run.usage.estimatedCost;
  const usedCalls = run.modelCalls ?? (run.usageRoles ?? []).reduce((total, entry) => total + entry.calls, 0);
  const usedSeconds = Math.round(run.durationMs / 1000);
  const remaining = (limit: number, used: number) => (limit > 0 ? Math.max(0, limit - used) : null);
  // AT-JEV-062: the summary cost row must not read as a plain `$0.000` when some
  // calls could not be priced (e.g. the decision plane). It uses the exact same
  // rule as the per-role rows so the two can never disagree.
  const summaryCost = roleCostDisplay({ calls: usedCalls, estimatedCost: usedCost, unpricedCalls: totalUnpricedCalls(run.usageRoles) });
  const rows = [
    { label: t("budget.tokens"), limit: budget?.maxTokens ?? 0, used: usedTokens, remaining: remaining(budget?.maxTokens ?? 0, usedTokens), unit: "" },
    {
      label: t("budget.cost"),
      limit: budget?.maxCostUsd ?? 0,
      used: usedCost,
      remaining: remaining(budget?.maxCostUsd ?? 0, usedCost),
      unit: "$",
      display: summaryCost.kind === "priced" ? undefined : roleCostLabel({ calls: usedCalls, estimatedCost: usedCost, unpricedCalls: totalUnpricedCalls(run.usageRoles) }),
    },
    { label: t("budget.modelCalls"), limit: budget?.maxModelCalls ?? 0, used: usedCalls, remaining: remaining(budget?.maxModelCalls ?? 0, usedCalls), unit: "" },
    { label: t("budget.duration"), limit: budget?.maxDurationSeconds ?? 0, used: usedSeconds, remaining: remaining(budget?.maxDurationSeconds ?? 0, usedSeconds), unit: "" },
  ];
  const format = (value: number, unit: string) => `${unit}${unit === "$" ? value.toFixed(3) : compactNumber(value)}`;
  const roles: RunRoleUsage[] = run.usageRoles ?? [];
  // AT-JEV-062: calls the price table cannot cover (e.g. decision plane / TypeSafe).
  const unpricedCalls = totalUnpricedCalls(roles);
  // Sprint 2: prefer real per-session data; fall back to the derived id for
  // runs recorded before the `sessions` field existed.
  const sessionFor = (role: string) => {
    const summaries = (run.sessions ?? [])
      .filter((entry) => entry.role === role)
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    const latest = summaries[0];
    if (latest) {
      const rounds = latest.rounds.map((round) => `R${round}`).join("/");
      const kind = t(latest.resumed ? "budget.sessionReused" : "budget.sessionNew");
      const detail = t("budget.sessionDetail", { calls: latest.calls, rounds });
      return `${latest.sessionId} · ${kind}（${detail}）`;
    }
    const base = run.id.replaceAll("_", "-");
    if (role === "developer") return `${base}-developer`;
    if (role === "integrator") return `${base}-integrator`;
    if (role === "sub-agent") return `${base}-sub-<taskId>`;
    return t("budget.noSession");
  };
  return (
    <div className="budget-panel">
      <div className="budget-grid">
        {rows.map((row) => (
          <div className="budget-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{(row as { display?: string }).display ?? format(row.used, row.unit)}{row.limit > 0 ? <em> / {format(row.limit, row.unit)}</em> : <em> / {t("budget.noLimit")}</em>}</strong>
            <small>{row.remaining === null ? t("budget.noLimit") : t("budget.remaining", { value: format(row.remaining, row.unit) })}</small>
          </div>
        ))}
      </div>
      <div className="budget-roles">
        <div className="budget-roles-head"><span>AGENT</span><span>MODEL</span><span>CALLS</span><span>TOKENS</span><span>COST</span></div>
        {roles.length === 0 && <div className="budget-empty">{t("budget.empty")}</div>}
        {roles.map((entry) => (
          <div className="budget-roles-row" key={`${entry.role}-${entry.provider}-${entry.model}`}>
            <span><strong>{roleDisplayName(entry.role, locale)}</strong><code>{sessionFor(entry.role)}</code></span>
            <span>{entry.provider}/{entry.model}</span>
            <span>{entry.calls}</span>
            <span>{compactNumber(entry.inputTokens + entry.outputTokens)}</span>
            <span>{roleCostLabel(entry, locale)}</span>
          </div>
        ))}
        {unpricedCalls > 0 && <div className="budget-unknown">{t("budget.unpricedCalls", { count: unpricedCalls })}</div>}
        {(run.usageUnknownCalls ?? 0) > 0 && <div className="budget-unknown">{t("budget.unknownCalls", { count: run.usageUnknownCalls ?? 0 })}</div>}
      </div>
    </div>
  );
}
