import { redactCheckText } from "./check-redaction.js";
import { scrubEnvironment } from "./pi-env.js";
import path from "node:path";

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

/** Redact the complete diagnostic before bounding it, never a partial secret. */
export function workerDiagnosticMessage(error: unknown, options: {
  credentials?: readonly string[];
  privatePaths?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  limit?: number;
} = {}): string {
  const message = error instanceof Error ? error.message : String(error);
  // Only explicit private absolute paths: never rewrite arbitrary source paths
  // or use a filesystem root as a global replacement token.
  const privatePaths = (options.privatePaths ?? []).filter((value) =>
    path.isAbsolute(value) && path.resolve(value) !== path.parse(path.resolve(value)).root);
  const safe = redactWorkerDiagnostic(message, [...(options.credentials ?? []), ...privatePaths], options.environment);
  const limit = options.limit ?? 2_000;
  return safe.slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 2_000);
}
