import { z } from "zod";
import type { RunBudget } from "../../shared/agile.js";
import type { Run } from "../../shared/types.js";

export const createRunSchema = z.object({
  title: z.string().trim().min(2).max(80),
  task: z.string().trim().min(10).max(10_000),
  repository: z.string().trim().max(240).default("demo/auth-service"),
  workspaceId: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["demo", "real"]).default("demo"),
  checks: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  acceptanceCriteria: z.string().trim().max(4_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  developerModel: z.object({ provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120) }).optional(),
  reviewerModel: z.object({ provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120) }).optional(),
}).superRefine((value, context) => {
  if (value.mode === "real" && value.checks.length === 0) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Real runs require at least one check command" });
  }
  if (value.mode === "real" && !value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "Real runs require a registered workspace" });
  }
});

/**
 * Extra (non-client) run inputs used when a story is submitted as a run.
 * Additive: `POST /api/runs` passes none of these, so its behaviour is
 * unchanged.
 */
export type RealRunExtra = { budget?: RunBudget; maxParallel?: number; storyId?: string };

export type RealRunResult =
  | { ok: true; created: boolean; run: Run }
  | { ok: false; status: number; body: Record<string, unknown>; run?: Run };
