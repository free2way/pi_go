import { describe, expect, it } from "vitest";
import { assertPiCliInput, maxPiCliInputBytes, PiInputTransportError, reviewTransportLimits } from "./pi-cli-input.js";

describe("Pi CLI input transport", () => {
  it("counts the complete UTF-8 argument and allows the exact byte boundary", () => {
    expect(maxPiCliInputBytes).toBe(120_000);
    expect(() => assertPiCliInput("a".repeat(maxPiCliInputBytes))).not.toThrow();
    expect(() => assertPiCliInput("需".repeat(maxPiCliInputBytes / 3))).not.toThrow();
    expect(() => assertPiCliInput("a".repeat(maxPiCliInputBytes + 1))).toThrow(PiInputTransportError);
    expect(() => assertPiCliInput("需".repeat(maxPiCliInputBytes / 3 + 1))).toThrow(PiInputTransportError);
  });

  it("rejects NUL without exposing input contents in error diagnostics", () => {
    const marker = "DUMMY_PRIVATE_CONTENT";
    try {
      assertPiCliInput(`${marker}\0unsafe`);
      throw new Error("Expected input refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PiInputTransportError);
      expect((error as PiInputTransportError).reason).toBe("nul");
      expect(String(error)).not.toContain(marker);
    }
  });

  it("reserves task and surrounding text before applying the diff budget", () => {
    const prefix = "需".repeat(10_000);
    expect(reviewTransportLimits(prefix, { fileDiffBytes: 40_000, totalDiffBytes: 200_000 })).toEqual({
      fileDiffBytes: 40_000, totalDiffBytes: 90_000,
    });
    expect(reviewTransportLimits(prefix, { fileDiffBytes: 10_000, totalDiffBytes: 30_000 }).totalDiffBytes).toBe(30_000);
    expect(() => reviewTransportLimits("x".repeat(120_001), { fileDiffBytes: 40_000, totalDiffBytes: 200_000 })).toThrow(PiInputTransportError);
    expect(() => reviewTransportLimits("task\0text", { fileDiffBytes: 40_000, totalDiffBytes: 200_000 })).toThrow(PiInputTransportError);
  });
});
