import { describe, expect, it } from "vitest";
import {
  roleCostDisplay,
  roleCostLabel,
  roleDisplayName,
  totalUnpricedCalls,
} from "./budget-roles-view";

const entry = (calls: number, estimatedCost: number, unpricedCalls?: number) => ({
  calls,
  estimatedCost,
  ...(unpricedCalls === undefined ? {} : { unpricedCalls }),
});

describe("roleCostDisplay (AT-JEV-062)", () => {
  it("is unknown when every call is unpriced (never $0.000)", () => {
    const display = roleCostDisplay(entry(3, 0, 3));
    expect(display).toEqual({ kind: "unknown", unpricedCalls: 3 });
    expect(roleCostLabel(entry(3, 0, 3))).toBe("未知");
    expect(roleCostLabel(entry(3, 0, 3))).not.toContain("$");
  });

  it("is unknown for a zero-call row that still reports unpriced calls", () => {
    expect(roleCostDisplay(entry(0, 0, 1))).toEqual({ kind: "unknown", unpricedCalls: 1 });
    expect(roleCostLabel(entry(0, 0, 1))).not.toContain("$");
  });

  it("returns a lower bound for partially priced calls", () => {
    expect(roleCostDisplay(entry(4, 0.123, 1))).toEqual({ kind: "partial", amount: 0.123, unpricedCalls: 1 });
    expect(roleCostLabel(entry(4, 0.123, 1))).toBe("≥ $0.123");
  });

  it("keeps the plain amount when unpricedCalls is absent or zero", () => {
    expect(roleCostDisplay(entry(2, 0.5))).toEqual({ kind: "priced", amount: 0.5 });
    expect(roleCostDisplay(entry(2, 0.5, 0))).toEqual({ kind: "priced", amount: 0.5 });
    expect(roleCostLabel(entry(2, 0.5))).toBe("$0.500");
    expect(roleCostLabel(entry(2, 0.5, 0))).toBe("$0.500");
  });

  it("does not mistake a legitimately free zero-call row for unknown", () => {
    expect(roleCostDisplay(entry(0, 0, 0))).toEqual({ kind: "priced", amount: 0 });
    expect(roleCostLabel(entry(0, 0, 0))).toBe("$0.000");
  });

  it("treats inconsistent data (more unpriced than calls) as unknown", () => {
    expect(roleCostDisplay(entry(2, 0.4, 9))).toEqual({ kind: "unknown", unpricedCalls: 9 });
  });

  it("renders the English wording when asked", () => {
    expect(roleCostLabel(entry(3, 0, 3), "en")).toBe("unknown");
  });
});

describe("totalUnpricedCalls", () => {
  it("sums unpriced calls across roles", () => {
    expect(totalUnpricedCalls([entry(3, 0, 3), entry(4, 0.1, 1), entry(2, 0.5)])).toBe(4);
  });

  it("is zero when nothing is unpriced or the list is absent", () => {
    expect(totalUnpricedCalls([entry(2, 0.5), entry(1, 0.2, 0)])).toBe(0);
    expect(totalUnpricedCalls(undefined)).toBe(0);
    expect(totalUnpricedCalls([])).toBe(0);
  });

  it("ignores non-finite values", () => {
    expect(totalUnpricedCalls([{ calls: 1, estimatedCost: 0, unpricedCalls: Number.NaN }])).toBe(0);
  });
});

describe("roleDisplayName", () => {
  it("localizes the decision plane role and leaves other roles untouched", () => {
    expect(roleDisplayName("decision")).toBe("决策平面");
    expect(roleDisplayName("decision", "en")).toBe("decision plane");
    expect(roleDisplayName("developer")).toBe("developer");
    expect(roleDisplayName("sub-agent")).toBe("sub-agent");
  });
});
