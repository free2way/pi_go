import { describe, expect, it } from "vitest";
import { diagnosticSecrets, redactDiagnosticText, redactDiagnosticValue } from "./diagnostics.js";

const fake = (label: string) => ["DUMMY", label].join("_");

describe("service diagnostics", () => {
  it("collects only service-secret environment values, including opaque webhook URLs", () => {
    const values = diagnosticSecrets({ PI_INTERNAL_TOKEN: fake("internal"), PGPASSWORD: fake("database"), PI_ALERT_WEBHOOK: "https://alerts.example.invalid/opaque", LANG: "en_US", NODE_ENV: "test", EMPTY_KEY: "" });
    expect(values).toEqual(["DUMMY_internal", "DUMMY_database", "https://alerts.example.invalid/opaque"]);
    expect(redactDiagnosticText("ordinary failure", values)).toBe("ordinary failure");
  });

  it("redacts nested strings, credential fields and arrays without mutating input", () => {
    const input = { runId: "run_1", count: 2, nested: [{ authorization: fake("header"), apiKey: fake("key"), credentials: { value: fake("nested") }, error: "Bearer DUMMY_echo" }] };
    const safe = redactDiagnosticValue(input);
    expect(safe).toEqual({ runId: "run_1", count: 2, nested: [{ authorization: "[redacted]", apiKey: "[redacted]", credentials: "[redacted]", error: "Bearer [redacted]" }] });
    expect(input.nested[0].apiKey).toBe("DUMMY_key");
    expect(input.nested[0].credentials.value).toBe("DUMMY_nested");
  });

  it("removes known plain, encoded and JSON-escaped platform values", () => {
    const secret = 'DUMMY/+" service';
    const safe = JSON.stringify(redactDiagnosticValue({ rows: [secret, encodeURIComponent(secret), JSON.stringify(secret)] }, [secret]));
    expect(safe).not.toContain("DUMMY");
    expect(safe).toContain("[redacted]");
  });

  it("omits stack/cause and handles repeated objects, cycles and JSON-safe values", () => {
    const error = new Error("Bearer DUMMY_error", { cause: new Error("DUMMY_cause") });
    const shared = { message: "ordinary" };
    const circular: Record<string, unknown> = { error, first: shared, second: shared, count: 2n, date: new Date("2026-01-01Z") };
    circular.self = circular;
    const safe = redactDiagnosticValue(circular) as Record<string, unknown>;
    expect(safe.error).toEqual({ name: "Error", message: "Bearer [redacted]" });
    expect(safe.second).toEqual(shared);
    expect(safe.self).toBe("[circular]");
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain("DUMMY");
  });
});
