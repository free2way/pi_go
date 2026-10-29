import { expect, it, vi } from "vitest";
import { createQueueWake } from "./queue-wake.js";

it("coalesces arrivals during an asynchronous scan into one subsequent scan", async () => {
  let release!: () => void;
  let active = 0, peak = 0;
  const scan = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    if (scan.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    active -= 1;
  });
  const wake = createQueueWake(scan, () => undefined);
  wake.wake();
  for (let i = 0; i < 30; i++) wake.wake();
  expect(scan).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  expect(peak).toBe(1);
  wake.wake();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(3));
});

it("a failed scan is reported and a later notification can recover", async () => {
  const failed = new Error("fixture queue unavailable");
  const scan = vi.fn().mockRejectedValueOnce(failed).mockResolvedValue(undefined);
  const onError = vi.fn();
  const wake = createQueueWake(scan, onError);
  wake.wake();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failed));
  wake.wake();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
});

it("shutdown drops coalesced work and ignores future wake notifications", async () => {
  let release!: () => void;
  const scan = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const wake = createQueueWake(scan, () => undefined);
  wake.wake(); wake.wake(); wake.stop(); release();
  await Promise.resolve();
  wake.wake();
  expect(scan).toHaveBeenCalledTimes(1);
});
