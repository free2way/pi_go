import { describe, expect, it } from "vitest";
import { redactWorkerDiagnostic } from "./diagnostic-redaction.js";
import { classifyProviderError, type ProviderErrorKind } from "./provider-errors.js";

describe("worker diagnostic redaction", () => {
  it("removes credential-shaped provider echoes not present in the job", () => {
    const url = new URL("postgresql://db.example.invalid/app");
    url.username = "x";
    url.password = ["DUMMY", "database"].join("_");
    const text = `Bearer DUMMY_bearer ${url.href} https://service.example.invalid/?api_key=DUMMY_query`;
    const safe = redactWorkerDiagnostic(text, [], {});
    for (const value of ["DUMMY_bearer", "DUMMY_database", "DUMMY_query"]) expect(safe).not.toContain(value);
    expect(safe).toContain("[redacted");
  });

  it("removes current credentials and scrubbed platform values in encoded forms", () => {
    const credential = 'DUMMY/+" role';
    const platform = 'DUMMY/+" platform';
    const message = [credential, encodeURIComponent(credential), JSON.stringify(credential),
      platform, encodeURIComponent(platform), JSON.stringify(platform)].join("\n");
    const safe = redactWorkerDiagnostic(message, [credential], { PI_INTERNAL_TOKEN: platform, LANG: "en_US.UTF-8" });
    expect(safe).not.toContain("DUMMY");
    expect(redactWorkerDiagnostic("ordinary failure", [], { LANG: "ordinary" })).toBe("ordinary failure");
  });

  it.each<[ProviderErrorKind, string]>([
    ["storage", "ENOSPC"], ["credential", "401 unauthorized"], ["rate_limit", "429 rate_limit"],
    ["timeout", "ETIMEDOUT"], ["unsupported", "unsupported model"], ["protocol", "invalid json"],
    ["provider", "502 bad gateway"], ["unknown", "fixture failure"],
  ])("preserves diagnostic classification %s", (kind, message) => {
    expect(classifyProviderError(redactWorkerDiagnostic(message + " Bearer DUMMY_canary", [], {}))).toBe(kind);
  });

  it("keeps useful ordinary diagnostics and is idempotent", () => {
    const message = "AssertionError: expected 2, got 1";
    expect(redactWorkerDiagnostic(message, [], {})).toBe(message);
    const safe = redactWorkerDiagnostic("Bearer DUMMY_canary", [], {});
    expect(redactWorkerDiagnostic(safe, [], {})).toBe(safe);
  });
});
