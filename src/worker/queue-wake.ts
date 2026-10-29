/** Coalesce notifications without overlapping asynchronous queue scans. */
export function createQueueWake(
  scan: () => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  let running = false;
  let requested = false;
  let stopped = false;

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (requested && !stopped) {
        requested = false;
        try { await scan(); } catch (error) { onError(error); }
      }
    } finally {
      running = false;
    }
  }

  return {
    wake() {
      if (stopped) return;
      requested = true;
      void drain();
    },
    stop() {
      stopped = true;
      requested = false;
    },
  };
}
