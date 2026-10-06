import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM helper shared with the deployment scripts
import { sanitizeEnvText, stripUrlCredentials, whitelist } from "../../deploy/docker/env-sanitize.mjs";

describe("env-sanitize (AUD-14 / AT-SEC-001)", () => {
  it("never keeps a database URL password", () => {
    const sanitized = sanitizeEnvText([
      "PI_DATABASE_URL=postgresql://pigo:sup3rsecret@postgres:5432/pigo",
      "PI_INTERNAL_TOKEN=deadbeef",
      "PI_VAULT_SECRET=abcdef",
      "PIGO_POSTGRES_PASSWORD=hunter2",
    ].join("\n"));
    expect(sanitized).not.toContain("sup3rsecret");
    expect(sanitized).not.toContain("deadbeef");
    expect(sanitized).not.toContain("abcdef");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("PI_DATABASE_URL=[redacted]");
  });

  it("keeps non-sensitive configuration for diagnostics", () => {
    const sanitized = sanitizeEnvText([
      "PI_VERSION=1.0.0",
      "PI_REVIEWER_MODEL=gpt-5.6-sol",
      "PI_PUBLIC_ORIGIN=https://pigo.example",
      "PI_SANDBOX_MODE=container",
      "SOME_THIRD_PARTY_FLAG=value",
    ].join("\n"));
    expect(sanitized).toContain("PI_VERSION=1.0.0");
    expect(sanitized).toContain("PI_REVIEWER_MODEL=gpt-5.6-sol");
    expect(sanitized).toContain("PI_PUBLIC_ORIGIN=https://pigo.example");
    expect(sanitized).toContain("PI_SANDBOX_MODE=container");
    expect(sanitized).toContain("SOME_THIRD_PARTY_FLAG=[redacted]");
  });

  it("strips userinfo even from whitelisted URL values", () => {
    expect(stripUrlCredentials("https://user:pass@example.com/v1")).toBe("https://example.com/v1");
    expect(stripUrlCredentials("postgresql://pigo:secret@db:5432/pigo")).toBe("postgresql://db:5432/pigo");
    expect(sanitizeEnvText("PI_DEVELOPER_MODEL=deepseek-flash")).toBe("PI_DEVELOPER_MODEL=deepseek-flash");
  });

  it("never whitelists credential-bearing keys", () => {
    expect(whitelist).toContain("PI_VERSION");
    for (const name of ["PI_INTERNAL_TOKEN", "PI_VAULT_SECRET", "PI_DATABASE_URL", "PIGO_POSTGRES_PASSWORD", "PI_ALERT_WEBHOOK"]) {
      expect(whitelist).not.toContain(name);
    }
  });
});
