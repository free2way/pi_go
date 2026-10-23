import { describe, expect, it } from "vitest";
import { releaseDiagnosticDetailSchema } from "./release-diagnostics.js";

const fake = (name: string) => ["DUMMY", name].join("_");

describe("release callback diagnostic ingress", () => {
  it("sanitizes plain, encoded, JSON-escaped and credential-shaped details", () => {
    const saved = `${fake("saved")}/+" value`;
    const schema = releaseDiagnosticDetailSchema(() => [saved]);
    const text = ["deploy failed", saved, encodeURIComponent(saved), JSON.stringify(saved),
      `Bearer ${fake("bearer")}`, "https://" + ["user", fake("url")].join(":") + "@deploy.example.invalid/",
      `https://deploy.example.invalid/?token=${fake("query")}`].join(" ");
    const result = schema.parse(text);
    expect(result).toContain("deploy failed");
    expect(result).toContain("[redacted");
    expect(result).not.toContain("DUMMY");
    expect(text).toContain(saved);
  });

  it("uses rotated saved tokens at request time", () => {
    let current = fake("first");
    const schema = releaseDiagnosticDetailSchema(() => [current]);
    expect(schema.parse(current)).toBe("[redacted]");
    current = fake("rotated");
    expect(schema.parse(encodeURIComponent(current))).toBe("[redacted]");
  });

  it("preserves optional and ordinary details and rejects oversized input", () => {
    const schema = releaseDiagnosticDetailSchema(() => []);
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse(" smoke failed: exit 7 ")).toBe("smoke failed: exit 7");
    expect(schema.safeParse("x".repeat(501)).success).toBe(false);
  });
});
