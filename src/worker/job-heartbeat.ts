export type JobHeartbeat = {
  stop: () => void;
  leaseLost: () => boolean;
};

export function createJobHeartbeat(input: {
  intervalMs: number;
  staleMs: number;
  heartbeat: () => Promise<unknown>;
  onLeaseLost: (error: unknown) => void;
  onWarning?: (error: unknown, failures: number, limit: number) => void;
}): JobHeartbeat {
  const failureLimit = Math.max(1, Math.ceil(input.staleMs / input.intervalMs) - 1);
  let lost = false;
  let failures = 0;
  const lose = (error: unknown) => {
    if (lost) return;
    lost = true;
    input.onLeaseLost(error);
  };
  const beat = async () => {
    try {
      await input.heartbeat();
      failures = 0;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const status = (error as { status?: unknown }).status;
      if (code === "JOB_LEASE_LOST" || status === 409) return lose(error);
      failures += 1;
      if (failures >= failureLimit) return lose(error);
      input.onWarning?.(error, failures, failureLimit);
    }
  };
  const timer = setInterval(() => { void beat(); }, input.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), leaseLost: () => lost };
}
