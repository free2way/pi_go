import { describe, expect, it } from "vitest";
import type { ChatPayload } from "../shared/chat.js";
import type { CheckResult } from "../shared/types.js";
import { runChecks, throwIfCancelled, type CheckIO } from "./checks.js";

describe("runChecks", () => {
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
