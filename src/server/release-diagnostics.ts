import { z } from "zod";
import { diagnosticSecrets, redactDiagnosticText } from "../shared/diagnostics.js";

/** Diagnostics only: preserve commit/digest and executable payloads verbatim. */
export function redactReleaseDiagnostic(text: string, secrets: readonly string[] = []): string {
  return redactDiagnosticText(text, [...diagnosticSecrets(), ...secrets]);
}

/** Resolve saved route secrets at parse time so key rotations take effect. */
export function releaseDiagnosticDetailSchema(secrets: () => readonly string[]) {
  return z.string().trim().max(500)
    .transform((text) => redactReleaseDiagnostic(text, secrets()).slice(0, 500))
    .optional();
}
