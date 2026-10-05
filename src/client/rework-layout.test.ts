import { describe, expect, it } from "vitest";
import {
  REWORK_BASE_OFFSET,
  REWORK_CORNER_RADIUS,
  REWORK_HARD_CEILING,
  REWORK_MAX_OFFSET,
  REWORK_SIDE_STEP,
  reworkBranchLayout,
  reworkBranchPath,
  type ReworkBranchLayout,
} from "./rework-layout";

const sides = (layout: ReworkBranchLayout[]) => layout.map((branch) => branch.side);
const offsetsOn = (layout: ReworkBranchLayout[], side: ReworkBranchLayout["side"]) =>
  layout.filter((branch) => branch.side === side).map((branch) => branch.offset);

describe("reworkBranchLayout", () => {
  it("returns nothing for an empty round list", () => {
    expect(reworkBranchLayout([])).toEqual([]);
  });

  it("puts a single branch below at the base offset", () => {
    expect(reworkBranchLayout([4])).toEqual([{ round: 4, side: "below", offset: REWORK_BASE_OFFSET }]);
  });

  it("alternates sides so consecutive rounds never share a side", () => {
    const layout = reworkBranchLayout([1, 2, 3, 4, 5]);
    expect(sides(layout)).toEqual(["below", "above", "below", "above", "below"]);
    for (let index = 1; index < layout.length; index += 1) {
      expect(layout[index].side).not.toBe(layout[index - 1].side);
    }
  });

  it("never gives two branches on the same side the same offset", () => {
    const layout = reworkBranchLayout([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const side of ["above", "below"] as const) {
      const sideOffsets = offsetsOn(layout, side);
      expect(new Set(sideOffsets).size).toBe(sideOffsets.length);
    }
  });

  it("grows same-side offsets linearly by the staggered step", () => {
    const layout = reworkBranchLayout([1, 2, 3, 4, 5]);
    expect(offsetsOn(layout, "below")).toEqual([
      REWORK_BASE_OFFSET,
      REWORK_BASE_OFFSET + REWORK_SIDE_STEP,
      REWORK_BASE_OFFSET + REWORK_SIDE_STEP * 2,
    ]);
    expect(offsetsOn(layout, "above")).toEqual([
      REWORK_BASE_OFFSET,
      REWORK_BASE_OFFSET + REWORK_SIDE_STEP,
    ]);
  });

  it("caps and compresses offsets beyond the budget so the graph stays bounded", () => {
    const many = Array.from({ length: 60 }, (_, index) => index + 1);
    const layout = reworkBranchLayout(many);

    for (const side of ["above", "below"] as const) {
      const sideOffsets = offsetsOn(layout, side);
      // Bounded by the hard ceiling and strictly increasing (=> distinct).
      for (const offset of sideOffsets) {
        expect(offset).toBeGreaterThanOrEqual(REWORK_BASE_OFFSET);
        expect(offset).toBeLessThan(REWORK_HARD_CEILING);
      }
      for (let index = 1; index < sideOffsets.length; index += 1) {
        expect(sideOffsets[index]).toBeGreaterThan(sideOffsets[index - 1]);
      }
    }

    // The tail no longer grows by the full step: the last gap is compressed.
    const below = offsetsOn(layout, "below");
    const tail = below[below.length - 1] - below[below.length - 2];
    expect(tail).toBeLessThan(REWORK_SIDE_STEP);
    // Everything beyond the linear budget sits inside the compressed band.
    const linearMax = REWORK_BASE_OFFSET + REWORK_SIDE_STEP * Math.floor((REWORK_MAX_OFFSET - REWORK_BASE_OFFSET) / REWORK_SIDE_STEP);
    expect(below[0]).toBe(REWORK_BASE_OFFSET);
    expect(below.some((offset) => offset > linearMax && offset < REWORK_HARD_CEILING)).toBe(true);
  });

  it("sorts and deduplicates the input deterministically", () => {
    const layout = reworkBranchLayout([5, 1, 3, 3, 1]);
    expect(layout.map((branch) => branch.round)).toEqual([1, 3, 5]);
    expect(reworkBranchLayout([5, 1, 3, 3, 1])).toEqual(layout);
  });
});

describe("reworkBranchPath", () => {
  it("starts at the source, runs on the given rail and ends at the target", () => {
    const path = reworkBranchPath(298, 145, 826, 145, 241, "below");
    expect(path.startsWith("M 298 145")).toBe(true);
    expect(path.endsWith("L 826 145")).toBe(true);
    expect(path).toContain(`L 298 ${241 - REWORK_CORNER_RADIUS}`);
    expect(path).toContain("241");
  });

  it("mirrors the dip direction for an above branch", () => {
    const below = reworkBranchPath(298, 72, 826, 72, 168, "below");
    const above = reworkBranchPath(298, 72, 826, 72, -24, "above");
    // Below heads away from the handles downwards, above upwards.
    expect(below).toContain(`L 298 ${168 - REWORK_CORNER_RADIUS}`);
    expect(above).toContain(`L 298 ${-24 + REWORK_CORNER_RADIUS}`);
    expect(above).not.toBe(below);
  });

  it("keeps two same-side branches on distinct paths", () => {
    expect(reworkBranchPath(298, 145, 826, 145, 241, "below"))
      .not.toBe(reworkBranchPath(298, 145, 826, 145, 285, "below"));
  });

  it("clamps the corner radius on short spans without emitting NaN", () => {
    const path = reworkBranchPath(300, 145, 310, 145, 241, "below");
    expect(path).not.toContain("NaN");
    expect(path).toContain("M 300 145");
    expect(path).toContain("L 310 145");
  });
});
