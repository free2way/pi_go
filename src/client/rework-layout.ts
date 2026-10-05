/**
 * Rework-branch topology layout — pure, tunable placement for the `rework-<round>`
 * edges of the workflow graph.
 *
 * Every return round is drawn as its own branch that leaves the reviewer and
 * feeds the developer again. The branches used to dip to the *same* side (all
 * below the pipeline) with a fixed stagger, so with several rounds they stacked
 * underneath each other and pushed the graph off-canvas. This helper spreads
 * them evenly: branches alternate above/below and same-side branches are
 * staggered by a growing offset, with a compression rule so the graph stays
 * bounded no matter how many returns a run accumulates.
 *
 * The helper is intentionally geometry-free: it returns a positive dip
 * magnitude per branch. The view maps `above`/`below` to the matching handles
 * (`centerY = pipelineTop - offset` / `pipelineBottom + offset`), so the same
 * numbers stay usable by any renderer or test.
 */

/** Vertical dip (flow units) of the first branch on a side. Tune to taste. */
export const REWORK_BASE_OFFSET = 96;
/** Extra dip added for every further branch that shares the same side. */
export const REWORK_SIDE_STEP = 44;
/** Linear offsets stop growing past this value; deeper branches compress. */
export const REWORK_MAX_OFFSET = 240;
/**
 * Hard ceiling of the compression tail. Once the linear step would exceed
 * {@link REWORK_MAX_OFFSET} the offset asymptotically approaches this value
 * (`REWORK_MAX_OFFSET + REWORK_SIDE_STEP`) but never reaches it.
 */
export const REWORK_HARD_CEILING = REWORK_MAX_OFFSET + REWORK_SIDE_STEP;

/** Side a branch is drawn on. The first round dips below, the second above, … */
export type ReworkSide = "above" | "below";
export interface ReworkBranchLayout {
  round: number;
  side: ReworkSide;
  /** Positive dip magnitude from the pipeline, in flow units. */
  offset: number;
}

/** Highest same-side index whose linear offset still fits within the budget. */
const LAST_LINEAR_SLOT = Math.floor((REWORK_MAX_OFFSET - REWORK_BASE_OFFSET) / REWORK_SIDE_STEP);

/**
 * Offset for the `index`-th branch on one side (0-based):
 *   - first {LAST_LINEAR_SLOT + 1} branches grow linearly by `REWORK_SIDE_STEP`;
 *   - beyond that the remaining gap to `REWORK_HARD_CEILING` is halved on each
 *     further branch (`1 - 2^-k`), so offsets stay strictly increasing — and
 *     therefore never collide — while remaining bounded.
 */
function offsetForSameSide(index: number): number {
  const linear = REWORK_BASE_OFFSET + REWORK_SIDE_STEP * index;
  if (linear <= REWORK_MAX_OFFSET) return linear;
  const overflow = index - LAST_LINEAR_SLOT;
  return REWORK_MAX_OFFSET + REWORK_SIDE_STEP * (1 - 2 ** -overflow);
}

/**
 * Places every rework round (ascending, deduplicated) on `above`/`below`,
 * alternating sides so consecutive rounds never share a side, and staggering
 * same-side branches so two never share a dip. Deterministic: output order and
 * offsets depend only on the sorted round set.
 */
export function reworkBranchLayout(rounds: number[]): ReworkBranchLayout[] {
  return [...new Set(rounds)].sort((a, b) => a - b).map((round, index) => ({
    round,
    side: index % 2 === 0 ? "below" : "above",
    offset: offsetForSameSide(Math.floor(index / 2)),
  }));
}

/** Radius of the two bends where a rework branch turns onto its apex rail. */
export const REWORK_CORNER_RADIUS = 16;

/**
 * Orthogonal SVG path for one branch: leave the source handle vertically, run
 * along the apex rail at `railY`, then enter the target handle vertically. The
 * bends are rounded by up to {@link REWORK_CORNER_RADIUS}.
 *
 * Built by hand instead of `getSmoothStepPath`: the smooth-step util only
 * honours a custom `centerY` for *opposite* handle positions, so with the
 * same-side (bottom→bottom / top→top) handles every branch collapsed onto one
 * rail — the exact stacking this layout fixes. `side` picks the dip direction
 * (`above` ⇒ `railY` above the handles).
 */
export function reworkBranchPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  railY: number,
  side: ReworkSide,
): string {
  const dir = side === "above" ? -1 : 1;
  const sign = targetX >= sourceX ? 1 : -1;
  const radius = Math.max(0, Math.min(
    REWORK_CORNER_RADIUS,
    Math.abs(targetX - sourceX) / 2,
    Math.abs(railY - sourceY) / 2,
    Math.abs(railY - targetY) / 2,
  ));
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${railY - dir * radius}`,
    `Q ${sourceX} ${railY} ${sourceX + sign * radius} ${railY}`,
    `L ${targetX - sign * radius} ${railY}`,
    `Q ${targetX} ${railY} ${targetX} ${railY - dir * radius}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}
