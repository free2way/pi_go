/**
 * Human-like codenames for auto-split sub-agents.
 *
 * Why a curated catalog instead of random ids: an operator reads the run
 * timeline, the agent panel and the collaboration log. `task-3` or a uuid means
 * nothing, while "云舟" / "观澜" gives each sub-agent a stable handle to talk
 * about. The name is a *display* aid — the task id and title remain the
 * authoritative identity.
 *
 * Determinism contract:
 * - The base name depends only on `runId + taskId` (no clock, no RNG, no
 *   Map/Set iteration order), so a re-render, worker restart or checkpoint
 *   resume reconstructs exactly the same names.
 * - Collisions inside one run are resolved by walking the catalog forward from
 *   the hashed start, in the stable task order the planner returned.
 * - When the catalog is exhausted a deterministic numeric suffix is appended,
 *   so assignment never fails and stays collision-free.
 */

export const SUBAGENT_CODENAMES: readonly string[] = [
  "云舟",
  "观澜",
  "知微",
  "抱朴",
  "砚青",
  "拾光",
  "星驰",
  "澄川",
  "岩松",
  "墨言",
  "澜声",
  "松涧",
  "昭明",
  "竹隐",
  "渡川",
  "素笺",
  "长庚",
  "启明",
  "沧溟",
  "望舒",
  "亦航",
  "怀瑾",
  "清让",
  "弦歌",
];

/**
 * FNV-1a over UTF-16 code units. Small, dependency-free and identical on every
 * platform/Node version — unlike `Math.random` or object key ordering.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The preferred (collision-ignorant) codename for one task. */
export function subAgentCodename(runId: string, taskId: string, catalog: readonly string[] = SUBAGENT_CODENAMES): string {
  if (catalog.length === 0) return `Sub Agent-${stableHash(`${runId}:${taskId}`).toString(36)}`;
  return catalog[stableHash(`${runId}:${taskId}`) % catalog.length];
}

/**
 * Assigns one collision-free codename per task id, deterministically for a
 * given run. Returns names in the same order as `taskIds`.
 */
export function assignSubAgentCodenames(
  runId: string,
  taskIds: readonly string[],
  catalog: readonly string[] = SUBAGENT_CODENAMES,
): string[] {
  if (catalog.length === 0) {
    // Degenerate catalog (never the default): still deterministic and unique.
    return taskIds.map((taskId, index) => `Sub Agent-${stableHash(`${runId}:${taskId}`).toString(36)}-${index + 1}`);
  }
  const used = new Set<string>();
  return taskIds.map((taskId, order) => {
    const start = stableHash(`${runId}:${taskId}`) % catalog.length;
    for (let step = 0; step < catalog.length; step += 1) {
      const candidate = catalog[(start + step) % catalog.length];
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    // Catalog exhausted: deterministic suffixed fallback, still collision-free.
    let attempt = order + 1;
    let candidate = `${catalog[start]}·${attempt}`;
    while (used.has(candidate)) {
      attempt += 1;
      candidate = `${catalog[start]}·${attempt}`;
    }
    used.add(candidate);
    return candidate;
  });
}
