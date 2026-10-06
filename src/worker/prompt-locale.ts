/**
 * The single, clearly-labelled locale instruction block appended to every agent
 * prompt (docs/24-i18n.md §10).
 *
 * Scope and intent: this is the *only* change to prompt semantics made for i18n.
 * It tells the agent which language to write its user-visible text in, so an
 * English requester's run produces English summaries, findings
 * (`title`/`evidence`/`requiredChange`), plan rationale and chat messages, while
 * a Chinese requester keeps Chinese. Everything else about a prompt (the JSON
 * contract, model selection, tool budget) is unchanged.
 *
 * To revert, delete the call sites' `localeInstruction(...)` section and this
 * file — nothing else depends on it.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from "../shared/i18n.js";

/** Marker so the block is greppable in a prompt log and easy to audit. */
export const LOCALE_INSTRUCTION_LABEL = "LOCALE INSTRUCTION";

/**
 * The instruction block for one locale. `zh` keeps the existing Chinese output
 * (now stated explicitly instead of being implied); `en` asks for English.
 */
export function localeInstruction(locale: Locale | null | undefined): string {
  const resolved: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return resolved === "en"
    ? `${LOCALE_INSTRUCTION_LABEL}: write every user-visible text you produce in English — your summary, every finding's title, evidence and requiredChange, your plan rationale, and any chat message. Keep code, file paths, commands and identifiers as-is.`
    : `${LOCALE_INSTRUCTION_LABEL}（语言指令）：所有面向用户的文本一律使用中文——摘要、每个 finding 的 title/evidence/requiredChange、计划说明与对话内容；代码、文件路径、命令与标识符保持原样。`;
}
