import { describe, expect, it } from "vitest";
import { workerRefusalDisposition } from "./worker-refusal.js";

describe("workerRefusalDisposition", () => {
  it.each(["WORKER_CAPACITY", "STORAGE_UNKNOWN", "WORKER_SHUTTING_DOWN"])(
    "keeps %s queued",
    (code) => expect(workerRefusalDisposition({ code, message: "arbitrary localized text" })).toBe("queue"),
  );

  it.each([
    { code: "STORAGE_CRITICAL", message: "capacity" },
    { code: "UNEXPECTED", message: "Worker capacity reached" },
    new Error("capacity"),
    null,
  ])("fails every non-allowlisted refusal %#", (error) => {
    expect(workerRefusalDisposition(error)).toBe("fail");
  });
});
