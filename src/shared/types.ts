export type RunState =
  | "queued"
  | "preparing"
  | "developing"
  | "checking"
  | "reviewing"
  | "completed"
  | "needs_human"
  | "failed"
  | "cancelled";

export type RunMode = "demo" | "real";

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  requiredChange: string;
  resolved: boolean;
  /** AUD-11: stable identity across rounds (id-independent fingerprint). */
  fingerprint?: string;
  /** AUD-11: first round this problem was reported in. */
  firstSeenRound?: number;
  /** AUD-11: most recent round this problem was reported in. */
  lastSeenRound?: number;
  /** AUD-11: how many reviews reported this problem. */
  observations?: number;
  /** GAP-03: consecutive reviews that reported this problem unresolved. */
  consecutiveRounds?: number;
}

export interface CheckResult {
  id: string;
  name: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed";
  durationMs?: number;
  /** GAP-04: process exit code for the check command (AT-REVIEW-002). */
  exitCode?: number;
  output?: string;
}

export interface RunEvent {
  seq: number;
  runId: string;
  round: number;
  source: "system" | "developer" | "checks" | "reviewer";
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
}

export type WorkloadSize = "small" | "medium" | "large";

export interface SubAgentTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependsOn: string[];
  status: "planned" | "running" | "completed" | "merged" | "failed";
  branch?: string;
  summary?: string;
  durationMs?: number;
}

export interface DevelopmentPlan {
  complexity: WorkloadSize;
  rationale: string;
  strategy: "single" | "parallel";
  tasks: SubAgentTask[];
}

export interface Run {
  id: string;
  ownerId: string;
  title: string;
  task: string;
  repository: string;
  workspaceId?: string;
  branch: string;
  mode: RunMode;
  state: RunState;
  round: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  developer: { provider: string; model: string };
  reviewer: { provider: string; model: string };
  checks: CheckResult[];
  findings: Finding[];
  diff: string;
  summary: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  durationMs: number;
  lastSeq: number;
  worktree?: string;
  plan?: DevelopmentPlan;
  /** COST-001: per-role (planner/developer/sub-agent/integrator/reviewer) usage. */
  usageRoles?: RunRoleUsage[];
  /** COST-002: number of model calls started for this run. */
  modelCalls?: number;
  /** AUD-04: content snapshot hash that passed the required checks. */
  checkSnapshot?: string;
  /** AUD-04: content snapshot hash the latest review verdict applies to. */
  reviewSnapshot?: string;
  /** AUD-04: whether the checks for `checkSnapshot` passed. */
  checkPassed?: boolean;
  /** GAP-01: idempotency key supplied at creation time. */
  idempotencyKey?: string;
  /** GAP-01: pinned base commit for reproducible diffs (AT-GIT-001). */
  baseSha?: string;
  /** GAP-01: acceptance criteria captured with the task. */
  acceptanceCriteria?: string;
  /** GAP-01/COST-002: hard budget fixed at creation and shown in the UI. */
  budget?: {
    maxTokens: number;
    maxCostUsd: number;
    maxModelCalls: number;
    maxDurationSeconds: number;
  };
  /** GAP-01: credential fingerprint (sha256 prefix) per role at creation time. */
  credentialVersions?: { developer?: string; reviewer?: string };
  /** GAP-01: workflow/prompt/plugin policy snapshot used for this run. */
  pipelineVersion?: string;
  /** AUD-10: calls whose provider usage could not be determined. */
  usageUnknownCalls?: number;
  /** GAP-04: human approval of the delivered worktree. */
  approvedAt?: string;
  approvedBy?: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface RunRoleUsage {
  role: "planner" | "developer" | "sub-agent" | "integrator" | "reviewer" | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost: number;
  calls: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  relativePath: string;
  branch: string;
  dirty: boolean;
}

export interface CreateRunInput {
  title: string;
  task: string;
  repository: string;
  workspaceId?: string;
  mode: RunMode;
  checks?: string[];
  developerModel?: ModelSelection;
  reviewerModel?: ModelSelection;
  /** GAP-01: idempotent creation key; the same key returns the existing run. */
  idempotencyKey?: string;
  /** GAP-01: acceptance criteria captured with the task. */
  acceptanceCriteria?: string;
}

export interface ConfigStatus {
  demoMode: boolean;
  piVersion: string;
  developer: { provider: string; model: string; credentialConfigured: boolean };
  reviewer: { provider: string; model: string; credentialConfigured: boolean };
  /**
   * AUD-09 / AT-MODEL-006/007: execution availability is decoupled from the
   * default provider/credential combination. It is true as long as real runs are
   * enabled and the user has at least one provider credential; the actual
   * per-role model combination is preflighted when a run is created.
   */
  realRunsAvailable: boolean;
  /** Providers the current user has a configured credential for. */
  configuredProviders?: string[];
  /** Configured providers whose key was live-verified (AUD-08 / AT-MODEL-004). */
  verifiedProviders?: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
  legacyOwnerId?: string;
}

export interface CredentialStatus {
  developerConfigured: boolean;
  reviewerConfigured: boolean;
  updatedAt: string | null;
  providers: Array<{
    provider: string;
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
    /** AUD-08 / AT-MODEL-004: last successful live probe, null when unverified. */
    verifiedAt?: string | null;
    /** AUD-08 / AT-MODEL-001: provider-reported model ids captured by the probe. */
    verifiedModels?: string[] | null;
  }>;
}

/**
 * AUD-08 / AT-MODEL-004: what we actually know about a provider credential.
 * `configured` only means a key is stored; `verifiedAt`/`verifiedModels` come
 * from a live provider preflight. A length-valid key on its own is never enough
 * to call a model available.
 */
export interface ProviderAvailability {
  provider: string;
  configured: boolean;
  verifiedAt: string | null;
  verifiedModels: string[] | null;
  /** Convenience flag; when omitted it is derived from `verifiedAt !== null`. */
  verified?: boolean;
}

export type ModelRole = "developer" | "reviewer";

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  label: string;
  contextWindow?: number;
  toolCalling: boolean;
  reasoning: boolean;
  roles: ModelRole[];
  status: "available" | "preview" | "deprecated";
}

export interface ModelInfo extends ModelCatalogEntry {
  available: boolean;
  unavailableReason: "credential_missing" | "credential_unverified" | "model_unverified" | "role_restricted" | null;
  /** AUD-08 / AT-MODEL-001: model is backed by a verified runtime probe. */
  verified?: boolean;
  /** AUD-08 / AT-MODEL-004: when the backing provider key was last verified. */
  verifiedAt?: string | null;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelCatalogResponse {
  models: ModelInfo[];
  defaultDeveloper: ModelSelection;
  defaultReviewer: ModelSelection;
  /**
   * AUD-08 / AT-MODEL-001: provider-level runtime verification, so the UI can
   * surface the concrete verifiedModels captured from the Pi/provider probe.
   */
  verifiedProviders?: Array<{ provider: string; verifiedAt: string | null; verifiedModels: string[] | null }>;
}

export type WorkspaceStatus = "active" | "unregistered" | "invalid";

/** GAP-04 / AUD-16: a downloadable run artifact (metadata only in listings). */
export interface RunArtifact {
  runId: string;
  artifactId: string;
  kind: string;
  bytes: number;
  sha256: string | null;
  /** GAP-01: pinned base commit the patch was produced against. */
  baseSha: string | null;
  createdAt: string;
}

export interface WorkspaceGitInfo {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

export interface Workspace {
  id: string;
  ownerId: string;
  nodeId: string;
  name: string;
  type: "server";
  rootPath: string;
  canonicalPath: string;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  defaultChecks: string[];
  status: WorkspaceStatus;
  git: WorkspaceGitInfo | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceVerifyResult {
  ok: boolean;
  code?: string;
  error?: string;
  relativePath?: string;
  canonicalPath?: string;
  name?: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  dirtyFiles?: string[];
}
