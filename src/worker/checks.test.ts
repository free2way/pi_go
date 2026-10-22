import { describe, expect, it } from "vitest";
import type { ChatPayload } from "../shared/chat.js";
import type { CheckResult } from "../shared/types.js";
import { runChecks, throwIfCancelled, type CheckIO } from "./checks.js";

describe("runChecks", () => {
  it.each([0, 1])("redacts every persisted result and chat while retaining exit %i", async (code) => {
    const known = "synthetic-job-canary/+";
    const command = `echo '${known}'`;
    const recorded: unknown[] = [];
    const executed: string[] = [];
    const outcome = await runChecks({
      commands: [command], secrets: [known], signal: new AbortController().signal,
      execute: async (raw) => {
        executed.push(raw);
        const url = new URL("postgresql://db.example.invalid/app");
        url.username = "x";
        url.password = ["DUMMY", "db", "canary"].join("_");
        return { code, stdout: `Bearer DUMMY_header_canary\n${known}`, stderr: url.href };
      },
      started: async (...args) => { recorded.push(args); },
      finished: async (...args) => { recorded.push(args); },
      chat: async (payload) => { recorded.push(payload); },
    });
    expect(executed).toEqual([command]);
    const serialized = JSON.stringify([recorded, outcome]);
    for (const canary of [known, "DUMMY_header_canary", "DUMMY_db_canary"]) expect(serialized).not.toContain(canary);
    expect(serialized).toContain("[redacted]");
    expect(outcome.passed).toBe(code === 0);
    expect(outcome.results[0].exitCode).toBe(code);
  });

  it("redacts before tail clipping so a boundary cannot retain a credential suffix", async () => {
    const canary = "DUMMY-boundary-canary";
    const outcome = await runChecks({
      commands: ["npm test"], secrets: [canary], signal: new AbortController().signal,
      execute: async () => ({ code: 1, stdout: `${"x".repeat(30)}${canary}${"y".repeat(11_990)}`, stderr: "" }),
      started: async () => undefined, finished: async () => undefined, chat: async () => undefined,
    });
    expect(outcome.results[0].output).not.toContain("canary");
    expect(outcome.results[0].output!.length).toBeLessThanOrEqual(12_000);
  });

  it("redacts execution errors before they escape the suite", async () => {
    await expect(runChecks({
      commands: ["npm test"], secrets: ["synthetic-job-canary"], signal: new AbortController().signal,
      execute: async () => { throw new Error("synthetic-job-canary Bearer DUMMY_error_canary"); },
      started: async () => undefined, finished: async () => undefined, chat: async () => undefined,
    })).rejects.toThrow("[redacted] Bearer [redacted]");
  });

  it("stops when cancelled during a check without reporting failure or chat", async () => {
    const controller = new AbortController();
    const started: CheckResult[][] = [];
    const finished: CheckResult[][] = [];
    const chats: ChatPayload[] = [];
    const io: CheckIO = {
      commands: ["npm test", "npm run build"],
      signal: controller.signal,
      execute: async () => {
        controller.abort();
        // AbortSignal aborts the spawned command; the real `command` helper
        // resolves with code 130 instead of rejecting.
        return { code: 130, stdout: "", stderr: "aborted" };
      },
      started: async (checks) => { started.push(checks); },
      finished: async (checks) => { finished.push(checks); },
      chat: async (payload) => { chats.push(payload); },
    };

    await expect(runChecks(io)).rejects.toThrow("cancelled");

    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(0);
    expect(chats).toHaveLength(0);
  });

  it("records passing and failing checks and emits checks chat entries", async () => {
    const results = [
      { code: 0, stdout: "ok", stderr: "" },
      { code: 1, stdout: "", stderr: "boom" },
    ];
    let index = 0;
    const finished: CheckResult[][] = [];
    const chats: ChatPayload[] = [];
    const outcome = await runChecks({
      commands: ["npm test", "npm run build"],
      signal: new AbortController().signal,
      execute: async () => results[index++],
      started: async () => undefined,
      finished: async (checks) => { finished.push(checks); },
      chat: async (payload) => { chats.push(payload); },
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.results.map((result) => result.status)).toEqual(["passed", "failed"]);
    expect(finished).toHaveLength(2);
    expect(chats).toHaveLength(2);
    expect(chats[0]).toMatchObject({ channel: "checks", role: "status" });
    expect(chats[1]).toMatchObject({ channel: "checks", role: "feedback", to: "developer" });
  });

  it("throws before executing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = 0;
    await expect(runChecks({
      commands: ["npm test"],
      signal: controller.signal,
      execute: async () => { executed += 1; return { code: 0, stdout: "", stderr: "" }; },
      started: async () => undefined,
      finished: async () => undefined,
      chat: async () => undefined,
    })).rejects.toThrow("cancelled");
    expect(executed).toBe(0);
  });
});

describe("throwIfCancelled", () => {
  it("does not throw for an active signal", () => {
    expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
  });

  it("throws for an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfCancelled(controller.signal)).toThrow("cancelled");
  });
});
