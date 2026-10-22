/** Redact check diagnostics before they enter durable results or chat. */
export function redactCheckText(text: string, secrets: readonly string[] = []): string {
  // Replace before truncating, including the common encoded representations.
  const values = [...new Set(secrets.filter(Boolean).flatMap((secret) => [
    secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1),
  ]))].sort((a, b) => b.length - a.length);
  let safe = text;
  for (const value of values) safe = safe.replaceAll(value, "[redacted]");
  return safe
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/<>"']*@[^\s<>"']+/gi, "[redacted-url]")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'<>\[\]\}]+/gi, "$1 [redacted]")
    .replace(/([?&](?:access_token|api_key|token|password|secret|signature)=)[^&#\s"'<>]+/gi, "$1[redacted]")
    .replace(/\b([\w-]*(?:api[_-]?key|token|password|passwd|secret|credential)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\}\]\[]+)/gi, "$1[redacted]");
}
