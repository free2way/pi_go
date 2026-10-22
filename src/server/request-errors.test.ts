import { describe, expect, it } from "vitest";
import { conflictReplyFor, requestErrorReply } from "./request-errors.js";
import { InvalidStateTransitionError, RunConflictError } from "./run-store-pg.js";
import { readFileSync } from "node:fs";

describe("conflictReplyFor", () => {
  it("maps a lost compare-and-swap race to a 409 RUN_CONFLICT (NEW-05)", () => {
    const reply = conflictReplyFor(new RunConflictError("run_1", "Run run_1 was modified concurrently; the stale write was rejected"));
    expect(reply).toEqual({
      status: 409,
      code: "RUN_CONFLICT",
      message: "Run run_1 was modified concurrently; the stale write was rejected",
    });
  });

  it("keeps mapping illegal state transitions to 409 INVALID_STATE_TRANSITION", () => {
    const reply = conflictReplyFor(new InvalidStateTransitionError("completed", "developing"));
    expect(reply?.status).toBe(409);
    expect(reply?.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("ignores unrelated errors so they still become 500s", () => {
    expect(conflictReplyFor(new Error("boom"))).toBeUndefined();
    expect(conflictReplyFor(undefined)).toBeUndefined();
  });
});

describe("requestErrorReply", () => {
  it("registers the application handler before plugin and route contexts exist", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const handler = source.indexOf("app.setErrorHandler(");
    expect(handler).toBeGreaterThan(0);
    expect(handler).toBeLessThan(source.indexOf("await app.register("));
    expect(handler).toBeLessThan(source.indexOf("app.get("));
  });

  it.each(["ENOSPC", "ECONNREFUSED", "ETIMEDOUT", "connection timeout", "Connection terminated", "57P01"])("keeps %s as explicit storage failure", (kind) => {
    const result = requestErrorReply(new Error(`${kind} Bearer DUMMY_echo`), {});
    expect(result.status).toBe(503);
    expect(result.storage).toBe(true);
    expect(result.body.code).toBe("STORAGE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("DUMMY");
  });

  it("classifies before redaction and redacts the full value before truncation", () => {
    const secret = "ENOSPC" + "x".repeat(300);
    const error = new Error(secret);
    const result = requestErrorReply(error, { PI_INTERNAL_TOKEN: secret });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("存储不可用：[redacted]");
    expect(error.message).toBe(secret);
  });

  it("returns a generic 500 while keeping a safe log diagnostic", () => {
    const result = requestErrorReply(new Error("ordinary failure Bearer DUMMY_echo"), {});
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Internal error" });
    expect(result.message).toBe("ordinary failure Bearer [redacted]");
  });

  it("preserves client errors, including redaction of known encoded values", () => {
    const secret = "DUMMY/+ service";
    const result = requestErrorReply(Object.assign(new Error("invalid " + encodeURIComponent(secret)), { statusCode: 422 }), { PI_VAULT_SECRET: secret });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "invalid [redacted]" });
    expect(result.storage).toBe(false);
  });
});
