/**
 * GAP-05 / AT-AGENT-008: when a Pi sub-agent call fails its stdout/stderr was
 * discarded (only the message survived). The worker now carries the captured
 * output on the thrown error so the caller can persist a bounded tail as a run
 * event instead of losing the evidence.
 */
export interface PiRunFailureFields {
  /** Process exit code (130 for an aborted/timeout kill). */
  code: number;
  stdout?: string;
  stderr?: string;
}

export class PiRunError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, fields: PiRunFailureFields) {
    super(message);
    this.name = "PiRunError";
    this.code = fields.code;
    this.stdout = fields.stdout ?? "";
    this.stderr = fields.stderr ?? "";
  }
}

/** Default bound: keep the last 8 KiB of a failed call's output. */
export const defaultFailureTailBytes = 8 * 1024;

/** Returns the last `maxBytes` bytes of `text` without splitting a UTF-8 rune. */
export function boundedTail(text: string | undefined, maxBytes = defaultFailureTailBytes): string {
  if (!text) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

/**
 * Bounded, redactable payload for a failure event. Returns undefined when the
 * error carries no captured process output (e.g. a provider/assistant error).
 */
export function failureOutputForEvent(
  error: unknown,
  maxBytes = defaultFailureTailBytes,
): { exitCode: number; stdout?: string; stderr?: string } | undefined {
  if (!(error instanceof PiRunError)) return undefined;
  const stdout = boundedTail(error.stdout, maxBytes).trim();
  const stderr = boundedTail(error.stderr, maxBytes).trim();
  return {
    exitCode: error.code,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}
