import { describe, expect, it, vi } from "vitest";
import { readStorageStatus } from "./storage-status.js";

describe("readStorageStatus", () => {
  it("fails closed when statfs cannot inspect the workspace", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("statfs unavailable"));
    await expect(readStorageStatus({ path: "/workspace", minFreeMb: 2048, criticalFreeMb: 512, inspect }))
      .resolves.toEqual({ state: "unknown", freeBytes: -1, totalBytes: -1, freePercent: -1, path: "/workspace" });
  });

  it("classifies known headroom", async () => {
    const inspect = vi.fn().mockResolvedValue({ bavail: 256, bsize: 1024 * 1024, blocks: 4096 });
    expect((await readStorageStatus({ path: "/workspace", minFreeMb: 2048, criticalFreeMb: 512, inspect })).state).toBe("critical");
  });
});
