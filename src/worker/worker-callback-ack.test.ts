import { afterEach, expect, it, vi } from "vitest";
vi.mock("./worker-runtime.js", () => ({ callbackBase: "http://web.invalid", internalToken: "fixture", workerId: "fixture-worker",
  diagnosticMessage: (value: unknown) => String(value), workspaceRoot: "/workspace" }));
import { activeJobLeases, postUpdate } from "./worker-web-client.js";

afterEach(() => { activeJobLeases.clear(); vi.unstubAllGlobals(); });
it.each([
  [409, "RUN_ALREADY_CANCELLED", "RUN_ALREADY_CANCELLED"],
  [500, "RUN_ALREADY_CANCELLED", undefined],
  [409, "JOB_LEASE_LOST", undefined],
  [409, "OTHER", undefined],
] as const)("trusts a cancellation acknowledgement only on its explicit conflict response: %s/%s", async (status, code, expected) => {
  activeJobLeases.set("fixture-run", "fixture-job");
  const response = new Response(JSON.stringify({ code }), { status });
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const error = await postUpdate("fixture-run", { patch: { state: "cancelled" } }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe(expected);
  expect(error.message).toBe(`Callback failed: ${status} ${JSON.stringify({ code })}`);
});
it("keeps network failures distinguishable from confirmed cancellation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture connection closed"); }));
  const error = await postUpdate("fixture-run", { patch: { state: "cancelled" } }).catch(error => error);
  expect(error.code).toBeUndefined();
  expect(error.message).toContain("fixture connection closed");
});
