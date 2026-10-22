import { checkChatMessage, type ChatPayload } from "../shared/chat.js";
import type { CheckResult } from "../shared/types.js";
import { redactCheckText } from "./check-redaction.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CheckIO {
  commands: string[];
  signal: AbortSignal;
  /** Current job and platform secrets; used only for diagnostic redaction. */
  secrets?: readonly string[];
  /** Runs a single check command; resolves with its exit result. */
  execute: (command: string, signal: AbortSignal) => Promise<CommandResult>;
  /** Persists the in-progress check list and appends the start activity event. */
  started: (checks: CheckResult[], command: string) => Promise<void>;
  /** Persists the finished check list and appends the pass/fail activity event. */
  finished: (checks: CheckResult[], command: string, passed: boolean) => Promise<void>;
  /** Appends the structured `checks` channel chat entry. */
  chat: (payload: ChatPayload) => Promise<void>;
}

/** Throws when the job has been aborted so no further work or events are produced. */
export function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("cancelled");
}

/**
 * Runs the deterministic check suite. An aborted signal (e.g. the user
 * cancelling during a check) throws immediately and never reports a synthetic
 * failure, rework handoff, or chat message on top of `run.cancelled`.
 */
export async function runChecks(io: CheckIO): Promise<{ passed: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (let index = 0; index < io.commands.length; index += 1) {
    throwIfCancelled(io.signal);
    const checkCommand = io.commands[index];
    const startedAt = Date.now();
    const safeCommand = redactCheckText(checkCommand, io.secrets);
    const current: CheckResult = { id: `check-${index + 1}`, name: `Check ${index + 1}`, command: safeCommand, status: "running" };
    await io.started([...results, current], safeCommand);
    let result: CommandResult;
    try {
      // Execute the original command, never the redacted display projection.
      result = await io.execute(checkCommand, io.signal);
    } catch (error) {
      throwIfCancelled(io.signal);
      throw new Error(redactCheckText(error instanceof Error ? error.message : String(error), io.secrets));
    }
    // `command` resolves with code 130 on abort instead of rejecting, so the
    // cancellation must be checked explicitly before recording a result.
    throwIfCancelled(io.signal);
    const durationMs = Date.now() - startedAt;
    const output = redactCheckText(`${result.stdout}\n${result.stderr}`, io.secrets).trim().slice(-12_000);
    results.push({
      ...current,
      status: result.code === 0 ? "passed" : "failed",
      durationMs,
      // GAP-04: keep the process exit code (AT-REVIEW-002) — the real-run checks
      // tab renders `exit N`, so the extracted suite must not drop it.
      exitCode: result.code,
      output,
    });
    await io.finished([...results], safeCommand, result.code === 0);
    await io.chat(checkChatMessage({ command: safeCommand, passed: result.code === 0, durationMs, output }));
    if (result.code !== 0) return { passed: false, results };
  }
  return { passed: true, results };
}
