/**
 * GAP-04 storage follow-up: shaping the per-run on-disk cleanup outcome.
 *
 * The web cleanup route deletes database records first and then asks the worker
 * to remove the run's directory tree. That second call is strictly best-effort:
 * a worker that is unreachable (or refuses an unsafe path) must never fail the
 * whole request, it only marks the run's storage as `kept` with a reason.
 */

export interface RunDirectoryCleanupResult {
  removed?: boolean;
  /** Entries relative to the runs root that were (or would be) removed. */
  paths?: string[];
  bytes?: number;
}

export type RunDirectoryCleaner = (input: {
  runId: string;
  ownerId: string;
  dryRun: boolean;
}) => Promise<RunDirectoryCleanupResult>;

export interface RunStorageCleanupOutcome {
  runId: string;
  /** `removed` = the worker removed it (or would, in dry-run); `kept` = left behind. */
  outcome: "removed" | "kept";
  reason?: string;
  dryRun: boolean;
  paths: string[];
  bytes: number;
}

function cleanPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function cleanBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Runs (or, in dry-run, plans) the worker cleanup for one run and shapes a
 * never-throwing outcome. `removed: false` from the worker still counts as
 * `removed` here: nothing exists to delete, which is a successful cleanup.
 */
export async function cleanupRunDirectory(
  run: { id: string; ownerId: string },
  options: { dryRun: boolean; cleaner: RunDirectoryCleaner },
): Promise<RunStorageCleanupOutcome> {
  try {
    const result = await options.cleaner({ runId: run.id, ownerId: run.ownerId, dryRun: options.dryRun });
    return {
      runId: run.id,
      outcome: "removed",
      dryRun: options.dryRun,
      paths: cleanPaths(result.paths),
      bytes: cleanBytes(result.bytes),
    };
  } catch (error) {
    return {
      runId: run.id,
      outcome: "kept",
      reason: (error as Error).message || "worker cleanup failed",
      dryRun: options.dryRun,
      paths: [],
      bytes: 0,
    };
  }
}

/** Outcome for a run whose database records could not be removed (worker not called). */
export function keptRunStorageOutcome(runId: string, reason: string): RunStorageCleanupOutcome {
  return { runId, outcome: "kept", reason, dryRun: false, paths: [], bytes: 0 };
}
