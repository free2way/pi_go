import { describe, expect, it } from "vitest";
import { LOCALE_INSTRUCTION_LABEL, localeInstruction } from "./prompt-locale.js";

describe("agent prompt locale instruction (docs/24-i18n.md §10)", () => {
  it("is one clearly-labelled block in every prompt", () => {
    for (const locale of ["zh", "en"] as const) {
      expect(localeInstruction(locale).startsWith(LOCALE_INSTRUCTION_LABEL)).toBe(true);
    }
  });

  it("asks for English summaries, findings and chat text for an English run", () => {
    const block = localeInstruction("en");
    expect(block).toContain("English");
    expect(block).toContain("summary");
    expect(block).toContain("title, evidence and requiredChange");
    expect(block).toContain("chat message");
    expect(block).not.toContain("中文");
  });

  it("keeps Chinese for a Chinese run (the default)", () => {
    expect(localeInstruction("zh")).toContain("中文");
    expect(localeInstruction("zh")).toContain("title/evidence/requiredChange");
    // An omitted/unknown locale reads as Chinese, exactly like `run.locale`.
    expect(localeInstruction(undefined)).toBe(localeInstruction("zh"));
    expect(localeInstruction(null)).toBe(localeInstruction("zh"));
  });

  it("covers the JSON-contract fields so findings arrive in the run's language", () => {
    for (const locale of ["zh", "en"] as const) {
      for (const field of ["title", "evidence", "requiredChange"]) {
        expect(localeInstruction(locale)).toContain(field);
      }
    }
  });
});
