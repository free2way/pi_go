import type { FastifyServerOptions } from "fastify";
import { diagnosticSecrets, redactDiagnosticText, redactDiagnosticValue } from "../shared/diagnostics.js";

function serverDiagnosticSecrets(environment: NodeJS.ProcessEnv, credentials: readonly string[] = []): string[] {
  const paths = Object.entries(environment)
    .filter(([name, value]) => /(?:_FILE|_ROOT|_DIR|_DIRECTORY)$/.test(name)
      && value && /^(?:\/|[a-z]:[\\/])/i.test(value)
      && !/^(?:\/+|[a-z]:[\\/]+)$/i.test(value))
    .map(([, value]) => value!);
  return [...diagnosticSecrets(environment), ...paths, ...credentials];
}

/** Diagnostic projection only. Redact the complete value before display limits. */
export function serverDiagnosticMessage(error: unknown, options: {
  environment?: NodeJS.ProcessEnv;
  credentials?: readonly string[];
  limit?: number;
} = {}): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = redactDiagnosticText(message, serverDiagnosticSecrets(options.environment ?? process.env, options.credentials));
  const limit = options.limit ?? 2_000;
  return safe.slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 2_000);
}

/** Keep request correlation and status without recording user URLs or headers.
 * Error/message serializers also cover framework-generated logs. These never
 * touch request/response bodies, executable artifacts or model protocols.
 */
export function serverLoggerOptions(environment: NodeJS.ProcessEnv = process.env): Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean> {
  const safeValue = (value: unknown) => redactDiagnosticValue(value, serverDiagnosticSecrets(environment));
  return {
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "req.headers.cf-access-jwt-assertion", "req.body.token", "developerApiKey", "reviewerApiKey", "credentials", "token"],
      censor: "[redacted]",
    },
    serializers: {
      req(request) {
        // A route template retains the endpoint but drops path/query secrets;
        // unmatched requests must not fall back to the raw attacker input.
        const route = request.routeOptions?.url;
        return { method: request.method, route: route ? serverDiagnosticMessage(route, { environment }) : "[unmatched]" };
      },
      res(response) { return { statusCode: response.statusCode }; },
      err(error) {
        return {
          type: serverDiagnosticMessage(error.name, { environment, limit: 100 }),
          message: serverDiagnosticMessage(error, { environment }),
          stack: "[omitted]",
        };
      },
      error: safeValue,
      msg: (message: unknown) => {
        // Fastify's default 404 log interpolates the original URL separately
        // from its req serializer, including arbitrary unmatched path values.
        if (typeof message === "string" && /^Route [A-Z]+:.* not found$/s.test(message)) return "Route not found";
        return typeof message === "string" ? serverDiagnosticMessage(message, { environment }) : safeValue(message);
      },
    },
  };
}
