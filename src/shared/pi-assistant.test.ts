import { describe, expect, it } from "vitest";
import { parsePiAssistantOutput } from "./pi-assistant.js";

describe("parsePiAssistantOutput", () => {
  it("normalizes and bounds a structured answer", () => {
    expect(parsePiAssistantOutput(JSON.stringify({
      answer: "Check the failed test first.",
      category: "diagnose",
      suggestedQuestions: ["Which check failed?", "Show the next safe step", "Explain the review state", "ignored"],
    }))).toEqual({
      answer: "Check the failed test first.",
      category: "diagnose",
      suggestedQuestions: ["Which check failed?", "Show the next safe step", "Explain the review state"],
    });
  });

  it("rejects an empty answer and defaults unknown categories", () => {
    expect(parsePiAssistantOutput('{"answer":"Available context is limited.","category":"act"}').category).toBe("explain");
    expect(() => parsePiAssistantOutput('{"answer":""}')).toThrow(/empty answer/);
  });
});
