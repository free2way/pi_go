export type WorkerRefusalDisposition = "queue" | "fail";

/**
 * Only explicit, transient Worker state codes keep a durable job queued.
 * Transport errors, unknown codes and storage-critical failures are terminal
 * for this dispatch attempt so a changed message can never alter behavior.
 */
export function workerRefusalDisposition(error: unknown): WorkerRefusalDisposition {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "WORKER_CAPACITY" || code === "STORAGE_UNKNOWN" || code === "WORKER_SHUTTING_DOWN"
    ? "queue"
    : "fail";
}
