import { expect, it, vi } from "vitest";
import { notifyQueuedJob } from "./job-notification.js";

it("an acknowledged notification never pushes a newer job ahead of the queue", async () => {
  const legacyPush = vi.fn();
  expect(await notifyQueuedJob({ wake: async () => ({ accepted: true }), legacyPush })).toBe("queue");
  expect(legacyPush).not.toHaveBeenCalled();
});

it.each([404, 405])("supports an older Worker without the notification route (%s)", async status => {
  const legacyPush = vi.fn().mockResolvedValue(undefined);
  expect(await notifyQueuedJob({ wake: async () => { throw { status }; }, legacyPush })).toBe("legacy");
  expect(legacyPush).toHaveBeenCalledOnce();
});

it.each([401, 403, 429, 500, 503, 507, undefined])("does not bypass an admission or transport failure (%s)", async status => {
  const failure = Object.assign(new Error("fixture refusal"), { status });
  const legacyPush = vi.fn();
  await expect(notifyQueuedJob({ wake: async () => { throw failure; }, legacyPush })).rejects.toBe(failure);
  expect(legacyPush).not.toHaveBeenCalled();
});

it("preserves a legacy dispatch failure for the existing durable-job error path", async () => {
  const failure = new Error("fixture capacity reached");
  await expect(notifyQueuedJob({ wake: async () => { throw { status: 404 }; }, legacyPush: async () => { throw failure; } })).rejects.toBe(failure);
});
