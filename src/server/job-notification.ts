/** Keep rolling upgrades compatible; only an absent route permits legacy push. */
export async function notifyQueuedJob(input: {
  wake: () => Promise<unknown>;
  legacyPush: () => Promise<unknown>;
}): Promise<"queue" | "legacy"> {
  try {
    await input.wake();
    return "queue";
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status !== 404 && status !== 405) throw error;
    await input.legacyPush();
    return "legacy";
  }
}
