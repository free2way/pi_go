import { randomUUID } from "node:crypto";
import type { CreateRunInput, Run } from "../shared/types.js";

export function baseRealRun(input: CreateRunInput, ownerId: string): Run {
  const now = new Date().toISOString();
  const id = `run_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return {
    id,
    ownerId,
    title: input.title,
    task: input.task,
    repository: input.repository,
    workspaceId: input.workspaceId,
    branch: `pigo/${id.replace("run_", "")}`,
    mode: "real",
    state: "queued",
    round: 1,
    maxRounds: Number(process.env.PI_MAX_REVIEW_ROUNDS || 3),
    createdAt: now,
    updatedAt: now,
    developer: input.developerModel ?? {
      provider: process.env.PI_DEVELOPER_PROVIDER || "deepseek",
      model: process.env.PI_DEVELOPER_MODEL || "deepseek-flash",
    },
    reviewer: input.reviewerModel ?? {
      provider: process.env.PI_REVIEWER_PROVIDER || "openai-proxy",
      model: process.env.PI_REVIEWER_MODEL || "gpt-5.6-sol",
    },
    checks: (input.checks || []).map((command, index) => ({
      id: `check-${index + 1}`,
      name: `Check ${index + 1}`,
      command,
      status: "pending",
    })),
    findings: [],
    diff: "",
    summary: "等待真实 Pi Worker 接收任务",
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    durationMs: 0,
    lastSeq: 0,
    // GAP-01: reproducible inputs travel with the run.
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
  };
}
