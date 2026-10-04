import { describe, expect, it } from "vitest";
import { PiRunError, boundedTail, failureOutputForEvent } from "./agent-failure.js";

describe("boundedTail", () => {
  it("keeps short output untouched and the tail of long output", () => {
    expect(boundedTail("hello")).toBe("hello");
    expect(boundedTail("")).toBe("");
    expect(boundedTail(undefined)).toBe("");
    const long = `${"x".repeat(100)}${"y".repeat(50)}`;
    const tail = boundedTail(long, 40);
    expect(tail.length).toBe(40);
    expect(tail.endsWith("y")).toBe(true);
  });

  it("does not split a multibyte rune at the tail boundary", () => {
    const text = `${"a".repeat(20)}你好`;
    // 7 bytes = "a" + 你 + 好: a complete rune is never cut in half.
    expect(boundedTail(text, 7)).toBe("a你好");
  });
});

describe("failureOutputForEvent", () => {
  it("carries bounded stdout/stderr and the exit code from a failed Pi call", () => {
    const error = new PiRunError("boom", { code: 2, stdout: "partial output", stderr: "stack trace" });
    expect(failureOutputForEvent(error)).toEqual({ exitCode: 2, stdout: "partial output", stderr: "stack trace" });
    expect(error.code).toBe(2);
    expect(error.stdout).toBe("partial output");
  });

  it("bounds each stream (AT-AGENT-008)", () => {
    const error = new PiRunError("boom", { code: 1, stdout: "x".repeat(100), stderr: "y".repeat(100) });
    const captured = failureOutputForEvent(error, 10);
    expect(captured?.stdout).toBe("x".repeat(10));
    expect(captured?.stderr).toBe("y".repeat(10));
  });

  it("returns undefined for errors without captured process output", () => {
    expect(failureOutputForEvent(new Error("provider 429"))).toBeUndefined();
  });
});
