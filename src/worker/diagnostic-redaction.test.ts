import { describe, expect, it } from "vitest";
import { redactWorkerDiagnostic, workerDiagnosticMessage } from "./diagnostic-redaction.js";
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

  it.each([24, 100, 200, 500, 2_000])("redacts full values before a %s-character cap", (limit) => {
    const secret = "DUMMY_" + "opaque-credential".repeat(8);
    const safe = workerDiagnosticMessage(new Error(`${"x".repeat(limit - 10)} ${secret}`), {
      credentials: [secret], limit, environment: {},
    });
    expect(safe.length).toBeLessThanOrEqual(limit);
    expect(safe).not.toContain(secret.slice(0, 8));
    expect(safe).toContain("[redacted");
  });

  it("redacts only explicit private absolute paths and their encoded forms", () => {
    const root = "/private/fixture space/workspace";
    const safe = workerDiagnosticMessage(`ENOSPC ${root}/runs ${encodeURIComponent(root)} src/app.ts /healthz`, {
      privatePaths: [root, "/", "src", ""], environment: {},
    });
    expect(safe).toBe("ENOSPC [redacted]/runs [redacted] src/app.ts /healthz");
  });

  it("does not inspect stack, cause or other error fields", () => {
    const error = new Error("ordinary failure", { cause: "DUMMY_cause" });
    error.stack = "DUMMY_stack";
    expect(workerDiagnosticMessage(error, { environment: {} })).toBe("ordinary failure");
    expect(workerDiagnosticMessage("string failure", { environment: {} })).toBe("string failure");
    expect(workerDiagnosticMessage(null, { environment: {} })).toBe("null");
    expect(workerDiagnosticMessage(error, { limit: -1, environment: {} })).toBe("");
  });
});
