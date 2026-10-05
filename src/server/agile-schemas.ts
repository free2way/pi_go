import { z } from "zod";

/**
 * Zod contracts for the agile routes. Kept in their own module (rather than
 * inline in `index.ts`) so validation can be unit-tested without booting the
 * Fastify app, following the same split as the other route helpers.
 *
 * Enums are written as literal tuples (rather than spreading the shared label
 * maps) so zod keeps the narrow literal types the service expects.
 */

const name = z.string().trim().min(1).max(120);
const text = z.string().trim().max(4_000);
const textList = z.array(z.string().trim().min(1).max(500)).max(30);
const model = z.object({ provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120) });
const budget = z.object({
  maxTokens: z.number().int().min(0).max(1_000_000_000),
  maxCostUsd: z.number().min(0).max(1_000_000),
  maxModelCalls: z.number().int().min(0).max(1_000_000),
  maxDurationSeconds: z.number().int().min(0).max(1_000_000),
}).strict();
const estimate = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]);
const id = z.string().trim().min(1).max(80).nullable();
const priority = z.enum(["must", "should", "could", "wont"]);
const storyStatus = z.enum(["backlog", "ready", "in_progress", "in_review", "awaiting_acceptance", "done", "blocked"]);
const sprintStatus = z.enum(["planned", "active", "closed"]);
const releaseStatus = z.enum(["planned", "in_progress", "released", "cancelled"]);

export const projectCreateSchema = z.object({
  name,
  // A short uppercase prefix (AUTH, PAY, CORE2 …) used to reference stories.
  key: z.string().trim().min(2).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/, "key 只能包含字母和数字，且以字母开头"),
  description: text.optional(),
}).strict();

export const projectPatchSchema = z.object({
  name: name.optional(),
  description: text.optional(),
}).strict();

export const storyCreateSchema = z.object({
  projectId: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(200),
  description: text.optional(),
  acceptanceCriteria: textList.optional(),
  priority: priority.optional(),
  estimate: estimate.nullable().optional(),
  definitionOfDone: textList.optional(),
  developerModel: model.nullable().optional(),
  reviewerModel: model.nullable().optional(),
  budget: budget.nullable().optional(),
  maxParallel: z.number().int().min(1).max(32).nullable().optional(),
  sprintId: id.optional(),
  workspaceId: id.optional(),
  status: storyStatus.optional(),
}).strict();

export const storyPatchSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: text.optional(),
  acceptanceCriteria: textList.optional(),
  priority: priority.optional(),
  estimate: estimate.nullable().optional(),
  definitionOfDone: textList.optional(),
  developerModel: model.nullable().optional(),
  reviewerModel: model.nullable().optional(),
  budget: budget.nullable().optional(),
  maxParallel: z.number().int().min(1).max(32).nullable().optional(),
  sprintId: id.optional(),
  workspaceId: id.optional(),
  status: storyStatus.optional(),
}).strict();

export const sprintCreateSchema = z.object({
  projectId: z.string().trim().min(1).max(80),
  name,
  goal: text.optional(),
  startDate: z.string().trim().max(40).nullable().optional(),
  endDate: z.string().trim().max(40).nullable().optional(),
  status: sprintStatus.optional(),
}).strict();

export const sprintPatchSchema = z.object({
  name: name.optional(),
  goal: text.optional(),
  startDate: z.string().trim().max(40).nullable().optional(),
  endDate: z.string().trim().max(40).nullable().optional(),
  status: sprintStatus.optional(),
}).strict();

export const releaseCreateSchema = z.object({
  projectId: z.string().trim().min(1).max(80),
  name,
  version: z.string().trim().min(1).max(80),
  notes: text.optional(),
  status: releaseStatus.optional(),
  storyIds: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
}).strict();

export const releasePatchSchema = z.object({
  name: name.optional(),
  version: z.string().trim().min(1).max(80).optional(),
  notes: text.optional(),
  status: releaseStatus.optional(),
  storyIds: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
}).strict();

export const storySubmitSchema = z.object({
  mode: z.enum(["demo", "real"]).default("real"),
  workspaceId: z.string().trim().min(1).max(80).optional(),
  checks: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
}).strict();

/** Kanban manual block: a required, human reason. */
export const storyBlockSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

/** Release publish action. `confirm` gates the mutation; without it the route
 * returns a dry-run preview (guards + blocked stories) so the UI can render the
 * confirmation dialog before committing. */
export const releasePublishSchema = z.object({
  confirm: z.boolean().optional(),
  note: text.optional(),
}).strict();

/** Sprint 4: saved model combination. `budget`/`maxParallel` are optional. */
export const templateCreateSchema = z.object({
  name,
  developerModel: model,
  reviewerModel: model,
  budget: budget.nullable().optional(),
  maxParallel: z.number().int().min(1).max(32).nullable().optional(),
}).strict();
