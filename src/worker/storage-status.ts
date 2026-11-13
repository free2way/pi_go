import { statfs } from "node:fs/promises";

export type StorageStatus = {
  state: "ok" | "low" | "critical" | "unknown";
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
  path: string;
};

type StatFsResult = Awaited<ReturnType<typeof statfs>>;

export async function readStorageStatus(input: {
  path: string;
  minFreeMb: number;
  criticalFreeMb: number;
  inspect?: (path: string) => Promise<StatFsResult>;
  onError?: (error: unknown) => void;
}): Promise<StorageStatus> {
  try {
    const stats = await (input.inspect ?? statfs)(input.path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeMb = freeBytes / 1024 / 1024;
    const state = freeMb <= input.criticalFreeMb ? "critical" : freeMb <= input.minFreeMb ? "low" : "ok";
    return {
      state,
      freeBytes,
      totalBytes,
      freePercent: totalBytes ? Number(((freeBytes / totalBytes) * 100).toFixed(2)) : 0,
      path: input.path,
    };
  } catch (error) {
    input.onError?.(error);
    return { state: "unknown", freeBytes: -1, totalBytes: -1, freePercent: -1, path: input.path };
  }
}
