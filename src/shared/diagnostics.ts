/** Plain-text diagnostics only; never rewrite executable source or model JSON. */
export function redactDiagnosticText(text: string, secrets: readonly string[] = []): string {
  const values = [...new Set(secrets.filter(Boolean).flatMap((secret) => [
    secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1),
  ]))].sort((a, b) => b.length - a.length);
  let safe = text;
  for (const value of values) safe = safe.replaceAll(value, "[redacted]");
  return safe
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/<>"']*@[^\s<>"']+/gi, "[redacted-url]")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>[\]}]+/gi, "$1 [redacted]")
    .replace(/([?&](?:access_token|api_key|token|password|secret|signature)=)[^&#\s"'<>]+/gi, "$1[redacted]")
    .replace(/\b([\w-]*(?:api[_-]?key|token|password|passwd|secret|credential)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\][]+)/gi, "$1[redacted]");
}

/** Values known only to the service, including opaque webhook URL paths. */
export function diagnosticSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => value && (
      /(_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIAL|_CREDENTIALS|_WEBHOOK)$/i.test(name)
      || ["PI_DATABASE_URL", "DATABASE_URL", "PGPASSWORD", "PI_VAULT_FILE"].includes(name)
    ))
    .map(([, value]) => value!);
}

const sensitiveField = /^(?:authorization|cookie|set-cookie)$|(?:^|[_-])(?:password|passwd|secret|credentials?|token|api[_-]?key|private[_-]?key)(?:$|[_-])/i;

/** Produces a detached JSON-safe diagnostic payload; never mutates its source. */
export function redactDiagnosticValue(value: unknown, secrets: readonly string[] = [], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactDiagnosticText(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) return { name: redactDiagnosticText(value.name, secrets), message: redactDiagnosticText(value.message, secrets) };
    if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, secrets, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactDiagnosticText(key, secrets),
      sensitiveField.test(key) ? "[redacted]" : redactDiagnosticValue(item, secrets, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}
