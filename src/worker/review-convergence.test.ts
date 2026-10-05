import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/types.js";
import { mergeFindings } from "./review-findings.js";
import {
  convergenceGuardEnabled,
  convergenceHistory,
  convergenceStop,
  convergenceVerdict,
  requiredStalledRounds,
} from "./review-convergence.js";

function incoming(id: string, severity: Finding["severity"]): Omit<Finding, "resolved"> {
  return { id, severity, file: null, line: null, title: id, evidence: "evidence", requiredChange: "change" };
}

/** Builds merged findings across review rounds, the same way the worker does. */
function reviewRounds(rounds: Array<Array<Finding["severity"]>>): Finding[] {
  let findings: Finding[] = [];
  rounds.forEach((severities, index) => {
    findings = mergeFindings(
      findings,
      severities.map((severity, position) => incoming(`r${index + 1}-${position + 1}`, severity)),
      { round: index + 1 },
    );
  });
  return findings;
}

describe("convergenceGuardEnabled (PI_REVIEW_CONVERGENCE_GUARD)", () => {
  it("defaults to on and only `off` disables it", () => {
    expect(convergenceGuardEnabled(undefined)).toBe(true);
    expect(convergenceGuardEnabled("")).toBe(true);
    expect(convergenceGuardEnabled("on")).toBe(true);
    expect(convergenceGuardEnabled("OFF")).toBe(false);
    expect(convergenceGuardEnabled(" off ")).toBe(false);
  });
});

describe("convergenceHistory", () => {
  it("counts new severe/total findings per round", () => {
    const findings = reviewRounds([["critical", "medium"], ["high"]]);
    const history = convergenceHistory(findings, 2);
    expect(history.map((entry) => entry.round)).toEqual([1, 2]);
    expect(history[0]).toMatchObject({ round: 1, newBlocking: 1, newTotal: 2 });
    expect(history[1]).toMatchObject({ round: 2, newBlocking: 1, newTotal: 1 });
  });

  it("skips review-less rounds but always keeps the current round", () => {
    // Rounds 1 and 2 raised findings; round 3 is the current (maybe checks-only)
    // round and is kept at zero so the caller can inspect it.
    const findings = reviewRounds([["critical"], ["high"]]);
    const history = convergenceHistory(findings, 4);
    expect(history.map((entry) => entry.round)).toEqual([1, 2, 4]);
    expect(history[2]).toMatchObject({ round: 4, newBlocking: 0, newTotal: 0 });
  });

  it("attributes findings without firstSeenRound (older runs) to round 1", () => {
    const legacy: Finding[] = [
      { id: "old", severity: "high", file: null, line: null, title: "old", evidence: "", requiredChange: "", resolved: false },
    ];
    expect(convergenceHistory(legacy, 1)[0]).toMatchObject({ round: 1, newBlocking: 1, newTotal: 1 });
  });
});

describe("convergenceVerdict / convergenceStop (early stop before another repair round)", () => {
  it("declares a stall after two consecutive rounds whose new severe count did not decrease", () => {
    const findings = reviewRounds([
      ["critical", "high"],
      ["critical", "high"],
      ["critical", "high"],
    ]);
    const verdict = convergenceVerdict(convergenceHistory(findings, 3));
    expect(requiredStalledRounds).toBe(2);
    expect(verdict.stalled).toBe(true);
    expect(verdict.stalledRounds).toBe(2);
    expect(verdict.previousBlocking).toBe(2);
    expect(verdict.currentBlocking).toBe(2);
    expect(verdict.message).toContain("审核未收敛");
    expect(verdict.message).toContain("连续两轮");
    expect(verdict.message).toContain("2→2");
    expect(verdict.message).toContain("缩小范围或拆分任务");
  });

  it("treats an increasing severe count as not converging (4 flat then worse)", () => {
    const findings = reviewRounds([
      ["critical", "critical"],
      ["critical", "critical"],
      ["critical", "critical"],
      ["critical", "critical", "critical"],
    ]);
    const verdict = convergenceVerdict(convergenceHistory(findings, 4));
    expect(verdict.stalled).toBe(true);
    expect(verdict.previousBlocking).toBe(2);
    expect(verdict.currentBlocking).toBe(3);
    expect(verdict.message).toContain("2→3");
  });

  it("does not stall while the severe count is still decreasing", () => {
    const findings = reviewRounds([["high", "high", "high"], ["high", "high"], ["high"]]);
    const verdict = convergenceVerdict(convergenceHistory(findings, 3));
    expect(verdict.stalled).toBe(false);
    expect(verdict.stalledRounds).toBe(0);
    expect(verdict.message).toBe("");
  });

  it("resets the stall counter when the latest round decreases", () => {
    const findings = reviewRounds([
      ["high", "high", "high", "high"],
      ["high", "high", "high", "high"],
      ["high", "high"],
    ]);
    expect(convergenceVerdict(convergenceHistory(findings, 3)).stalled).toBe(false);
  });

  it("never stalls on a round with zero new severe findings (progress, not a stall)", () => {
    const findings = reviewRounds([[], [], []]);
    expect(convergenceVerdict(convergenceHistory(findings, 3)).stalled).toBe(false);
  });

  it("makes no judgement with sparse data (fewer than three rounds)", () => {
    const one = reviewRounds([["critical"]]);
    expect(convergenceVerdict(convergenceHistory(one, 1)).stalled).toBe(false);
    const two = reviewRounds([["critical"], ["critical"]]);
    const sparse = convergenceVerdict(convergenceHistory(two, 2));
    expect(sparse.stalled).toBe(false);
    expect(sparse.perRound).toHaveLength(2);
  });

  it("convergenceStop returns the event payload with per-round counts, and never fires when disabled", () => {
    const findings = reviewRounds([["high"], ["high"], ["high"]]);
    const stop = convergenceStop({ findings, currentRound: 3 });
    expect(stop.stop).toBe(true);
    if (!stop.stop) throw new Error("expected a stop");
    expect(stop.message).toContain("审核未收敛");
    expect(stop.meta.stalledRounds).toBe(2);
    expect(Array.isArray(stop.meta.perRound)).toBe(true);
    expect((stop.meta.perRound as unknown[])).toHaveLength(3);

    expect(convergenceStop({ findings, currentRound: 3, enabled: false })).toEqual({ stop: false });
  });
});
