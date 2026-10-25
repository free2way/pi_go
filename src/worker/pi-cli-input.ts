import type { ReviewInputLimits } from "./review-input.js";

// Keep one UTF-8 argument below Linux's common 128 KiB per-string ceiling,
// including the NUL terminator, rather than relying only on a diff byte cap.
export const maxPiCliInputBytes = 120_000;

export class PiInputTransportError extends Error {
  readonly code = "PI_INPUT_TRANSPORT_BLOCKED";
  readonly limit = maxPiCliInputBytes;
  constructor(readonly reason: "nul" | "byte-budget", readonly bytes: number) {
    super(reason === "nul"
      ? "Pi CLI input contains a NUL byte; split or correct the input before retrying."
      : "Pi CLI input exceeds its transport byte budget; split the input before retrying.");
    this.name = "PiInputTransportError";
  }
}

/** Validate before reserving a model attempt, emitting chat, or spawning Pi. */
export function assertPiCliInput(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.includes("\0")) throw new PiInputTransportError("nul", bytes);
  if (bytes > maxPiCliInputBytes) throw new PiInputTransportError("byte-budget", bytes);
}

/** The caller renders fixed instructions and the task BEFORE budgeting a diff. */
export function reviewTransportLimits(prefix: string, configured: ReviewInputLimits): ReviewInputLimits {
  assertPiCliInput(prefix);
  return {
    ...configured,
    totalDiffBytes: Math.min(configured.totalDiffBytes, Math.max(1, maxPiCliInputBytes - Buffer.byteLength(prefix, "utf8"))),
  };
}
