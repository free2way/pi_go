import type { CheckResult } from "../shared/types.js";
import type { ReviewResult } from "./review-protocol.js";

export interface Checkpoint {
  stageKey: string;
  status: "running" | "completed" | "failed" | string;
  payload: unknown;
  idempotencyKey: string | null;
  updatedAt: string;
}

export interface CheckpointSaveInput {
  stageKey: string;
  status: string;
  payload?: unknown;
  idempotencyKey?: string;
}

export interface CheckpointClient {
  list(runId: string): Promise<Checkpoint[]>;
  save(runId: string, input: CheckpointSaveInput): Promise<void>;
}

/** Stage keys used by the worker pipeline (REL-003). */
export const stages = {
  planning: "planning",
  task: (taskId: string) => `task:${taskId}`,
  development: (round: number) => `dev:${round}`,
  checks: (round: number) => `checks:${round}`,
  review: (round: number) => `review:${round}`,
} as const;

export type StoredReview = ReviewResult & { round?: number; snapshotHash?: string };
export type StoredChecks = { passed: boolean; results: CheckResult[]; round?: number; snapshotHash?: string };

/**
 * NEW-03: a checkpoint is only reusable when it was produced for the exact same
 * content (and round) as the current worktree. Older payloads without a
 * `snapshotHash` never match, so the stage is re-run instead of trusted.
 */
export function isCheckpointCurrent(
  payload: ({ round?: number; snapshotHash?: string } & Record<string, unknown>) | undefined | null,
  current: { round: number; snapshotHash: string },
): boolean {
  return Boolean(payload) && payload?.round === current.round && payload?.snapshotHash === current.snapshotHash;
}

/**
 * Tracks which pipeline stages already finished so a restarted worker resumes
 * instead of repeating completed model calls (REL-003, AT-REL-002/003).
 */
export class CheckpointTracker {
  private readonly entries = new Map<string, Checkpoint>();

  constructor(private readonly client: CheckpointClient, private readonly runId: string) {}

  async load() {
    for (const checkpoint of await this.client.list(this.runId)) {
      this.entries.set(checkpoint.stageKey, checkpoint);
    }
    return this;
  }

  get size() {
    return this.entries.size;
  }

  isCompleted(stageKey: string) {
    return this.entries.get(stageKey)?.status === "completed";
  }

  isRunning(stageKey: string) {
    return this.entries.get(stageKey)?.status === "running";
  }

  payload<T>(stageKey: string) {
    return this.entries.get(stageKey)?.payload as T | undefined;
  }

  private async save(stageKey: string, status: string, payload?: unknown) {
    const idempotencyKey = `${this.runId}:${stageKey}`;
    await this.client.save(this.runId, { stageKey, status, payload, idempotencyKey });
    this.entries.set(stageKey, {
      stageKey,
      status,
      payload: payload ?? null,
      idempotencyKey,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Marks a stage as in flight so an interrupted attempt is visible after a restart. */
  start(stageKey: string) {
    return this.save(stageKey, "running");
  }

  complete(stageKey: string, payload?: unknown) {
    return this.save(stageKey, "completed", payload);
  }

  fail(stageKey: string, error: string) {
    return this.save(stageKey, "failed", { error });
  }
}

/** In-memory client used by tests and when checkpointing is disabled. */
export function memoryCheckpointClient(seed: Checkpoint[] = []): CheckpointClient {
  const store = new Map<string, Checkpoint>(seed.map((item) => [item.stageKey, item]));
  return {
    list: async () => [...store.values()],
    save: async (_runId, input) => {
      store.set(input.stageKey, {
        stageKey: input.stageKey,
        status: input.status,
        payload: input.payload ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
