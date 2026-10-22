import { describe, expect, it } from "vitest";
import { redactCheckText } from "./check-redaction.js";

function authenticatedUrl(scheme: string, host: string) {
  const url = new URL(`${scheme}://${host}/app`);
  url.username = "x";
  url.password = ["DUMMY", "canary"].join("_");
  return url.href;
}

describe("redactCheckText", () => {
  it.each([
    ["Authorization: Bearer synthetic-canary", "synthetic-canary"],
    ["authorization: Basic dXNlcjpjYW5hcnk=", "dXNlcjpjYW5hcnk="],
    [authenticatedUrl("postgresql", "db.example.invalid"), "DUMMY_canary"],
    [authenticatedUrl("https", "git.example.invalid"), "DUMMY_canary"],
    ["https://hook.example.invalid/?token=synthetic-canary&env=test", "synthetic-canary"],
    ["https://hook.example.invalid/?signature=synthetic-canary", "synthetic-canary"],
    ["API_KEY=synthetic-canary", "synthetic-canary"],
    ["export PGPASSWORD='synthetic canary'", "synthetic canary"],
    ['{"access_token":"synthetic canary"}', "synthetic canary"],
    ["password: synthetic-canary", "synthetic-canary"],
  ])("removes a credential from %s", (text, secret) => {
    const safe = redactCheckText(text);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("[redacted");
  });

  it("removes known credentials, encoded values and overlapping values longest first", () => {
    const canary = 'DUMMY/+" value';
    const text = [canary, encodeURIComponent(canary), JSON.stringify(canary), "overlap-long", "overlap"].join("\n");
    const safe = redactCheckText(text, ["", canary, "overlap", "overlap-long"]);
    for (const value of [canary, encodeURIComponent(canary), "DUMMY", "overlap", "-long"]) expect(safe).not.toContain(value);
  });

  it("preserves ordinary commands, exit diagnostics and unauthenticated URLs", () => {
    const text = "npm test -- --run\nAssertionError: expected 2, got 1\nhttps://docs.example.invalid/help";
    expect(redactCheckText(text)).toBe(text);
  });

  it("is idempotent for common redacted diagnostics", () => {
    const safe = redactCheckText('Bearer canary\nTOKEN=canary\n{"password":"canary"}');
    expect(redactCheckText(safe)).toBe(safe);
  });
});
