import { describe, expect, it } from "vitest";
import { baseDemoRun } from "../server/demo-runner.js";
import type { Run, RunEvent } from "../shared/types";
import { createRunSelectionGuard, eventsForRun, isRunSelected, pickSelectedRun } from "./run-selection.js";

const makeRun = (id: string): Run => ({
  ...baseDemoRun({ title: "Selection race", task: "A sufficiently long task", repository: "test/repo" }),
  id,
});

const runEvent = (runId: string, seq: number): RunEvent => ({
  seq,
  runId,
  round: 1,
  source: "developer",
  type: "chat.message",
  message: `message-${seq}`,
  at: "2026-10-04T10:00:00.000Z",
});

describe("createRunSelectionGuard", () => {
  it("accepts updates and events for the active run", () => {
    const guard = createRunSelectionGuard("run_a");

    expect(guard.isActive()).toBe(true);
    expect(guard.acceptRun(makeRun("run_a"))).toBe(true);
    expect(guard.acceptEvent(runEvent("run_a", 1))).toBe(true);
  });

  it("drops delayed responses and foreign events after switching runs", () => {
    const guard = createRunSelectionGuard("run_a");
    guard.invalidate(); // The user switched to run_b while requests were in flight.

    expect(guard.isActive()).toBe(false);
    // A delayed api.run(run_a) result must not overwrite the newly selected run.
    expect(guard.acceptRun(makeRun("run_a"))).toBe(false);
    expect(guard.acceptEvent(runEvent("run_a", 2))).toBe(false);

    const next = createRunSelectionGuard("run_b");
    // A draining run_a stream event must not mix into run_b.
    expect(next.acceptEvent(runEvent("run_a", 2))).toBe(false);
    expect(next.acceptEvent(runEvent("run_b", 1))).toBe(true);
    expect(next.acceptRun(makeRun("run_b"))).toBe(true);
  });

  it("never accepts a run that does not match the selected id", () => {
    const guard = createRunSelectionGuard("run_a");

    expect(guard.acceptRun(makeRun("run_b"))).toBe(false);
  });
});

describe("eventsForRun", () => {
  it("filters out events from other runs", () => {
    const events = [runEvent("run_a", 1), runEvent("run_b", 1), runEvent("run_a", 2)];

    expect(eventsForRun(events, "run_a").map((item) => item.seq)).toEqual([1, 2]);
  });

  it("returns an empty list without a selection", () => {
    expect(eventsForRun([runEvent("run_a", 1)], undefined)).toEqual([]);
  });
});

describe("pickSelectedRun / isRunSelected", () => {
  const runA = makeRun("run_a");
  const runB = makeRun("run_b");

  it("returns the list entry for the selected id so the header can render immediately", () => {
    expect(pickSelectedRun([runA, runB], "run_b")).toBe(runB);
  });

  it("returns undefined when nothing is selected or the id is not in the list", () => {
    expect(pickSelectedRun([runA, runB], undefined)).toBeUndefined();
    expect(pickSelectedRun([runA, runB], "run_missing")).toBeUndefined();
  });

  it("rejects a snapshot whose id no longer matches the selection", () => {
    // Regression: after switching run_a -> run_b, the stale run_a snapshot must
    // never back the header (this was what left the big title stuck).
    expect(isRunSelected(runA, "run_b")).toBe(false);
    expect(isRunSelected(runB, "run_b")).toBe(true);
    expect(isRunSelected(runA, undefined)).toBe(false);
    expect(isRunSelected(undefined, "run_b")).toBe(false);
  });
});
