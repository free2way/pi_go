import { z } from "zod";

export const runStateSchema = z.enum(["queued", "preparing", "developing", "checking", "reviewing", "completed", "needs_human", "failed", "cancelled"]);

const findingSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().max(400).nullable(),
  line: z.number().int().min(0).nullable(),
  title: z.string().min(1).max(300),
  evidence: z.string().max(8_000),
  requiredChange: z.string().max(8_000),
  resolved: z.boolean(),
  // Stable content identity (`<normalized file>|<normalized title>`); see
  // src/shared/finding-fingerprint.ts. Longer than the legacy hash, hence 800.
  fingerprint: z.string().max(800).optional(),
  firstSeenRound: z.number().int().min(1).max(99).optional(),
  lastSeenRound: z.number().int().min(1).max(99).optional(),
  observations: z.number().int().min(0).max(10_000).optional(),
  consecutiveRounds: z.number().int().min(0).max(10_000).optional(),
});
const checkResultSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  command: z.string().min(1).max(1_000),
  status: z.enum(["pending", "running", "passed", "failed"]),
  durationMs: z.number().min(0).optional(),
  exitCode: z.number().int().min(-1_000).max(1_000).optional(),
  output: z.string().max(64_000).optional(),
});
const subAgentTaskSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(8_000),
  files: z.array(z.string().max(400)).max(40),
  dependsOn: z.array(z.string().max(64)).max(20),
  status: z.enum(["planned", "running", "completed", "merged", "failed"]),
  branch: z.string().max(300).optional(),
  // Item-3: stable sub-agent codename (additive; title remains authoritative).
  name: z.string().min(1).max(60).optional(),
  summary: z.string().max(4_000).optional(),
  durationMs: z.number().min(0).optional(),
});
const developmentPlanSchema = z.object({
  complexity: z.enum(["small", "medium", "large"]),
  rationale: z.string().max(4_000),
  strategy: z.enum(["single", "parallel"]),
  tasks: z.array(subAgentTaskSchema).max(8),
});
const runRoleUsageSchema = z.object({
  role: z.string().min(1).max(40),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0).optional(),
  cacheWriteTokens: z.number().min(0).optional(),
  estimatedCost: z.number().min(0),
  calls: z.number().int().min(0),
  // AT-JEV-062: calls with no price table (decision plane) are counted here, so
  // a reader can render "unknown" instead of $0.000. Additive/optional.
  unpricedCalls: z.number().int().min(0).max(10_000).optional(),
});
const runUsageSchema = z.object({
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  estimatedCost: z.number().min(0),
  cacheReadTokens: z.number().min(0).optional(),
  cacheWriteTokens: z.number().min(0).optional(),
  totalTokens: z.number().min(0).optional(),
});
const runSessionSummarySchema = z.object({
  sessionId: z.string().min(1).max(300),
  role: z.string().min(1).max(40),
  rounds: z.array(z.number().int().min(1).max(99)).max(99),
  calls: z.number().int().min(0),
  resumed: z.boolean(),
  durationMs: z.number().min(0),
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0),
  cacheWriteTokens: z.number().min(0),
  modelCalls: z.number().int().min(0),
  firstAt: z.string().max(80),
  lastAt: z.string().max(80),
});
const runPatchSchema = z.object({
  state: runStateSchema,
  round: z.number().int().min(1).max(99),
  summary: z.string().max(8_000),
  // AUD-16: the worker reports the full run diff (bounded at 3.4M chars); the
  // JSON body limit is 4 MiB, so the schema must allow the same magnitude.
  diff: z.string().max(3_500_000),
  findings: z.array(findingSchema).max(100),
  checks: z.array(checkResultSchema).max(16),
  plan: developmentPlanSchema,
  usage: runUsageSchema,
  usageRoles: z.array(runRoleUsageSchema).max(20),
  // Sprint 2: additive per-session reuse/latency summary.
  sessions: z.array(runSessionSummarySchema).max(40),
  modelCalls: z.number().int().min(0).max(10_000),
  usageUnknownCalls: z.number().int().min(0).max(10_000),
  checkSnapshot: z.string().max(80),
  reviewSnapshot: z.string().max(80),
  checkPassed: z.boolean(),
  baseSha: z.string().max(80),
  durationMs: z.number().min(0).max(86_400_000),
  worktree: z.string().max(600),
}).partial().strict();
const internalEventSchema = z.object({
  round: z.number().int().min(1).max(99),
  source: z.enum(["system", "developer", "checks", "reviewer"]),
  type: z.string().min(1).max(120),
  message: z.string().min(1).max(8_000),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export const internalUpdateSchema = z.object({
  patch: runPatchSchema.optional(),
  event: internalEventSchema.optional(),
  /** Optional at-least-once delivery key so a retried callback is not double counted (AT-REL-004). */
  deliveryId: z.string().min(1).max(160).optional(),
  /** Lease identity; optional only for one rolling-upgrade compatibility window. */
  jobId: z.string().min(1).max(160).optional(),
  workerId: z.string().min(1).max(120).optional(),
}).strict();
// NEW-07: the worker uploads a full diff body through this route when the inline
// callback cannot carry it. The route raises the body limit for itself only.
export const internalArtifactSchema = z.object({
  artifactId: z.string().min(1).max(160),
  kind: z.string().min(1).max(40).default("patch"),
  content: z.string().min(1).max(9_000_000),
  baseSha: z.string().max(80).optional(),
  ownerId: z.string().max(120).optional(),
}).strict();
export const INTERNAL_ARTIFACT_BODY_LIMIT = 8 * 1024 * 1024;
