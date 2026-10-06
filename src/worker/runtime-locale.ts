/**
 * Runtime locale for worker-generated text (docs/24-i18n.md §9).
 *
 * The worker writes the *live* text of a run: its guard/stop event messages and
 * summaries. This module is the single place that renders that text in the run's
 * locale and returns the audit metadata recorded next to it, so a reader can
 * always tell which language an event was written in (`meta.locale`) and can
 * still find the English variant (`meta.messageEn`) even for a Chinese run.
 *
 * Historical rows are never rewritten: the worker only localizes text it
 * generates *now*, and every existing run without `run.locale` reads as Chinese.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from "../shared/i18n.js";

/** A short piece of operator-facing text in both catalog languages. */
export interface LocalizedText {
  zh: string;
  en: string;
}

/**
 * Normalizes an optional locale value: a supported locale wins, anything else
 * (omitted/legacy/unknown) reads as Chinese.
 */
export function asRunLocale(locale: unknown): Locale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * Locale of a run document. Additive and backward compatible: a run written
 * before `locale` existed (or with an unknown value) reads as Chinese.
 */
export function runLocale(run: { locale?: unknown } | null | undefined): Locale {
  return asRunLocale(run?.locale);
}

/**
 * Renders `text` for `locale` and returns the metadata to record on the event:
 * the locale actually used plus the English variant. Callers merge the returned
 * `meta` with their own meta (never replacing it).
 */
export function guardText(text: LocalizedText, locale: Locale): { message: string; meta: { locale: Locale; messageEn: string } } {
  return {
    message: locale === "en" ? text.en : text.zh,
    meta: { locale, messageEn: text.en },
  };
}

/**
 * `{message, messageEn}` pair for a pure function (recovery planning) that
 * cannot record meta itself: the caller stores `message` on the event and
 * `messageEn` under `meta.messageEn`.
 */
export function localizedPair(text: LocalizedText, locale: Locale): { message: string; messageEn: string } {
  return { message: locale === "en" ? text.en : text.zh, messageEn: text.en };
}

/** Max review rounds reached (the long-standing `run.needs_human` wording). */
export const MAX_ROUNDS_TEXT: LocalizedText = {
  zh: "达到最大审核轮次，需要人工处理",
  en: "Maximum review rounds reached; human handling required",
};

/** `review.snapshot_failed` */
export function snapshotFailedText(reason: string): LocalizedText {
  return {
    zh: `无法创建审核只读快照，已停止审核（绝不回退到可写 worktree）：${reason}`,
    en: `Could not create the read-only review snapshot; review stopped (never falls back to the writable worktree): ${reason}`,
  };
}

export const SNAPSHOT_FAILED_SUMMARY: LocalizedText = {
  zh: "审核快照创建失败，已转人工",
  en: "Review snapshot creation failed; handing off to a human",
};

/** `review.snapshot_diverged` */
export function snapshotDivergedText(reasons: string): LocalizedText {
  return {
    zh: `审核快照与开发 worktree 的 tree hash 不一致，已阻断审核：${reasons}`,
    en: `The review snapshot's tree hash differs from the development worktree; review blocked: ${reasons}`,
  };
}

export const SNAPSHOT_DIVERGED_SUMMARY: LocalizedText = {
  zh: "审核快照与开发 worktree 不一致，已转人工",
  en: "Review snapshot differs from the development worktree; handing off to a human",
};

/** `review.provider_error` */
export function reviewProviderErrorText(kind: string, reason: string): LocalizedText {
  return {
    zh: `审核模型调用失败（${kind}）：${reason}`,
    en: `Reviewer model call failed (${kind}): ${reason}`,
  };
}

/** `review.invalid_protocol` */
export const INVALID_PROTOCOL_TEXT: LocalizedText = {
  zh: "Reviewer 两次输出均无法解析为审核协议（protocol），转人工处理",
  en: "Neither reviewer output could be parsed as the review protocol; handing off to a human",
};

/** `checks.blocked_retry_review` */
export function checksBlockedRetryText(failed: string): LocalizedText {
  return {
    zh: `当前快照检查未通过，已阻止重试审核：${failed}`,
    en: `The current snapshot's checks did not pass; review retry blocked: ${failed}`,
  };
}

export const CHECKS_BLOCKED_RETRY_SUMMARY: LocalizedText = {
  zh: "检查未通过，重试审核被拒绝",
  en: "Checks did not pass; the review retry was rejected",
};

/** `run.completion_blocked` — main loop (checks/snapshot/blocking reasons). */
export function completionBlockedText(reasons: string): LocalizedText {
  return {
    zh: `完成守卫拒绝：${reasons}`,
    en: `Completion guard rejected: ${reasons}`,
  };
}

export const COMPLETION_BLOCKED_SUMMARY: LocalizedText = {
  zh: "完成守卫拒绝：存在未满足的检查或未解决的阻断问题",
  en: "Completion guard rejected: unmet checks or unresolved blocking findings",
};

/** `run.completion_blocked` — reviewer-retry path (approved but still blocked). */
export function completionBlockedApprovedText(count: number): LocalizedText {
  return {
    zh: `完成守卫拒绝：审核结论为通过但仍存在 ${count} 个阻断级问题`,
    en: `Completion guard rejected: the review approved but ${count} blocking finding(s) remain`,
  };
}

export const COMPLETION_BLOCKED_UNRESOLVED_SUMMARY: LocalizedText = {
  zh: "存在未解决的阻断级问题，未完成任务",
  en: "Unresolved blocking findings remain; the task is not complete",
};

/** `review.severe_finding_repeated` */
export function severeRepeatText(threshold: number, labels: string): LocalizedText {
  return {
    zh: `同一严重问题连续 ${threshold} 轮未解决（fingerprint 稳定），已停止自动返修并转人工处理：${labels}`,
    en: `The same severe finding stayed unresolved for ${threshold} consecutive rounds (stable fingerprint); auto-repair stopped for human handling: ${labels}`,
  };
}

/** One `severity「title」(N 轮)` label; `separator` matches the language. */
export function severeRepeatLabels(
  items: ReadonlyArray<{ severity: string; title: string; rounds: number }>,
  locale: Locale,
): string {
  return items
    .map((item) => (locale === "en"
      ? `${item.severity} "${item.title}" (${item.rounds} rounds)`
      : `${item.severity}「${item.title}」(${item.rounds} 轮)`))
    .join(locale === "en" ? "; " : "；");
}

export function severeRepeatSummary(threshold: number): LocalizedText {
  return {
    zh: `重复严重问题达到策略阈值（${threshold} 轮），停止自动循环`,
    en: `Repeated severe findings reached the policy threshold (${threshold} rounds); the automatic loop stopped`,
  };
}

/** `review.changes_requested` (main loop). */
export function changesRequestedText(count: number): LocalizedText {
  return {
    zh: `审核发现 ${count} 个问题，退回 Developer`,
    en: `The reviewer found ${count} issue(s); sent back to the Developer`,
  };
}

/** `review.changes_requested` (reviewer-retry path). */
export function changesRequestedRetryText(count: number): LocalizedText {
  return {
    zh: `重试审核仍发现 ${count} 个问题，继续人工处理`,
    en: `The review retry still found ${count} issue(s); continuing with human handling`,
  };
}

/** `run.deadline_exceeded` */
export function deadlineExceededText(seconds: number): LocalizedText {
  return {
    zh: `运行超过时限预算（${seconds}s），已终止本次执行并转人工处理`,
    en: `The run exceeded its time budget (${seconds}s); this execution was terminated for human handling`,
  };
}

/** `run.budget_exhausted` */
export function budgetExhaustedText(reason: string): LocalizedText {
  return {
    zh: `运行预算已用尽，已停止新的模型调用：${reason}`,
    en: `The run's budget is exhausted; new model calls stopped: ${reason}`,
  };
}

/** Terminal catch-all: cancellation. */
export const CANCELLED_TEXT: LocalizedText = {
  zh: "任务已取消",
  en: "The run was cancelled",
};

export const CANCELLED_SUMMARY: LocalizedText = {
  zh: "已取消",
  en: "Cancelled",
};

/** Terminal catch-all: storage error. */
export function storageErrorText(kind: string, message: string): LocalizedText {
  return {
    zh: `存储错误，任务未完成，保持人工处理（${kind}）：${message}`,
    en: `Storage error; the task did not complete and stays with a human (${kind}): ${message}`,
  };
}

/** Terminal catch-all: provider/resume/recovery failure. */
export function runFailureText(kind: string, message: string, stage: "followup" | "recovering" | "run"): LocalizedText {
  const zhLead = stage === "followup" ? "恢复执行失败，保持人工处理" : stage === "recovering" ? "Worker 恢复执行失败，保持人工处理" : "真实运行失败";
  const enLead = stage === "followup"
    ? "Resuming the run failed; it stays with a human"
    : stage === "recovering"
      ? "Worker recovery failed; the run stays with a human"
      : "The real run failed";
  return { zh: `${zhLead}（${kind}）：${message}`, en: `${enLead} (${kind}): ${message}` };
}

/** Terminal catch-all: the sandbox-unavailable summary (fail-closed refusal). */
export const SANDBOX_UNAVAILABLE_SUMMARY: LocalizedText = {
  zh: "容器沙箱不可用，已按 fail-closed 拒绝执行；请修复 Docker/PI_DOCKER_SOCKET 或显式设置 PI_SANDBOX_ALLOW_DEGRADED=1",
  en: "The container sandbox is unavailable, so execution was refused (fail-closed); fix Docker/PI_DOCKER_SOCKET or explicitly set PI_SANDBOX_ALLOW_DEGRADED=1",
};
