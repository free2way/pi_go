import { redactCheckText } from "./check-redaction.js";
import { scrubEnvironment } from "./pi-env.js";

/** Diagnostics only: do not apply generic text rules to model JSON protocols. */
export function redactWorkerDiagnostic(
  message: string,
  credentials: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const visible = scrubEnvironment(environment);
  const platform = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && visible[name] === undefined)
    .map(([, value]) => value!);
  return redactCheckText(message, [...credentials, ...platform]);
}
